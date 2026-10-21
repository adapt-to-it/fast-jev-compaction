import type { SessionCompactTrigger, SessionMessage } from 'claude-code';

import { collectToolCalls, latestRequest as requestOf } from '../src/state.js';
import type { TouchedFiles } from '../src/plan.js';
import type { CompactResult } from '../src/types.js';

/** Characters of a call input kept in the log. */
const INPUT_CHARS = 400;
/** Characters of the latest user request kept in the log. */
const REQUEST_CHARS = 1000;

export type CompactionOutcome = 'summarized' | 'applied' | 'fallback' | 'precomputed' | 'reused' | 'error';

export type CompactionLog = {
  at: string;
  sessionId: string;
  trigger: SessionCompactTrigger;
  outcome: CompactionOutcome;
  note?: string;
  messagesBefore: number;
  messagesAfter?: number;
  latestRequest: string;
  stats?: CompactResult['stats'];
  turns?: CompactResult['turns'];
  /** Summary path: the prompt the messages were checked against, the cut and the files told to the summarizer. */
  reference?: string;
  cut?: number;
  obsoleteShare?: number;
  /** Characters the built-in summarizer read, after the results were shortened. */
  summarizedChars?: number;
  /** Who wrote the summary: a model alias, or `built-in`. */
  summaryModel?: string;
  summaryMs?: number;
  files?: TouchedFiles;
  decisions: Array<{
    id: string;
    tool: string;
    input: string;
    action: string;
    reason: string;
    keepCall: number;
    keepResult: number;
    keepChange?: number;
  }>;
};

/** The latest user request, at most `REQUEST_CHARS` long. */
export function latestRequest(messages: readonly SessionMessage[]): string {
  return requestOf(messages, REQUEST_CHARS);
}

/** One compaction as a self-contained record, every decision tied to its call input. */
export function compactionLog(
  input: {
    sessionId: string;
    trigger: SessionCompactTrigger;
    outcome: CompactionOutcome;
    note?: string;
    messages: readonly SessionMessage[];
    preserveRecentMessages: number;
  },
  result?: CompactResult,
  messagesAfter?: number,
): CompactionLog {
  const calls = new Map(
    collectToolCalls(input.messages, input.preserveRecentMessages).map((c) => [c.id, c]),
  );
  const log: CompactionLog = {
    at: new Date().toISOString(),
    sessionId: input.sessionId,
    trigger: input.trigger,
    outcome: input.outcome,
    messagesBefore: input.messages.length,
    latestRequest: latestRequest(input.messages),
    decisions: (result?.decisions ?? []).map((d) => {
      const entry: CompactionLog['decisions'][number] = {
        id: d.id,
        tool: d.tool,
        input: JSON.stringify(calls.get(d.id)?.input ?? {}).slice(0, INPUT_CHARS),
        action: d.action,
        reason: d.reason,
        keepCall: d.keepCall,
        keepResult: d.keepResult,
      };
      if (d.keepChange !== undefined) entry.keepChange = d.keepChange;
      return entry;
    }),
  };
  if (input.note) log.note = input.note;
  if (messagesAfter !== undefined) log.messagesAfter = messagesAfter;
  if (result) log.stats = result.stats;
  if (result && result.turns.length > 0) log.turns = result.turns;
  return log;
}

/** `<dir>/<sessionId>/<timestamp>-<trigger>.json`, safe as a file name. */
export function logPath(dir: string, log: CompactionLog): string {
  const stamp = log.at.replace(/[:.]/g, '-');
  return `${dir.replace(/\/$/, '')}/${log.sessionId}/${stamp}-${log.trigger}.json`;
}
