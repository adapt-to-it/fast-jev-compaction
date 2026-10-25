// Banco di prova delle regole, passo 1 (senza chiave): unità di regola e casi di compact per progetto.
// Uso: tsx examples/rules/build.ts /tmp/rules-eval/config.json
// config: { "out": dir, "projects": [{ "name", "transcripts", "repo", "rules": [file...], "cases": n, "holdout": bool }] }
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectToolCalls, fitState, recentRequests, requestText, type Message } from '../../src/index.js';

const MAX_UNIT = 4000;
const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));

/** Divide un file markdown: per `##`, poi `###`, poi voci di primo e secondo livello, finché i pezzi stanno sotto MAX_UNIT. */
export function splitMarkdown(text: string, file: string): { file: string; title: string; text: string }[] {
  const seps = [/\n(?=## )/, /\n(?=### )/, /\n(?=- )/, /\n(?=  - )/];
  const go = (block: string, title: string, level: number): { file: string; title: string; text: string }[] => {
    if (block.length <= MAX_UNIT || level >= seps.length) return block.trim() ? [{ file, title, text: block.trim() }] : [];
    const parts = block.split(seps[level]!);
    if (parts.length === 1) return go(block, title, level + 1);
    return parts.flatMap((p, k) => {
      const head = (p.match(/^#{2,3} (.+)/) ?? p.match(/^\s*- \*\*(.+?)\*\*/))?.[1];
      return go(p, k === 0 && !head ? title : [title, head ?? p.trim().slice(0, 60)].filter(Boolean).join(' › '), level + 1);
    });
  };
  return go(text, '', 0).filter((u) => u.text.length > 80);
}

function load(path: string): Message[][] {
  const parts: Message[][] = [[]];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let d: any; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'system' && d.subtype === 'compact_boundary') { parts.push([]); continue; }
    if ((d.type !== 'user' && d.type !== 'assistant') || !d.message) continue;
    const c = d.message.content;
    const blocks: any[] = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    const flat = (x: any): string => (typeof x === 'string' ? x : Array.isArray(x) ? x.map((b) => b.text ?? '').join('\n') : '');
    parts[parts.length - 1]!.push({
      role: d.type, text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
      toolUses: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ tool_use_id: b.id, tool: b.name, input: b.input ?? {} })),
      toolResults: blocks.filter((b) => b.type === 'tool_result').map((b) => ({ tool_use_id: b.tool_use_id, text: flat(b.content), isError: !!b.is_error })),
    });
  }
  return parts;
}

/** Cosa è successo dopo il compact, per il giudice: richieste, testi, file, comandi. */
function after(next: Message[], repo: string) {
  const strip = (p: unknown) => String(p ?? '').replace(repo + '/', '');
  const uses = next.flatMap((m) => m.toolUses).slice(0, 80);
  return {
    requests: next.filter((m) => m.role === 'user').map((m) => requestText(m.text)).filter(Boolean).slice(0, 3).map((t) => t.slice(0, 600)),
    assistant: next.filter((m) => m.role === 'assistant' && m.text.trim()).map((m) => m.text.trim()).join('\n---\n').slice(0, 2500),
    written: [...new Set(uses.filter((u) => /Edit|Write/.test(u.tool)).map((u) => strip(u.input.file_path)))].slice(0, 25),
    read: [...new Set(uses.filter((u) => u.tool === 'Read').map((u) => strip(u.input.file_path)))].slice(0, 25),
    commands: uses.filter((u) => u.tool === 'Bash').map((u) => String(u.input.command ?? '').split('\n')[0]!.slice(0, 100)).slice(0, 15),
  };
}

for (const p of config.projects) {
  const dir = join(config.out, p.name);
  mkdirSync(dir, { recursive: true });
  const units = p.rules.flatMap((f: string) => splitMarkdown(readFileSync(join(p.repo, f), 'utf8'), f)).map((u: any, k: number) => ({ id: `u${k}`, ...u }));
  const files = readdirSync(p.transcripts).filter((f) => f.endsWith('.jsonl')).sort();
  const all = files.flatMap((f) => { const s = load(join(p.transcripts, f)); return s.slice(0, -1).map((before, i) => ({ session: f.slice(0, 8), i, before, next: s[i + 1]! })); })
    .filter((c) => c.before.length > 40 && c.next.length > 10);
  const step = Math.max(1, all.length / p.cases);
  // Con casi già costruiti si riprendono gli stessi compact, così le etichette restano valide.
  const prev = existsSync(join(dir, 'cases.json')) ? JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8')) : undefined;
  const picked = prev
    ? prev.map((c: any) => all.find((a) => a.session === c.session && a.i === c.compact)!)
    : Array.from({ length: Math.min(p.cases, all.length) }, (_, k) => all[Math.floor(k * step)]!);
  const cases = picked.map((c, k) => {
    const goal = recentRequests(c.before, 200, 1000);
    const state = fitState(c.before, collectToolCalls(c.before, 6), { maxStateTokens: 16000, preserveRecentMessages: 6, goal });
    // Stato alla prima richiesta nuova dopo il compact: simula la nuova scelta quando l'utente scrive.
    const first = c.next.findIndex((m) => m.role === 'user' && requestText(m.text) !== '');
    const upTo = first >= 0 ? [...c.before, ...c.next.slice(0, first + 1)] : c.before;
    const goalNext = recentRequests(upTo, 200, 1000);
    const stateNext = fitState(upTo, collectToolCalls(upTo, 6), { maxStateTokens: 16000, preserveRecentMessages: 6, goal: goalNext });
    return { id: `${p.name}-${k}`, session: c.session, compact: c.i, holdout: p.holdout || k % 3 === 2, goal, state: state.state, newRequest: first >= 0, stateNext: stateNext.state, after: after(c.next, p.repo) };
  });
  writeFileSync(join(dir, 'units.json'), JSON.stringify(units, null, 1));
  writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
  writeFileSync(join(dir, 'judge.json'), JSON.stringify(cases.map(({ id, goal, after }) => ({ id, goal: goal.slice(0, 600), after })), null, 1));
  console.log(`${p.name}: ${units.length} unità (max ${Math.max(...units.map((u: any) => u.text.length))} car.), ${all.length} compact, ${cases.length} casi`);
}
