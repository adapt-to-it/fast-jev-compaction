import { isLocalCommandEcho } from './compact.js';
import { isPinned, latestRequest } from './state.js';
import type { JevAnswer, JevQuestions, Message, Turn, TurnDecision } from './types.js';

export const TOPIC_START_INSTRUCTIONS =
  '`goal` holds the latest user requests and `history` the conversation, each entry tagged with its `turn`. Which turn starts the line of work the latest requests are still continuing: the earliest turn whose request, decisions or results the current work still builds on? Pick the latest turn when the latest request starts a new topic.';

/** `{id}` stands for the turn id. */
export const LASTING_QUESTION = {
  instructions:
    'Turn {id} (the `history` entries whose `turn` is "{id}") sets something that still holds and could matter to the latest requests in `goal`',
  true: 'In {id} the user or assistant set a constraint, preference, decision, convention or a fact about the project or environment that still applies, such as files not to touch, a chosen approach, a path or a naming rule',
  false: '{id} only holds a one-off question, explanation, exploration or task whose details the current work does not rely on',
} as const;

export const MAX_CHOICE_OPTIONS = 255;
export const REQUEST_CHARS = 200;

/** A message that opens a turn: a user prompt with text of its own, not a tool result or a command echo. */
function isRequest(message: Message): boolean {
  return (
    message.role === 'user' &&
    (message.toolResults ?? []).length === 0 &&
    !isLocalCommandEcho(message) &&
    latestRequest([message]) !== ''
  );
}

/** `{id}` replaced everywhere in a question text. */
function fill(text: string, id: string): string {
  return text.split('{id}').join(id);
}

/** Splits the conversation into turns, each starting at a user request. */
export function segmentTurns(messages: readonly Message[], preserveRecentMessages: number): Turn[] {
  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (isRequest(message)) starts.push(index);
  });
  const total = messages.length;
  return starts.map((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1]! : total;
    let pinned = false;
    for (let i = start; i < end; i++) {
      if (isPinned(i, total, preserveRecentMessages)) {
        pinned = true;
        break;
      }
    }
    return {
      id: `T${String(n + 1).padStart(2, '0')}`,
      start,
      end,
      request: latestRequest([messages[start]!], REQUEST_CHARS),
      candidate: !pinned && n < starts.length - 1,
    };
  });
}

/** The Choice `topic_start` over every turn and one Noul `lasting_<id>` per candidate turn. */
export function turnQuestions(turns: readonly Turn[]): JevQuestions {
  const candidates = turns.filter((turn) => turn.candidate);
  if (turns.length < 2 || candidates.length === 0 || turns.length > MAX_CHOICE_OPTIONS) return {};
  const criteria: Record<string, string> = {};
  for (const turn of turns) criteria[turn.id] = turn.request;
  const questions: JevQuestions = {
    topic_start: { type: 'choice', instructions: TOPIC_START_INSTRUCTIONS, criteria },
  };
  for (const turn of candidates) {
    questions[`lasting_${turn.id}`] = {
      type: 'noul',
      instructions: fill(LASTING_QUESTION.instructions, turn.id),
      criteria: {
        true: fill(LASTING_QUESTION.true, turn.id),
        false: fill(LASTING_QUESTION.false, turn.id),
      },
    };
  }
  return questions;
}

/** Turns the answers into one decision per turn. */
export function decideTurns(
  turns: readonly Turn[],
  answers: Record<string, JevAnswer>,
  thresholds: { topicThreshold: number; lastingThreshold: number },
): TurnDecision[] {
  const topic = answers.topic_start;
  const probabilities = topic && 'probabilities' in topic ? topic.probabilities : undefined;
  return turns.map((turn, index) => {
    const decision: TurnDecision = {
      id: turn.id,
      start: turn.start,
      end: turn.end,
      request: turn.request,
      after: 0,
      dropped: false,
    };
    if (turn.candidate) {
      const answer = answers[`lasting_${turn.id}`];
      if (answer && 'noul' in answer) decision.lasting = answer.noul;
    }
    if (!probabilities) return decision;
    let after = 0;
    for (const later of turns.slice(index + 1)) after += probabilities[later.id] ?? 0;
    decision.after = after;
    decision.dropped =
      turn.candidate &&
      after >= thresholds.topicThreshold &&
      decision.lasting !== undefined &&
      decision.lasting < thresholds.lastingThreshold;
    return decision;
  });
}

/** Removes the dropped turns, leaving one placeholder message per run of adjacent dropped turns. */
export function dropTurns(messages: readonly Message[], decisions: readonly TurnDecision[]): Message[] {
  const gone = new Array<boolean>(messages.length).fill(false);
  const runs = new Map<number, TurnDecision[]>();
  let open: TurnDecision[] | undefined;
  for (const decision of decisions) {
    if (!decision.dropped) {
      open = undefined;
      continue;
    }
    for (let i = decision.start; i < decision.end; i++) gone[i] = true;
    if (open && open[open.length - 1]!.end === decision.start) {
      open.push(decision);
    } else {
      open = [decision];
      runs.set(decision.start, open);
    }
  }
  const out: Message[] = [];
  messages.forEach((message, index) => {
    const run = runs.get(index);
    if (run) {
      const requests = run.map((decision) => `"${decision.request}"`).join('; ');
      out.push({
        role: 'user',
        text: `[fast-jev-compaction removed ${run.length} earlier turn(s) whose topic the current work no longer needs. Their requests: ${requests}]`,
        toolUses: [],
      });
    } else if (!gone[index]) {
      out.push(message);
    }
  });
  return out;
}
