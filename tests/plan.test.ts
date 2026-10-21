import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../src/compact.js';
import { planTopics, summaryInstructions, touchedFiles } from '../src/plan.js';
import type {
  CompactionState,
  JevAsker,
  JevQuestions,
  JevState,
  Message,
  ResolvedCompactOptions,
} from '../src/types.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

/** `turns` user requests, each followed by one reply. */
function conversation(turns: number): Message[] {
  const out: Message[] = [];
  for (let n = 1; n <= turns; n++) out.push(message('user', `request ${n}`), message('assistant', `reply ${n}`));
  return out;
}

/** A JevAsker that answers `topic_start` with the given probabilities and records every call. */
function fakeAsker(probabilities: Record<string, number>) {
  const calls: { state: JevState; questions: JevQuestions }[] = [];
  const asker: JevAsker = {
    async ask(state, questions) {
      calls.push({ state, questions });
      return { answers: { topic_start: { choice: 'T02', confidence: 1, probabilities } } };
    },
  };
  return { asker, calls };
}

function options(preserveRecentMessages: number): ResolvedCompactOptions {
  return { ...DEFAULT_OPTIONS, preserveRecentMessages };
}

describe('planTopics', () => {
  it('asks only topic_start and sends the reference as the goal', async () => {
    const { asker, calls } = fakeAsker({ T01: 0, T02: 0, T03: 0, T04: 1 });
    const plan = await planTopics(conversation(4), asker, options(2), 'next task');
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.questions)).toEqual(['topic_start']);
    expect((calls[0]!.state as CompactionState).goal).toBe('next task');
    expect(plan.stateTokens).toBeGreaterThan(0);
  });

  it('falls back to options.goal when the reference is empty', async () => {
    const { asker, calls } = fakeAsker({ T01: 0, T02: 0, T03: 0, T04: 1 });
    await planTopics(conversation(4), asker, { ...options(2), goal: 'the goal' }, '');
    expect((calls[0]!.state as CompactionState).goal).toBe('the goal');
  });

  it('makes no call and cuts nothing when there is no candidate turn', async () => {
    const { asker, calls } = fakeAsker({ T01: 1 });
    const plan = await planTopics(conversation(1), asker, options(0), 'next');
    expect(calls).toHaveLength(0);
    expect(plan.cut).toBe(0);
    expect(plan.turns.every((turn) => !turn.dropped)).toBe(true);
  });

  it('drops the obsolete prefix, the first message included', async () => {
    // Turns end at 2, 4, 6, 8; preserve 2 leaves 6 messages outside the tail.
    const { asker } = fakeAsker({ T01: 0.05, T02: 0.95, T03: 0, T04: 0 });
    const plan = await planTopics(conversation(4), asker, options(2), 'next');
    expect(plan.cut).toBe(2);
    expect(plan.turns.map((turn) => turn.dropped)).toEqual([true, false, false, false]);
  });

  it('extends the prefix while the work has moved on', async () => {
    const { asker } = fakeAsker({ T01: 0, T02: 0, T03: 0, T04: 1 });
    const plan = await planTopics(conversation(4), asker, options(2), 'next');
    expect(plan.cut).toBe(6);
    expect(plan.turns.map((turn) => turn.dropped)).toEqual([true, true, true, false]);
  });

  it('stops at the preserved boundary', async () => {
    // Boundary is 8 - 4 = 4: T03 ends at 6 and is not in the prefix, though the work moved on after it.
    const { asker } = fakeAsker({ T01: 0, T02: 0, T03: 0, T04: 1 });
    const plan = await planTopics(conversation(4), asker, options(4), 'next');
    expect(plan.cut).toBe(4);
    expect(plan.turns.map((turn) => turn.dropped)).toEqual([true, true, false, false]);
  });

  it('keeps everything when the work does not clearly move on', async () => {
    const { asker } = fakeAsker({ T01: 0.5, T02: 0, T03: 0, T04: 0.5 });
    const plan = await planTopics(conversation(4), asker, options(2), 'next');
    expect(plan.cut).toBe(0);
    expect(plan.turns.every((turn) => !turn.dropped)).toBe(true);
  });
});

describe('touchedFiles', () => {
  it('sorts each file into one list, by first appearance', () => {
    const messages = [
      message('user', 'look at @src/a.ts @/r/a.ts @"docs/my notes.md" please'),
      message('assistant', '', {
        toolUses: [
          { tool_use_id: 't1', tool: 'Read', input: { file_path: '/r/a.ts' } },
          { tool_use_id: 't2', tool: 'Edit', input: { file_path: 'src/b.ts' } },
          { tool_use_id: 't3', tool: 'Grep', input: { path: 'src' } },
          { tool_use_id: 't4', tool: 'NotebookEdit', input: { notebook_path: 'nb.ipynb' } },
        ],
      }),
      message('assistant', '', {
        toolUses: [
          { tool_use_id: 't5', tool: 'Write', input: { file_path: 'src/b.ts' } },
          { tool_use_id: 't6', tool: 'Read', input: { file_path: 'src/b.ts' } },
          { tool_use_id: 't7', tool: 'Bash', input: { command: 'ls' } },
        ],
      }),
    ];
    expect(touchedFiles(messages)).toEqual({
      written: ['src/b.ts', 'nb.ipynb'],
      read: ['/r/a.ts'],
      mentioned: ['src/a.ts', 'docs/my notes.md', 'src'],
    });
  });

  it('lists nothing for a conversation without file work', () => {
    expect(touchedFiles([message('user', 'hi')])).toEqual({ written: [], read: [], mentioned: [] });
  });
});

describe('summaryInstructions', () => {
  it('states the boundary, the reference and the kept categories', () => {
    expect(summaryInstructions('ship it', { written: [], read: [], mentioned: [] })).toBe(
      'Summarize only this earlier part of the conversation; the newer part stays verbatim after your summary. ' +
        'The user\'s next request: "ship it". Keep what it needs. ' +
        'Keep the goals, constraints, preferences and decisions the user set, and what was done.',
    );
  });

  it('lists the files that are not empty and omits the reference when there is none', () => {
    expect(summaryInstructions('', { written: ['a.ts'], read: [], mentioned: ['b.md'] })).toBe(
      'Summarize only this earlier part of the conversation; the newer part stays verbatim after your summary. ' +
        'Keep the goals, constraints, preferences and decisions the user set, and what was done. ' +
        'Files written: a.ts. Files mentioned: b.md.',
    );
  });

  it('caps each list at 50 entries and counts the rest', () => {
    const written = Array.from({ length: 53 }, (_, i) => `f${i}.ts`);
    const text = summaryInstructions('', { written, read: [], mentioned: [] });
    const shown = written.slice(0, 50).join(', ');
    expect(text.endsWith(`Files written: ${shown}, +3 more.`)).toBe(true);
    expect(text).not.toContain('f50.ts');
  });
});
