import { noulAnswer } from './request.js';
import { collectToolCalls, estimateTokens, fitState, isPinned, latestRequest } from './state.js';
import { decideTurns, dropTurns, segmentTurns, turnQuestions } from './turns.js';
import type {
  CallAnswer,
  CallDecision,
  TurnDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

/** Claude Code tools that only read, search or fetch, and never change anything. */
export const DEFAULT_READ_ONLY_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'ToolSearch',
  'AskUserQuestion',
  'ListAgents',
  'ReadNotifications',
  'SendMessage',
  'SendUserFile',
  'Skill',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'BashOutput',
  'CronList',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
];

/** First words of shell commands that only read, list or inspect. */
const READ_ONLY_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'ls', 'pwd', 'echo', 'printf', 'wc', 'grep', 'rg', 'ugrep',
  'find', 'fd', 'which', 'file', 'stat', 'du', 'df', 'diff', 'jq', 'tree', 'date',
  'whoami', 'uname', 'sort', 'uniq', 'cut', 'tr', 'awk', 'sed', 'column', 'basename', 'dirname',
  'realpath', 'readlink', 'type', 'true', 'cd', 'test', '[',
]);

/** `git` subcommands that change nothing. */
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'grep',
  'describe', 'shortlog', 'ls-remote', 'config',
]);

function isReadOnlySegment(segment: string): boolean {
  const words = segment.trim().split(/\s+/);
  const [head = '', sub = ''] = words;
  if (head === '') return true;
  if (head === 'git') return READ_ONLY_GIT.has(sub) && !(sub === 'branch' && words.length > 2);
  if (head === 'sed') return !words.some((w) => w.startsWith('-i'));
  if (head === 'find') return !words.some((w) => w === '-delete' || w.startsWith('-exec') || w.startsWith('-ok'));
  if (head === 'awk') return !segment.includes('system(');
  return READ_ONLY_COMMANDS.has(head);
}

/**
 * Whether a call can be told apart as read-only: a tool in `readOnlyTools`, or
 * a Bash command whose every segment starts with a read-only command and that
 * writes no file. Anything unsure counts as changing.
 */
