import { isLocalCommandEcho } from './compact.js';
import { isPinned, latestRequest, REMOVED_TURNS_PREFIX } from './state.js';
import type { JevAnswer, JevQuestions, Message, Turn, TurnDecision } from './types.js';

export const TOPIC_START_INSTRUCTIONS =
  '`goal` holds the latest user requests and `history` the conversation, each entry tagged with its `turn`. Which turn starts the line of work the latest requests are still continuing: the earliest turn whose request, decisions or results the current work still builds on? Pick the latest turn when the latest request starts a new topic.';

/** `{id}` stands for the turn id. */
export const LASTING_QUESTION = {
  instructions:
    'In turn {id} (the `history` entries whose `turn` is "{id}") the user set a rule that the work on the latest requests in `goal` must still follow',
  true: 'In {id} the user stated or approved a constraint, preference or decision that still applies and that reading the files would not reveal, such as files not to touch, a chosen approach or a style rule',
  false: '{id} only holds a task, question, confirmation, explanation or exploration; whatever it found is in the files or can be found again',
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

function removedText(count: number, requests: string): string {
  return `${REMOVED_TURNS_PREFIX}${count} earlier turn(s) whose topic the current work no longer needs. Their requests: ${requests}]`;
}

function parseRemoved(text: string): { count: number; requests: string } | undefined {
  if (!text.startsWith(REMOVED_TURNS_PREFIX)) return undefined;
  const match = /^\S+ removed (\d+) earlier turn\(s\)[^:]*: ([\s\S]*)\]$/.exec(text);
  return match ? { count: Number(match[1]), requests: match[2]! } : undefined;
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
  // Every placeholder, old or new, merges with one right before it.
  const pushRemoved = (count: number, requests: string): void => {
    const last = out[out.length - 1];
    const previous = last ? parseRemoved(last.text) : undefined;
    if (previous) out.pop();
    out.push({
      role: 'user',
      text: removedText(
        count + (previous?.count ?? 0),
        previous ? `${previous.requests}; ${requests}` : requests,
      ),
      toolUses: [],
    });
  };
  messages.forEach((message, index) => {
    const run = runs.get(index);
    if (run) {
      pushRemoved(run.length, run.map((decision) => `"${decision.request}"`).join('; '));
    }
    // An old placeholder survives the removal of the turn it sits in.
    const removed = parseRemoved(message.text);
    if (removed && message.role === 'user') pushRemoved(removed.count, removed.requests);
    else if (!gone[index] && !run) out.push(message);
  });
  return out;
}
