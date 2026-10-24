# fast-jev-compaction (adapt-to-it fork)

A Claude Code plugin that makes compaction faster and keeps the recent
work verbatim. It uses Jev, TypeSafe's System One model, to find which part
of a session is finished, and a small model (Haiku by default) to summarize
only that part.

## Credits

This project started as a fork of
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
by Tamara Tran. Her version replaced the compaction summary with Jev
decisions: it scored every tool call and result, dropped the stale ones and
kept everything else verbatim. The Jev client, the state fitting, the
token estimates, the tool-call scoring library in `src/` and the demo app
come from her work. Thank you, Tamara.

This fork has since taken a different direction. It no longer deletes tool
calls or turns from the plugin's output. It summarizes old, finished work
and keeps the rest as it is. The two projects now solve the problem in
different ways. Report issues with this fork here, not upstream.

## How a compaction works

On every `/compact` and every automatic compaction, the plugin runs these
steps in order and stops at the first one that applies:

1. **Finished topics.** The plugin splits the session into turns: a user
   request and the replies up to the next request. Jev answers one Choice,
   `topic_start`: from which turn the current work starts. The reference is
   the text you write after `/compact`, or else your latest requests. When
   the turns before that point hold at least `minReductionRatio` of the
   text, the plugin summarizes them and keeps the later turns verbatim.
2. **Shortened tool results.** With no finished topic, the plugin shortens
   old tool results and keeps every call and every text. When this cuts at
   least `minReductionRatio` of the text, the result stands. Up to
   `smallContextChars` characters it stands however little it cuts, because
   a summary of a small context costs more time than it saves.
3. **Older part.** When shortening cuts too little, the plugin summarizes
   the oldest `summarizeShare` of the text. The cut falls before an
   assistant message, so no tool call is split from its result, and never
   inside the newest `preserveRecentMessages` messages.
4. **Built-in compact.** When none of the steps above applies, or a step
   fails, Claude Code's own compact summarizes the whole session.

Every summary works the same way:

- The summarizer reads the part to summarize with its old tool results
  already shortened, so it has less to read.
- `summaryModel` (default `haiku`) writes the summary through the session's
  own credentials, with low effort and a 16,000-token reply cap. It writes
  in the language the user writes in. A reply that fails, or that reaches
  the cap and may be cut short, is discarded, and the built-in compact
  writes the summary instead.
- After the summary, the plugin adds one line per file the summarized part
  used, `<path> <name> "write|read|mentioned"`, so the model can re-read it.

The text after a manual `/compact` is also the next prompt. The plugin
submits it, as your own words, once the compaction is done. After an
automatic compaction, the plugin submits a short resume prompt instead,
unless `resumeAfterCompact` is off.

### Typical timings

Measured on 45 compactions of real sessions, 22–24 October 2026, with
contexts of about 370,000 tokens:

| Step | Compactions | Time |
| --- | --- | --- |
| Shortened tool results | 21 | about 1 s |
| Finished topics, summarized by Haiku | 17 | 12–20 s |
| Older part, summarized by Haiku | 7 | 12–47 s |

The built-in compact took 36–78 s on the same sessions before.

## Install

The plugin needs Claude Code with function hooks (2.1.301 or later). On
builds where function hooks are behind a flag, set it in
`~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Install from GitHub:

```sh
claude plugin marketplace add adapt-to-it/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

To work on the plugin, install it from a local checkout instead. Claude Code
then reads the folder itself, and `/reload-plugins` applies a change without
a restart:

```sh
claude plugin marketplace add ~/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

### TypeSafe key

Jev needs a TypeSafe API key. Store it in the plugin's secrets, without
showing it on screen:

```sh
read -rs "k?TypeSafe key: " && printf '{"apiKey":"%s"}' "$k" | claude plugin configure fast-jev-compaction@fast-jev-compaction --values-stdin; unset k
```

Without the `apiKey` option, the plugin reads `TYPESAFE_API_KEY` from the
environment, then from the `env` section of `~/.claude/settings.json`. The
desktop app does not read `~/.zshrc`, so a key exported there does not reach
it. Removing the marketplace deletes the plugin's saved options and secrets.

## Options

Set them with `claude plugin configure fast-jev-compaction@fast-jev-compaction`.

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | unset | TypeSafe API key; unset reads `TYPESAFE_API_KEY` |
| `model` | `jev-1.13.0` | Jev model |
| `pruneTopics` | `true` | Asks Jev for finished topics (step 1) |
| `topicThreshold` | `0.8` | Minimum probability that the current topic started after a turn |
| `minReductionRatio` | `0.25` | Minimum share of the text a step must cut |
| `smallContextChars` | `100000` | Up to this size, shortened results stand however little they cut |
| `summarizeShare` | `0.75` | Share of the text summarized in step 3 |
| `summaryModel` | `haiku` | Model that writes summaries; empty uses the built-in compact |
| `preserveRecentMessages` | `6` | Newest messages never summarized or shortened |
| `truncateHeadChars` | `300` | Characters kept from a shortened tool result |
| `maxStateTokens` | `25000` | Estimated token budget for the state sent to Jev |
| `maxRequestTokens` | `30000` | Estimated token budget for one Jev request |
| `compactAtPercent` | `0` | Context percentage at which the plugin compacts at the end of a turn; 0 leaves the timing to Claude Code |
| `resumeAfterCompact` | `true` | Submits a resume prompt after an automatic compaction |
| `decisionLog` | `false` | Writes one JSON record per compaction |
| `logDir` | unset | Log folder; unset is `~/.claude/fast-jev-compaction/logs` |

`keepThreshold` and `lastingThreshold` still exist for the library. The
plugin no longer uses them.

## Decision log

With `decisionLog` on, every compaction writes a JSON record to
`~/.claude/fast-jev-compaction/logs/<session>/<time>-<trigger>.json`. It
holds the trigger, the outcome (`applied`, `summarized`, `fallback`,
`error`), Jev's score for each turn, the cut point, the files of the
summarized part, and for summaries the model, the time
(`summaryMs`), the characters read (`summarizedChars`) and the output
tokens (`summaryOutputTokens`).

The log is off by default because the records hold request texts and tool
inputs from your sessions. The plugin never writes its API key there. If you
turn the log on, keep the folder private:

```sh
printf '{"decisionLog":"true"}' | claude plugin configure fast-jev-compaction@fast-jev-compaction --values-stdin
```

## Library

`src/` is still an npm-style TypeScript library. `compact()` and
`compactMessages()` score tool calls and results with Jev and drop or
shorten the stale ones, as in the upstream design. The plugin calls it with
`resultsOnly: true`, which only shortens results. `planTopics()`,
`olderPartCut()` and `touchedFiles()` in `src/plan.ts` hold the plugin's
topic and cut logic.

## Development

```sh
npm install
npm run typecheck
npm test
claude plugin validate .
```

The unit tests use a fake Jev and never contact TypeSafe.
`npm run demo` runs a live request and needs `TYPESAFE_API_KEY`.
`demo/JevDemo` is the upstream SwiftUI app that plays a scripted compaction
for screen recordings.

## License

MIT, as upstream. See [LICENSE](LICENSE).
