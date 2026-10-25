import type { ChoiceAnswer, JevAnswer, JevQuestions } from './types.js';

/** One piece of a rule file: a section, a subsection or a list item. */
export interface RuleUnit {
  /** `r0`, `r1`, ... in file order, unique across all files. */
  id: string;
  /** The file it comes from, as given (relative to the project root). */
  file: string;
  /** The heading path (`Section › Subsection`); empty for a file's introduction. */
  title: string;
  /** The unit's own text, heading included, trimmed. */
  text: string;
}

export interface RulePick {
  /** Least probability a unit needs. Default 0.05. */
  threshold?: number;
  /** A unit stays within this distance of the best one. Default 0.05. */
  margin?: number;
  /** Most units picked. Default 2. */
  max?: number;
}

/** A unit longer than this is split at the next level. */
export const MAX_RULE_UNIT_CHARS = 4000;
/** Name of the choice question in a Jev request. */
export const RULES_QUESTION = 'rules';
export const RULES_PICK_INSTRUCTIONS =
  'Which unit of the project instructions is about the work in progress right now (the latest user request and what the assistant is doing in the last turns)?';
/** Start of the note this module writes. */
export const RULES_NOTE_HEAD = '[fast-jev-compaction] Project rules';

/** Pieces shorter than this are dropped. */
const MIN_UNIT_CHARS = 80;
/** Where a block is cut: before `##`, before `###`, before a list item, before a nested list item. */
const SEPARATORS = [/\n(?=## )/, /\n(?=### )/, /\n(?=- )/, /\n(?=  - )/];
/** The heading that names a piece cut at `##` or `###`. */
const HEADINGS = [/^## (.+)/, /^### (.+)/];

/** Splits one markdown file into units, from `##` down to nested list items, until each fits `maxChars`. */
export function splitMarkdown(text: string, file: string, maxChars = MAX_RULE_UNIT_CHARS): Omit<RuleUnit, 'id'>[] {
  const units: Omit<RuleUnit, 'id'>[] = [];
  const go = (block: string, title: string, level: number): void => {
    if (block.length <= maxChars || level >= SEPARATORS.length) {
      const body = block.trim();
      if (body.length >= MIN_UNIT_CHARS) units.push({ file, title, text: body });
      return;
    }
    const parts = block.split(SEPARATORS[level]!);
    if (parts.length === 1) {
      // Not cut here, so the block's own first line still has to name it.
      go(block, level < 3 ? titled(block, title, level) : title, level + 1);
      return;
    }
    parts.forEach((part, k) => {
      // A nested item (level 3) that opens the block is its parent item, already named.
      if (level === 3 && k === 0) {
        go(part, title, level + 1);
        return;
      }
      go(part, titled(part, title, level), level + 1);
    });
  };
  go(text, '', 0);
  return units;
}

/** `title` extended by the name the first line of `piece` gives it at `level`. */
function titled(piece: string, title: string, level: number): string {
  const head = level < 2 ? piece.match(HEADINGS[level]!)?.[1] : listItemTitle(piece);
  return head ? (title ? `${title} › ${head}` : head) : title;
}

/** The title of a list item: its first line without `- ` and bold markers; undefined for other text. */
function listItemTitle(piece: string): string | undefined {
  const first = piece.trim().split('\n', 1)[0] ?? '';
  if (!first.startsWith('- ')) return undefined;
  return first.slice(2).replace(/\*\*/g, '').trim() || undefined;
}

/** The units of every file, in order, with ids. */
export function ruleUnits(files: readonly { file: string; text: string }[]): RuleUnit[] {
  return files
    .flatMap(({ file, text }) => splitMarkdown(text, file))
    .map((unit, n) => ({ id: `r${n}`, ...unit }));
}

/** One choice question over the units that have a title; `{}` when none has. */
export function rulesQuestion(units: readonly RuleUnit[], labelChars = 200): JevQuestions {
  const criteria: Record<string, string> = {};
  for (const unit of units) {
    if (unit.title !== '') criteria[unit.id] = unitLabel(unit, labelChars);
  }
  if (Object.keys(criteria).length === 0) return {};
  return { [RULES_QUESTION]: { type: 'choice', instructions: RULES_PICK_INSTRUCTIONS, criteria } };
}

/** The units Jev's answer to `rulesQuestion` points at, best first. */
export function pickRules(
  answers: Readonly<Record<string, JevAnswer>>,
  units: readonly RuleUnit[],
  options: RulePick = {},
): RuleUnit[] {
  const answer = answers[RULES_QUESTION];
  if (!answer || (answer.type ?? 'choice') !== 'choice') return [];
  const probabilities = (answer as ChoiceAnswer).probabilities ?? {};
  const threshold = options.threshold ?? 0.05;
  const margin = options.margin ?? 0.05;
  const max = options.max ?? 2;

  const titled = new Map<string, RuleUnit>(units.filter((u) => u.title !== '').map((u) => [u.id, u]));
  const scored = Object.entries(probabilities)
    .filter(([id, p]) => titled.has(id) && typeof p === 'number' && Number.isFinite(p))
    .map(([id, p]) => ({ unit: titled.get(id)!, p }))
    .sort((a, b) => b.p - a.p);
  if (scored.length === 0) return [];

  const cutoff = Math.max(threshold, scored[0]!.p - margin);
  return scored
    .filter((s) => s.p >= cutoff)
    .slice(0, max)
    .map((s) => s.unit);
}

/** The note added after a compaction: the index of all units, the introductions and the picked units in full. */
export function rulesNote(units: readonly RuleUnit[], picked: readonly RuleUnit[], maxChars = 12000): string {
  if (units.length === 0) return '';
  const shown = new Set<string>();
  const once = (u: RuleUnit): boolean => {
    if (shown.has(u.id)) return false;
    shown.add(u.id);
    return true;
  };
  const chosen = picked.filter(once);
  const intros = units.filter((u) => u.title === '').filter(once);

  // The picked units come first, in full (cut only when they alone do not fit); then the introductions
  // (cut or omitted); the index takes what is left.
  let note = `${RULES_NOTE_HEAD}\nRe-read from the file what you need.`;
  for (const unit of [...chosen, ...intros]) {
    const prefix = `\n\n## ${unitName(unit)}\n`;
    const room = maxChars - note.length - prefix.length;
    if (unit.text.length <= room) {
      note += prefix + unit.text;
      continue;
    }
    const cut = `… (re-read ${unit.file})`;
    if (room > cut.length) note += prefix + unit.text.slice(0, room - cut.length) + cut;
  }

  const lines = indexLines(units);
  const header = '\n\nIndex:';
  const marker = '\n- … (see the files)';
  if (lines.length === 0 || note.length + header.length + marker.length > maxChars) return note;
  const full = header + lines.map((line) => `\n${line}`).join('');
  if (note.length + full.length <= maxChars) return note + full;
  let index = header;
  for (const line of lines) {
    const piece = `\n${line}`;
    if (note.length + index.length + piece.length + marker.length <= maxChars) {
      index += piece;
      continue;
    }
    // Keeps the titles of this line that fit, cut before a title.
    const room = maxChars - note.length - index.length - marker.length - 1;
    const cut = line.slice(0, Math.max(room, 0));
    const at = cut.lastIndexOf(' · ');
    if (at > 0) index += `\n${cut.slice(0, at)}`;
    break;
  }
  return note + index + marker;
}

/** One line per file: `- <file>: <top titles, separated by ·>`, each title at most 60 characters. */
function indexLines(units: readonly RuleUnit[]): string[] {
  const byFile = new Map<string, string[]>();
  for (const unit of units) {
    if (unit.title === '') continue;
    const top = unit.title.split(' › ')[0]!.slice(0, 60);
    const titles = byFile.get(unit.file) ?? [];
    if (!titles.includes(top)) titles.push(top);
    byFile.set(unit.file, titles);
  }
  return [...byFile].map(([file, titles]) => `- ${file}: ${titles.join(' · ')}`);
}

/** `file › title`, or the file alone for an introduction. */
function unitName(unit: RuleUnit): string {
  return unit.title ? `${unit.file} › ${unit.title}` : unit.file;
}

/** The unit's text without its heading line, on one line, cut to `chars` characters. */
function unitLabel(unit: RuleUnit, chars: number): string {
  const lines = unit.text.split('\n');
  const body = (lines[0]?.startsWith('#') ? lines.slice(1) : lines).join(' ').replace(/\s+/g, ' ').trim();
  return `[${unit.file}] ${unit.title}: ${body.slice(0, chars)}`;
}
