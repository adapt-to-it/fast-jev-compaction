// Banco di prova delle regole, passo 2 (con TYPESAFE_API_KEY): resta in ascolto ed esegue le varianti.
// Uso: tsx examples/rules/run.ts /tmp/rules-eval/v2
// Ogni file jobs/<nome>.json è una variante; il risultato va in results/<nome>.json. Il file jobs/STOP chiude.
// Un file jobs/<nome>.mjs è una variante libera: esporta `run(ask, units, c)` e restituisce { unità: probabilità }.
// La chiave resta solo nella memoria di questo processo.
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JevClient, type JevQuestions } from '../../src/index.js';

interface Variant {
  mode: 'noul' | 'choice';
  /** Testo della domanda; `{label}` è l'etichetta dell'unità. */
  instructions: string;
  true?: string;
  false?: string;
  /** Caratteri del testo dell'unità nell'etichetta, dopo il titolo. */
  labelChars: number;
  /** Domande per richiesta, in modalità noul. */
  batch?: number;
  /** Testo aggiunto al contesto dello stato. */
  context?: string;
  projects?: string[];
}

const root = process.argv[2]!;
const jev = new JevClient();
mkdirSync(join(root, 'results'), { recursive: true });
mkdirSync(join(root, 'jobs'), { recursive: true });
const projects = readdirSync(root).filter((p) => existsSync(join(root, p, 'cases.json')));

const label = (u: any, chars: number) =>
  `[${u.file}] ${u.title ? u.title + ': ' : ''}${u.text.replace(/^#+ .*\n/, '').replace(/\s+/g, ' ').slice(0, chars)}`;

async function runCase(v: Variant, units: any[], c: any): Promise<Record<string, number>> {
  const state = v.context ? { ...c.state, context: `${c.state.context}\n${v.context}` } : c.state;
  if (v.mode === 'choice') {
    const criteria: Record<string, string> = { none: 'No rule unit is needed by the current work.' };
    for (const u of units) criteria[u.id] = label(u, v.labelChars);
    const res = await jev.ask(state, { pick: { type: 'choice', instructions: v.instructions, criteria } });
    return (res.answers.pick as any)?.probabilities ?? {};
  }
  const out: Record<string, number> = {};
  const size = v.batch ?? 40;
  for (let k = 0; k < units.length; k += size) {
    const questions: JevQuestions = {};
    for (const u of units.slice(k, k + size))
      questions[u.id] = { type: 'noul', instructions: v.instructions.replace('{label}', label(u, v.labelChars)), criteria: { true: v.true, false: v.false } };
    const res = await jev.ask(state, questions);
    for (const [id, a] of Object.entries(res.answers)) out[id] = (a as any).noul;
  }
  return out;
}

type Runner = (v: Variant, units: any[], c: any) => Promise<Record<string, number>>;

async function runJob(name: string, v: Variant, runner: Runner = runCase): Promise<void> {
  const result: Record<string, Record<string, number> | { error: string }> = {};
  const t0 = Date.now();
  for (const p of projects.filter((p) => !v.projects || v.projects.includes(p))) {
    const units = JSON.parse(readFileSync(join(root, p, 'units.json'), 'utf8'));
    const cases = JSON.parse(readFileSync(join(root, p, 'cases.json'), 'utf8'));
    for (let k = 0; k < cases.length; k += 4)
      await Promise.all(cases.slice(k, k + 4).map(async (c: any) => {
        result[c.id] = await runner(v, units, c).catch((e) => ({ error: String(e).slice(0, 300) }));
      }));
    console.log(`  ${name} ${p}: ${cases.length} casi`);
  }
  writeFileSync(join(root, 'results', `${name}.json`), JSON.stringify(result));
  console.log(`${name}: fatto in ${Math.round((Date.now() - t0) / 1000)} s`);
}

console.log(`In ascolto su ${join(root, 'jobs')} (${projects.join(', ')}). Crea jobs/STOP per chiudere.`);
for (;;) {
  if (existsSync(join(root, 'jobs', 'STOP'))) break;
  const todo = readdirSync(join(root, 'jobs')).filter((f) => /\.(json|mjs)$/.test(f) && !existsSync(join(root, 'results', f.replace(/\.mjs$/, '.json'))));
  for (const f of todo) {
    const name = f.replace(/\.(json|mjs)$/, '');
    if (f.endsWith('.json')) { await runJob(name, JSON.parse(readFileSync(join(root, 'jobs', f), 'utf8'))); continue; }
    const mod = await import(join(root, 'jobs', f)).catch((e) => { console.log(`${name}: ${e}`); return undefined; });
    if (!mod) { writeFileSync(join(root, 'results', `${name}.json`), '{}'); continue; }
    const ask = (state: unknown, questions: JevQuestions) => jev.ask(state as object, questions);
    await runJob(name, (mod.variant ?? {}) as Variant, (_v, units, c) => mod.run(ask, units, c));
  }
  await new Promise((r) => setTimeout(r, 3000));
}
