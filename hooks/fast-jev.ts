import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, messageChars, reductionRatio, resolveOptions } from '../src/compact.js';
import { olderPartCut, planTopics, summaryInstructions, touchedFiles, type TouchedFiles } from '../src/plan.js';
import { latestRequest } from '../src/state.js';
import { compactionLog, logPath, type CompactionLog } from './log.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 0,
  minReductionRatio: 0.25,
  smallContextChars: 100_000,
  summarizeShare: 0.75,
  summaryModel: 'haiku',
  model: DEFAULT_MODEL,
  resumeAfterCompact: true,
  decisionLog: true,
};

const SUMMARY_SYSTEM =
  'You summarize the earlier part of a coding session between a user and an AI assistant, so the assistant can continue the work with only your summary and the newer messages. ' +
  'Write plain text with these sections: Requests (what the user asked, in order, with their exact wording when it sets a rule), ' +
  'Decisions and constraints, Work done (files, commands, results, commits), Errors and fixes, Open points. ' +
  'Keep names, paths, identifiers, numbers and versions exact. Do not invent anything. Do not address the user.';

/** Caps the transcript a summary model reads; the newest characters stay. */
const TRANSCRIPT_LIMIT = 600_000;
/** Caps each tool input and result inside that transcript. */
const PART_LIMIT = 4_000;

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)} […${text.length - limit} chars cut]`;

/** The messages as plain text for a summary model: texts, tool calls and their results. */
export function renderTranscript(messages: readonly SessionMessage[], limit = TRANSCRIPT_LIMIT): string {
  const lines: string[] = [];
  messages.forEach((message, i) => {
    const parts = [`[${i}] ${message.role.toUpperCase()}:`];
    if (message.text) parts.push(message.text);
    for (const use of message.toolUses) {
      let input: string;
      try {
        input = JSON.stringify(use.input);
      } catch {
        input = '{}';
      }
      parts.push(`→ ${use.tool} ${clip(input, PART_LIMIT)}`);
    }
    for (const result of message.toolResults ?? []) {
      parts.push(`← ${result.isError ? 'error ' : ''}${clip(result.text, PART_LIMIT)}`);
    }
    lines.push(parts.join('\n'));
  });
  const text = lines.join('\n\n');
  return text.length <= limit ? text : `[…earlier part cut]\n${text.slice(text.length - limit)}`;
}

/** The prompt submitted after an automatic compaction, so the work goes on unattended. */
export const RESUME_PROMPT =
  'The context was just compacted. Continue the task from where you left off, without asking the user to confirm. If the task was already finished and you were waiting for the user, reply with one short line.';

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  /** At or below these characters the shortened results stand, however little they cut: no summary runs. */
  smallContextChars: number;
  /** Share of the text the built-in summarizer gets when no topic is finished. */
  summarizeShare: number;
  /** The model that writes summaries (`haiku`, `sonnet`, a full id); empty: the built-in compact. */
  summaryModel: string;
  model: string;
  resumeAfterCompact: boolean;
  /** Writes one JSON record per compaction under `logDir`. */
  decisionLog: boolean;
  /** Absent: `~/.claude/fast-jev-compaction/logs`. */
  logDir?: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'topicThreshold',
    'lastingThreshold',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  if (typeof options.pruneTopics === 'boolean') numbers.pruneTopics = options.pruneTopics;
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    smallContextChars: optionNumber(options, 'smallContextChars', HOOK_DEFAULTS.smallContextChars),
    summarizeShare: optionNumber(options, 'summarizeShare', HOOK_DEFAULTS.summarizeShare),
    summaryModel: optionString(options, 'summaryModel') ?? HOOK_DEFAULTS.summaryModel,
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    resumeAfterCompact:
      typeof options['resumeAfterCompact'] === 'boolean'
        ? options['resumeAfterCompact']
        : HOOK_DEFAULTS.resumeAfterCompact,
    decisionLog:
      typeof options['decisionLog'] === 'boolean'
        ? options['decisionLog']
        : HOOK_DEFAULTS.decisionLog,
  };
  const logDir = optionString(options, 'logDir');
  if (logDir) config.logDir = logDir;
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const send = () =>
        fetchFn(request.url, { method: request.method, headers: request.headers, body: request.body });
      // One retry for a dropped connection or a server error.
      let response: HookFetchResponse;
      try {
        response = await send();
        if (response.status >= 500) response = await send();
      } catch {
        response = await send();
      }
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

/**
 * The files the summarized part used, one per line as `<path> <name> "<action>"`:
 * the summary may drop them, this list stays, so the model knows what to re-read.
 */
export function filesNote(files: TouchedFiles): string {
  const lines = [
    ...files.written.map((path) => [path, 'write'] as const),
    ...files.read.map((path) => [path, 'read'] as const),
    ...files.mentioned.map((path) => [path, 'mentioned'] as const),
  ].map(([path, action]) => `${path} ${path.split('/').pop() ?? path} "${action}"`);
  if (lines.length === 0) return '';
  return `[fast-jev-compaction] Files used in the summarized part of the conversation (re-read any you need):\n${lines.join('\n')}`;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

/** The toast line: what changed for the person, in one short sentence. */
export function headline(result: CompactResult): string {
  const { stats } = result;
  return `${stats.messagesBefore} → ${stats.messagesAfter} messages, context −${percent(reductionRatio(result))} (${stats.resultsDropped} tool results shortened)`;
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * Shows the outcome as a toast only: the transcript stays free of compaction
 * notices. The host draws it under the plugin's name, so the text leaves it out.
 */
function notify(
  $: { ui: { toast: (text: string, options?: { timeoutMs?: number }) => void } },
  text: string,
): void {
  $.ui.toast(text, { timeoutMs: 10_000 });
}

export type Precomputed = { input: readonly SessionMessage[]; output: SessionMessage[] };

/**
 * The precomputed compaction applied to `messages`: its output plus every
 * message that came after its input, or undefined when `messages` no longer
 * opens with that input, matched by engine handle.
 */
export function reusePrecomputed(
  precomputed: Precomputed | undefined,
  messages: readonly SessionMessage[],
): SessionMessage[] | undefined {
  if (!precomputed) return undefined;
  const { input, output } = precomputed;
  const opens =
    input.length > 0 &&
    input.length <= messages.length &&
    input.every((m, i) => m.handle !== undefined && m.handle === messages[i]!.handle);
  return opens ? [...output, ...messages.slice(input.length)] : undefined;
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  /** The main conversation's last precomputed compaction: its input and its output. */
  let precomputed: Precomputed | undefined;

  on('session.compact', async ($, event, next) => {
    // The text after `/compact` is the next prompt: it runs once the compaction stands.
    const followUp =
      event.trigger === 'manual' && event.agentId === undefined ? event.instructions?.trim() : undefined;
    const outcome = await (async () => {
      const isMain = event.agentId === undefined;
      const isPrecompute = event.trigger === 'precompute';
      const record = async (
        log: Pick<Parameters<typeof compactionLog>[0], 'outcome' | 'note'>,
        result?: CompactResult,
        after?: number,
        extra?: Partial<CompactionLog>,
      ) => {
        if (!configured.decisionLog) return;
        try {
          const entry: CompactionLog = compactionLog(
            {
              ...log,
              sessionId: await $.session.id(),
              trigger: event.trigger,
              messages: event.messages,
              preserveRecentMessages: resolveOptions(configured).preserveRecentMessages,
            },
            result,
            after,
          );
          Object.assign(entry, extra);
          const dir = configured.logDir ?? `${await $.env.get('HOME')}/.claude/fast-jev-compaction/logs`;
          await $.fs.write(logPath(dir, entry), `${JSON.stringify(entry, null, 2)}\n`);
        } catch {
          // The log is a diagnostic: a failed write never changes the compaction.
        }
      };

      // The engine compacts what was precomputed, plus what came after: answer at once.
      const reused = isMain && !isPrecompute ? reusePrecomputed(precomputed, event.messages) : undefined;
      if (reused) {
        precomputed = undefined;
        notify($, `${event.messages.length} → ${reused.length} messages, from the precomputed compaction`);
        await record({ outcome: 'reused' }, undefined, reused.length);
        return { messages: reused };
      }
      // A new precompute replaces the last one, whatever it comes to.
      if (isMain && isPrecompute) precomputed = undefined;
      if (!isPrecompute) $.ui.status('Jev is compacting the context…');
      try {
        const config = { ...configured, apiKey: await getApiKey($, configured) };
        const fetchFn: HookFetch = async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        };
        let planned: Partial<CompactionLog> | undefined;
        /** Old tool results shortened, every call and text kept; computed once. */
        let shortening: ReturnType<typeof compactSession> | undefined;
        const shorten = () =>
          (shortening ??= compactSession(event.messages, { ...config, resultsOnly: true }, fetchFn));
        /** The built-in summarizer over `messages[0..cut)` alone; the rest stays as it is. */
        const summarizeOlder = async (cut: number, what: string, extra: Partial<CompactionLog> = {}) => {
          const older = event.messages.slice(0, cut);
          // The summarizer reads the shortened results: less to read, same calls and texts.
          const shortened = await shorten().then(
            (s) => (s.messages.length === event.messages.length ? s.messages.slice(0, cut) : older),
            () => older,
          );
          const ref = event.instructions?.trim() || latestRequest(event.messages, 1000);
          const files = touchedFiles(older);
          const total = event.messages.reduce((sum, m) => sum + messageChars(m), 0);
          const share = total > 0 ? older.reduce((sum, m) => sum + messageChars(m), 0) / total : 0;
          const started = Date.now();
          const instructions = summaryInstructions(ref, files);
          let summarized: { messages?: readonly SessionMessage[] } | undefined;
          let model = 'built-in';
          if (config.summaryModel) {
            $.ui.status(`${config.summaryModel} is summarizing the messages ${what}…`);
            const reply = await $.model
              .complete({
                model: config.summaryModel,
                system: SUMMARY_SYSTEM,
                prompt: `${instructions}\n\n<conversation>\n${renderTranscript(shortened as readonly SessionMessage[])}\n</conversation>`,
                maxTokens: 8000,
                timeoutMs: 120_000,
              })
              .catch(() => undefined);
            if (reply?.isAnswered && reply.text.trim()) {
              model = config.summaryModel;
              const text =
                'This session is being continued from an earlier conversation. The earlier part is summarized below; the newer messages follow verbatim.\n\n' +
                reply.text.trim();
              summarized = { messages: [{ role: 'user', text, toolUses: [] } as unknown as SessionMessage] };
            }
          }
          if (!summarized) {
            $.ui.status(`Claude is summarizing the messages ${what}…`);
            summarized = await next({ ...event, messages: shortened as typeof older, instructions });
          }
          if (!summarized.messages) return undefined;
          const note = filesNote(files);
          const messages = [
            ...summarized.messages,
            ...(note ? [{ role: 'user', text: note, toolUses: [] } as unknown as SessionMessage] : []),
            ...event.messages.slice(cut),
          ];
          notify($, `${older.length} messages ${what} summarized by ${model} in ${Math.round((Date.now() - started) / 1000)} s, ${event.messages.length - cut} kept as they are`);
          await record(
            { outcome: 'summarized', note: `${what}: ${older.length} of ${event.messages.length} messages summarized (${percent(share)} of the text)` },
            undefined,
            messages.length,
            {
              ...extra,
              reference: ref,
              cut,
              obsoleteShare: Math.round(share * 100) / 100,
              files,
              summarizedChars: shortened.reduce((sum, m) => sum + messageChars(m), 0),
              summaryModel: model,
              summaryMs: Date.now() - started,
            },
          );
          return { messages };
        };
        // Finished topics go to the built-in summarizer, alone; the rest stays as it is.
        if (!isPrecompute && config.pruneTopics !== false && config.apiKey) {
          const reference = event.instructions?.trim() ?? '';
          // A failed plan only means nothing is summarized: the results path still runs.
          const plan = await planTopics(
            event.messages,
            jevAsker(fetchFn, config.apiKey, config.model),
            resolveOptions(config),
            reference,
          ).catch(() => ({ cut: 0, turns: [], stateTokens: 0, stateStage: '' }));
          const obsolete = event.messages.slice(0, plan.cut);
          const total = event.messages.reduce((sum, m) => sum + messageChars(m), 0);
          const share = total > 0 ? obsolete.reduce((sum, m) => sum + messageChars(m), 0) / total : 0;
          const ref = reference || latestRequest(event.messages, 1000);
          const files = touchedFiles(obsolete);
          planned = { reference: ref, cut: plan.cut, obsoleteShare: Math.round(share * 100) / 100, turns: plan.turns, files };
          if (plan.cut > 0 && share >= config.minReductionRatio) {
            const done = await summarizeOlder(plan.cut, 'on finished topics', planned);
            if (done) return done;
          }
        }
        // Nothing finished to summarize: only old tool results are shortened.
        const { result, messages } = await shorten();
        // A small context keeps its shortened results: a summary there costs time and saves little.
        const small = result.stats.charsBefore <= config.smallContextChars && reductionRatio(result) > 0;
        if (!small && reductionRatio(result) < config.minReductionRatio) {
          const note = `below ${percent(config.minReductionRatio)} minimum: ${summarize(result)}`;
          if (!isPrecompute) {
            notify($, `built-in summary used: Jev would cut only ${percent(reductionRatio(result))} of the context`);
          }
          // No finished topic and little to shorten: the older part is summarized, the newest stays.
          const cut = isPrecompute
            ? 0
            : olderPartCut(event.messages, config.summarizeShare, resolveOptions(config).preserveRecentMessages, messageChars);
          if (cut > 0) {
            const done = await summarizeOlder(cut, 'in the older part', planned);
            if (done) return done;
          }
          await record({ outcome: 'fallback', note }, result, undefined, planned);
          return next(event);
        }
        if (isPrecompute) {
          if (isMain) precomputed = { input: event.messages, output: messages };
          await record({ outcome: 'precomputed', note: summarize(result) }, result, messages.length);
          return { messages };
        }
        notify($, headline(result));
        await record({ outcome: 'applied', note: summarize(result) }, result, messages.length, planned);
        return { messages };
      } catch (error) {
        const note = error instanceof Error ? error.message : String(error);
        if (!isPrecompute) notify($, `built-in summary used: ${note}`);
        await record({ outcome: 'error', note });
        return next(event);
      } finally {
        if (!isPrecompute) $.ui.status(undefined);
      }
    })();
    if (followUp && outcome.messages) void $.prompt.submit({ text: followUp, asUser: true });
    return outcome;
  }).catch(($, event, next) => {
    // A hook that threw or overran its budget: the built-in summary takes over.
    $.ui.status(undefined);
    return next(event);
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    // A subagent's turn or an interrupted one is no point to compact the main loop at.
    // 0 leaves compaction to the engine's own threshold (`autoCompactWindow`),
    // which compacts mid-turn and goes on without a prompt.
    if (configured.compactAtPercent <= 0) return next(event);
    if (compacting || event.agentId !== undefined || event.isAborted) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      const outcome = await $.session.compact();
      // A plugin's prompt runs once the session is idle, so it is not awaited here.
      if (configured.resumeAfterCompact && !('skip' in outcome && outcome.skip)) {
        void $.prompt.submit({ text: RESUME_PROMPT });
      }
    } catch (error) {
      notify($, `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