export function isReadOnlyCall(
  call: Pick<ToolCall, 'tool' | 'input'>,
  readOnlyTools: readonly string[] = DEFAULT_READ_ONLY_TOOLS,
): boolean {
  if (readOnlyTools.includes(call.tool)) return true;
  if (call.tool !== 'Bash') return false;
  const command = call.input['command'];
  if (typeof command !== 'string' || /[<>]|\$\(|`|<<|\btee\b/.test(command.replace(/2>&1|\d?>\s*\/dev\/null/g, ''))) {
    return false;
  }
  return command.split(/&&|\|\||;|\||\n/).every(isReadOnlySegment);
}

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
  pruneTopics: true,
  resultsOnly: false,
  topicThreshold: 0.8,
  lastingThreshold: 0.3,
};

/** Characters of the latest user request quoted in each change question. */
const REQUEST_QUOTE_CHARS = 300;

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    readOnlyTools: options.readOnlyTools ?? DEFAULT_OPTIONS.readOnlyTools,
    pruneTopics: options.pruneTopics ?? DEFAULT_OPTIONS.pruneTopics,
    resultsOnly: options.resultsOnly ?? DEFAULT_OPTIONS.resultsOnly,
    topicThreshold: finite(options.topicThreshold, DEFAULT_OPTIONS.topicThreshold),
    lastingThreshold: finite(options.lastingThreshold, DEFAULT_OPTIONS.lastingThreshold),
  };
}

/**
 * The `noul` questions asked about one call: keep the call, keep its result,
 * and, unless the tool is read-only, whether the current task depends on what
 * the call changed. The change question is separate so each noul judges one
 * condition; re-reading a file shows its current content, not what an edit did.
 * It quotes the latest user request (`request`, already shortened), so Jev
 * weighs the change against what was asked rather than against the history.
 */
export function questionsFor(
  call: ToolCall,
  readOnlyTools: readonly string[] = DEFAULT_READ_ONLY_TOOLS,
  request = '',
): JevQuestions {
  const questions: JevQuestions = {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
  if (!isReadOnlyCall(call, readOnlyTools)) {
    questions[`change_${call.id}`] = {
      type: 'noul',
      instructions: request
        ? `The latest user request (${JSON.stringify(request)}) or the work in progress toward it depends on knowing exactly what tool call ${call.id} (${call.tool}) changed`
        : `The current task depends on knowing exactly what tool call ${call.id} (${call.tool}) changed`,
      criteria: {
        true: 'The call edited, created, deleted, installed or committed something, and the latest user request or the work in progress needs its exact change: to describe or document it (in a changelog, commit message, pull request or reply), review it, build on it or undo it',
        false: 'The call only read, searched or checked something, or what it changed has no bearing on the latest user request',
      },
    };
  }
  return questions;
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'> &
    Partial<Pick<ResolvedCompactOptions, 'readOnlyTools'>> & { request?: string },
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call, options.readOnlyTools, options.request)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (Math.max(answer.keepCall, answer.keepChange ?? 0) >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
  readOnlyTools: readonly string[],
  request: string,
  resultsOnly = false,
): Promise<Map<string, CallAnswer>> {
  const all: JevQuestions = Object.assign(
    {},
    ...batch.map((call) => questionsFor(call, readOnlyTools, request)),
  );
  const questions = resultsOnly
    ? Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith('result_')))
    : all;
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => {
      const answer: CallAnswer = {
        keepCall: resultsOnly ? 1 : noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      };
      if (`change_${call.id}` in questions) {
        answer.keepChange = noulAnswer(answers, `change_${call.id}`);
      }
      return [call.id, answer];
    }),
  );
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

const LOCAL_COMMAND_TAGS =
  /<(local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message)>[\s\S]*?<\/\1>/g;

/**
 * Whether a message only echoes a local slash command (`/reload-plugins`,
 * `/compact`, ...): its caveat, name or output, and no arguments. A command
 * with arguments usually carries a request, so it stays.
 */
export function isLocalCommandEcho(message: Message): boolean {
  if (message.toolUses.length > 0 || (message.toolResults ?? []).length > 0) return false;
  if (!LOCAL_COMMAND_TAGS.test(message.text)) return false;
  LOCAL_COMMAND_TAGS.lastIndex = 0;
  const rest = message.text.replace(LOCAL_COMMAND_TAGS, '').replace(/<command-args>\s*<\/command-args>/g, '');
  return rest.trim().length === 0;
}

/** Jev's per-request and per-question context limits, in estimated tokens. */
const JEV_REQUEST_TOKENS = 60_000;
const JEV_QUESTION_TOKENS = 30_000;

/**
 * The turn questions sized to Jev's limits: the topic Choice drops its option
 * texts when they would not fit beside the state (the history already tags
 * each entry with its turn); undefined when even that is too big.
 */
export function fitTurnQuestions(questions: JevQuestions, stateTokens: number): JevQuestions | undefined {
  const choice = questions.topic_start;
  if (!choice || choice.type !== 'choice') return undefined;
  const sized = { ...questions };
  if (stateTokens + estimateTokens(JSON.stringify(choice)) > JEV_QUESTION_TOKENS - REQUEST_OVERHEAD_TOKENS) {
    sized.topic_start = {
      ...choice,
      criteria: Object.fromEntries(Object.keys(choice.criteria).map((id) => [id, null])),
    };
  }
  const tokens = stateTokens + estimateTokens(JSON.stringify(sized)) + REQUEST_OVERHEAD_TOKENS;
  return tokens <= JEV_REQUEST_TOKENS ? sized : undefined;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. Throws when Jev fails or the
 * history cannot be fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  let turnRequests = 0;
  const answers = new Map<string, CallAnswer>();
  const turns = resolved.pruneTopics && !resolved.resultsOnly ? segmentTurns(messages, resolved.preserveRecentMessages) : [];
  let turnDecisions: TurnDecision[] = [];
  const turnQuestionSet = turnQuestions(turns);
  if (candidates.length > 0 || Object.keys(turnQuestionSet).length > 0) {
    const state = fitState(messages, calls, resolved, turns);
    fitted = state;
    const request = latestRequest(messages, REQUEST_QUOTE_CHARS);
    batches = candidates.length > 0 ? batchCalls(candidates, state.tokens, { ...resolved, request }) : [];
    const topics = fitTurnQuestions(turnQuestionSet, state.tokens);
    turnRequests = topics ? 1 : 0;
    const [answered, topicAnswers] = await Promise.all([
      Promise.all(
        batches.map((batch) =>
          askBatch(asker, state.state, batch, resolved.readOnlyTools, request, resolved.resultsOnly),
        ),
      ),
      // Topics are an extra: a failed request only means no turn is removed.
      topics
        ? asker.ask(state.state, topics).then((r) => r.answers, () => ({}))
        : Promise.resolve({}),
    ]);
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
    turnDecisions = turns.length > 0 ? decideTurns(turns, topicAnswers, resolved) : [];
  }

  const dropped = turnDecisions.filter((turn) => turn.dropped);
  const inDroppedTurn = (index: number): boolean =>
    dropped.some((turn) => index >= turn.start && index < turn.end);
  const decisions = calls.map((call): CallDecision => {
    const decision = decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved);
    return inDroppedTurn(call.callIndex)
      ? { ...decision, action: 'drop_call', reason: 'turn_dropped' }
      : decision;
  });
  // Old local command echoes go too: the engine would copy them, and their
  // outputs, after every compaction.
  const echoes = new Set(
    messages.filter(
      (message, index) =>
        !isPinned(index, messages.length, resolved.preserveRecentMessages) &&
        isLocalCommandEcho(message),
    ),
  );
  const kept = applyDecisions(
    dropTurns(messages, turnDecisions),
    decisions,
    calls,
    resolved.truncateHeadChars,
  ).filter((message) => !echoes.has(message));
  return {
    messages: kept,
    decisions,
    turns: turnDecisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      turnsDropped: dropped.length,
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length + turnRequests,
      ms: Date.now() - started,
    },
  };
}
