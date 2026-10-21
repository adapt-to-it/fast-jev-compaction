import { fitTurnQuestions } from './compact.js';
import { collectToolCalls, fitState } from './state.js';
import { decideTurns, segmentTurns, turnQuestions } from './turns.js';
import type { JevAsker, Message, ResolvedCompactOptions, TurnDecision } from './types.js';

/** Files the summarized messages touched, each listed once, in order of first appearance. */
export interface TouchedFiles {
  written: string[];
  read: string[];
  mentioned: string[];
}

/** Which old part of the conversation is on a finished topic. */
export interface TopicPlan {
  /** `messages[0..cut)` belong to finished topics; 0 when none. */
  cut: number;
  /** Every turn with Jev's `after`; `dropped` marks the obsolete prefix. */
  turns: TurnDecision[];
  stateTokens: number;
  stateStage: string;
}

/** Tools that change the file they name. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Input keys that name a file for any other tool. */
const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;
/** `@"x y"` or `@x` (up to a space) in a user message. */
const MENTION = /@"([^"]+)"|@(\S+)/g;
/** Longest list of files shown per kind in the summary instructions. */
const LIST_LIMIT = 50;

function addPath(paths: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value !== '') paths.add(value);
}

/** Asks Jev where the current line of work starts, against `reference` (the next prompt or the latest requests). */
export async function planTopics(
  messages: readonly Message[],
  asker: JevAsker,
  options: ResolvedCompactOptions,
  reference: string,
): Promise<TopicPlan> {
  const turns = segmentTurns(messages, options.preserveRecentMessages);
  const calls = collectToolCalls(messages, options.preserveRecentMessages);
  const state = fitState(messages, calls, { ...options, goal: reference || options.goal }, turns);
  const topic = turnQuestions(turns).topic_start;
  const questions = topic ? fitTurnQuestions({ topic_start: topic }, state.tokens) : undefined;
  if (!questions) {
    return {
      cut: 0,
      turns: decideTurns(turns, {}, options),
      stateTokens: state.tokens,
      stateStage: state.stage,
    };
  }

  const { answers } = await asker.ask(state.state, questions);
  const decided = decideTurns(turns, answers, options);
  // The obsolete prefix: from the first turn on, while the turn is not the last,
  // ends within the part that is not preserved and Jev says the work moved on.
  // The first message is not protected here.
  let prefix = 0;
  for (let n = 0; n < decided.length - 1; n++) {
    const turn = decided[n]!;
    if (turn.end > messages.length - options.preserveRecentMessages) break;
    if (turn.after < options.topicThreshold) break;
    prefix = n + 1;
  }
  const cut = prefix > 0 ? decided[prefix - 1]!.end : 0;
  return {
    cut,
    turns: decided.map((turn, n) => ({ ...turn, dropped: n < prefix })),
    stateTokens: state.tokens,
    stateStage: state.stage,
  };
}

export function touchedFiles(messages: readonly Message[]): TouchedFiles {
  const written = new Set<string>();
  const read = new Set<string>();
  const mentioned = new Set<string>();
  for (const message of messages) {
    for (const tool of message.toolUses) {
      if (WRITE_TOOLS.has(tool.tool)) {
        addPath(written, tool.input['file_path']);
        addPath(written, tool.input['notebook_path']);
      } else if (tool.tool === 'Read') {
        addPath(read, tool.input['file_path']);
      } else {
        for (const key of PATH_KEYS) addPath(mentioned, tool.input[key]);
      }
    }
    if (message.role === 'user') {
      for (const match of message.text.matchAll(MENTION)) addPath(mentioned, match[1] ?? match[2]);
    }
  }
  // A file sits in the first list it fits: written, then read, then mentioned.
  return {
    written: [...written],
    read: [...read].filter((path) => !written.has(path)),
    mentioned: [...mentioned].filter((path) => !written.has(path) && !read.has(path)),
  };
}

/** What the built-in summarizer is told when it runs over the obsolete prefix only. */
export function summaryInstructions(reference: string, files: TouchedFiles): string {
  const parts = [
    'Summarize only this earlier part of the conversation; the newer part stays verbatim after your summary.',
  ];
  if (reference) parts.push(`The user's next request: "${reference}". Keep what it needs.`);
  parts.push('Keep the goals, constraints, preferences and decisions the user set, and what was done.');
  const lists: [string, string[]][] = [
    ['Files written', files.written],
    ['Files read', files.read],
    ['Files mentioned', files.mentioned],
  ];
  for (const [label, list] of lists) {
    if (list.length === 0) continue;
    const more = list.length > LIST_LIMIT ? `, +${list.length - LIST_LIMIT} more` : '';
    parts.push(`${label}: ${list.slice(0, LIST_LIMIT).join(', ')}${more}.`);
  }
  return parts.join(' ');
}

/**
 * Where the older part of a conversation with no finished topic ends: the
 * first assistant message after `share` of the text, so no tool call is split
 * from its result. 0 when that point falls inside the newest
 * `preserveRecent` messages or no such message exists.
 */
export function olderPartCut(
  messages: readonly Message[],
  share = 0.5,
  preserveRecent = 6,
  charsOf: (message: Message) => number = (m) => m.text.length,
): number {
  const sizes = messages.map(charsOf);
  const total = sizes.reduce((sum, n) => sum + n, 0);
  const limit = messages.length - preserveRecent;
  let seen = 0;
  for (let i = 0; i < limit; i++) {
    if (i > 0 && seen >= total * share && messages[i]!.role === 'assistant' && messages[i - 1]!.role === 'user') {
      return i;
    }
    seen += sizes[i]!;
  }
  return 0;
}
