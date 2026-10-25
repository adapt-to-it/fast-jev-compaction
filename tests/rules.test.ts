import { describe, expect, it } from 'vitest';
import {
  RULES_NOTE_HEAD,
  RULES_QUESTION,
  pickRules,
  ruleUnits,
  rulesNote,
  rulesQuestion,
  splitMarkdown,
  type RuleUnit,
} from '../src/rules.js';
import type { JevAnswer } from '../src/types.js';

const intro = 'Project introduction: the rules that apply to every task in this repository, read them first.';
const longC = 'C details. '.repeat(30);
const sample = [
  intro,
  '',
  '## A',
  'Rule A says that every change needs a test in the same commit, and nothing else ships without it.',
  '',
  '## B',
  '### C',
  longC,
].join('\n');

/** `sample` with a section over the default 4000 characters, so that `ruleUnits` splits it. */
const big = sample.replace(longC, 'C details. '.repeat(400));

function unit(id: string, title: string, text = `${title} text`, file = 'rules.md'): RuleUnit {
  return { id, file, title, text };
}

describe('splitMarkdown', () => {
  it('splits an oversize section at ### and names the pieces by their heading path', () => {
    const units = splitMarkdown(sample, 'rules.md', 300);
    expect(units.map((u) => u.title)).toEqual(['', 'A', 'B › C']);
    expect(units[0]!.text).toBe(intro);
    expect(units[1]!.text.startsWith('## A')).toBe(true);
    expect(units[2]!.text.startsWith('### C')).toBe(true);
    expect(units.every((u) => u.file === 'rules.md')).toBe(true);
  });

  it('names list items by their first line, without the dash and the bold markers', () => {
    const item = (n: number) => `- **Più contatori** (9 ottobre) n${n} ${'dettagli '.repeat(12)}`;
    const units = splitMarkdown(['## Contatori', item(1), item(2)].join('\n'), 'rules.md', 100);
    expect(units).toHaveLength(2);
    expect(units[0]!.title.startsWith('Contatori › Più contatori (9 ottobre) n1 dettagli')).toBe(true);
    expect(units[1]!.title.startsWith('Contatori › Più contatori (9 ottobre) n2 dettagli')).toBe(true);
    expect(units.map((u) => u.title).join('\n')).not.toMatch(/\*\*|› - /);
  });

  it('drops pieces shorter than 80 characters', () => {
    const units = splitMarkdown(sample, 'rules.md', 300);
    expect(units.some((u) => u.text === '## B')).toBe(false);
  });
});

describe('ruleUnits', () => {
  it('numbers the units r0, r1, ... in file order across all files', () => {
    const units = ruleUnits([
      { file: 'a.md', text: big },
      { file: 'b.md', text: intro },
    ]);
    expect(units.map((u) => u.id)).toEqual(units.map((_, n) => `r${n}`));
    expect(units.map((u) => u.file)).toEqual(['a.md', 'a.md', 'a.md', 'b.md']);
  });
});

describe('rulesQuestion', () => {
  it('asks a choice over the titled units only, without the introductions', () => {
    const units = ruleUnits([{ file: 'rules.md', text: big }]);
    const questions = rulesQuestion(units);
    expect(Object.keys(questions)).toEqual([RULES_QUESTION]);
    expect(questions[RULES_QUESTION]).toMatchObject({ type: 'choice' });
    const criteria = (questions[RULES_QUESTION] as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(criteria)).toEqual(['r1', 'r2']);
    expect(criteria.r1).toContain('[rules.md] A:');
  });

  it('asks nothing when no unit has a title', () => {
    expect(rulesQuestion([unit('r0', '', intro)])).toEqual({});
    expect(rulesQuestion([])).toEqual({});
  });
});

describe('pickRules', () => {
  const units = [unit('r0', ''), unit('r1', 'A'), unit('r2', 'B'), unit('r3', 'C')];
  const answer = (probabilities: Record<string, number>): Record<string, JevAnswer> => ({
    [RULES_QUESTION]: { type: 'choice', choice: 'r1', confidence: 0.6, probabilities },
  });

  it('keeps the units within the margin of the best one', () => {
    const picked = pickRules(answer({ r1: 0.6, r2: 0.57, r3: 0.3 }), units);
    expect(picked.map((u) => u.id)).toEqual(['r1', 'r2']);
  });

  it('keeps at most max units', () => {
    const picked = pickRules(answer({ r1: 0.6, r2: 0.57, r3: 0.3 }), units, { max: 1 });
    expect(picked.map((u) => u.id)).toEqual(['r1']);
  });

  it('ignores units without a title', () => {
    const picked = pickRules(answer({ r0: 0.9, r3: 0.2 }), units);
    expect(picked.map((u) => u.id)).toEqual(['r3']);
  });

  it('picks nothing without a choice answer', () => {
    expect(pickRules({}, units)).toEqual([]);
    expect(pickRules({ [RULES_QUESTION]: { type: 'noul', noul: 0.9 } }, units)).toEqual([]);
  });
});

describe('rulesNote', () => {
  const units = [
    unit('r0', '', 'intro words of the project', 'a.md'),
    unit('r1', 'A', 'alpha body of section A', 'a.md'),
    unit('r2', 'B', 'beta body of section B', 'a.md'),
    unit('r3', 'C', 'gamma body of section C', 'a.md'),
  ];

  it('holds the index of every titled unit, the introductions and the picked units in full', () => {
    const note = rulesNote(units, [units[1]!]);
    expect(note.startsWith(RULES_NOTE_HEAD)).toBe(true);
    expect(note).toContain('- a.md: A · B · C');
    expect(note).toContain('intro words of the project');
    expect(note).toContain('alpha body of section A');
    expect(note).not.toContain('beta body of section B');
    expect(note).not.toContain('gamma body of section C');
  });

  it('cuts a picked unit that alone exceeds maxChars and the index last', () => {
    const long = [unit('r0', 'A', `head ${'x'.repeat(500)}`, 'a.md'), unit('r1', 'B', 'beta', 'a.md')];
    const note = rulesNote(long, [long[0]!], 400);
    expect(note).toContain('(re-read a.md)');
    expect(note).not.toContain('x'.repeat(500));
    expect(note.length).toBeLessThanOrEqual(400);
  });

  it('keeps the picked units whole and truncates the index when there are many titles', () => {
    const many = Array.from({ length: 40 }, (_, n) =>
      unit(`r${n}`, `Titolo ${n}`, `body ${n} ${'word '.repeat(40)}`.trim(), 'big.md'),
    );
    const picked = [many[5]!, many[17]!];
    const note = rulesNote(many, picked, 1000);
    expect(note).toContain(picked[0]!.text);
    expect(note).toContain(picked[1]!.text);
    expect(note).toContain('(see the files)');
    expect(note).toContain('- big.md: Titolo 0 · Titolo 1 · ');
    expect(note).not.toContain('Titolo 39');
    expect(note.length).toBeLessThanOrEqual(1000);
  });

  it('is empty without units', () => {
    expect(rulesNote([], [])).toBe('');
  });
});
