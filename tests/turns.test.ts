import { describe, expect, it } from 'vitest';
import { decideTurns, dropTurns, segmentTurns, turnQuestions } from '../src/turns.js';
import type { Message, Turn, TurnDecision } from '../src/types.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

const reload =
  '<command-name>/reload-plugins</command-name>\n<command-message>reload-plugins</command-message>\n<command-args></command-args>';

function turn(id: string, start: number, end: number, candidate = true, request = `request ${id}`): Turn {
  return { id, start, end, request, candidate };
}

function decision(id: string, start: number, end: number, dropped: boolean, request = `req ${id}`): TurnDecision {
  return { id, start, end, request, after: 0, dropped };
}

describe('segmentTurns', () => {
  it('starts turns at requests and skips command echoes and tool results', () => {
    const messages = [
      message('assistant', 'hello before any request'),
      message('user', 'Fix the parser test.'),
      message('assistant', 'Done.'),
      message('user', reload),
      message('user', '<local-command-stdout>Reloaded: 12 plugins</local-command-stdout>'),
      message('assistant', '', { toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'ls' } }] }),
      message('user', 'ok', { toolResults: [{ tool_use_id: 't1', text: 'ok' }] }),
      message('user', 'now add docs'),
    ];
    const turns = segmentTurns(messages, 0);
    expect(turns).toEqual([
      { id: 'T01', start: 1, end: 7, request: 'Fix the parser test.', candidate: true },
      { id: 'T02', start: 7, end: 8, request: 'now add docs', candidate: false },
    ]);
  });

  it('pins the turns holding preserved messages and the last turn', () => {
    const messages = [
      message('user', 'first'),
      message('assistant', 'a'),
      message('user', 'second'),
      message('assistant', 'b'),
      message('user', 'third'),
    ];
    const turns = segmentTurns(messages, 1);
    expect(turns.map((t) => [t.id, t.candidate])).toEqual([
      ['T01', false],
      ['T02', true],
      ['T03', false],
    ]);
    expect(segmentTurns(messages, 4).map((t) => t.candidate)).toEqual([false, false, false]);
  });

  it('caps the request at 200 characters', () => {
    const turns = segmentTurns([message('user', 'x'.repeat(300))], 0);
    expect(turns[0]!.request).toHaveLength(200);
  });
});

describe('turnQuestions', () => {
  it('asks nothing with fewer than two turns', () => {
    expect(turnQuestions([turn('T01', 0, 2)])).toEqual({});
  });

  it('asks nothing without candidates', () => {
    expect(turnQuestions([turn('T01', 0, 2, false), turn('T02', 2, 4, false)])).toEqual({});
  });

  it('asks the topic choice and one lasting question per candidate', () => {
    const questions = turnQuestions([
      turn('T01', 0, 2, true, 'first'),
      turn('T02', 2, 4, false, 'second'),
      turn('T03', 4, 5, false, 'third'),
    ]);
    expect(Object.keys(questions)).toEqual(['topic_start', 'lasting_T01']);
    expect(questions.topic_start).toMatchObject({
      type: 'choice',
      criteria: { T01: 'first', T02: 'second', T03: 'third' },
    });
    const lasting = questions.lasting_T01!;
    expect(lasting.type).toBe('noul');
    expect(JSON.stringify(lasting)).not.toContain('{id}');
    expect(lasting.instructions).toContain('In turn T01');
    expect(lasting.criteria?.true).toContain('T01');
  });

  it('asks nothing when the turns exceed the choice options', () => {
    const turns = Array.from({ length: 256 }, (_, n) => turn(`T${n}`, n, n + 1));
    expect(turnQuestions(turns)).toEqual({});
  });
});

describe('decideTurns', () => {
  const turns = [turn('T01', 0, 2), turn('T02', 2, 4), turn('T03', 4, 5, false)];
  const thresholds = { topicThreshold: 0.8, lastingThreshold: 0.3 };

  it('drops a candidate that the later work does not build on and that does not last', () => {
    const decisions = decideTurns(
      turns,
      {
        topic_start: { type: 'choice', choice: 'T03', confidence: 0.9, probabilities: { T01: 0.1, T02: 0.2, T03: 0.7 } },
        lasting_T01: { type: 'noul', noul: 0.1 },
        lasting_T02: { type: 'noul', noul: 0.1 },
      },
      thresholds,
    );
    expect(decisions.map((d) => [d.id, d.after, d.dropped])).toEqual([
      ['T01', expect.closeTo(0.9), true],
      ['T02', expect.closeTo(0.7), false],
      ['T03', 0, false],
    ]);
    expect(decisions[2]!.lasting).toBeUndefined();
  });

  it('applies the thresholds inclusively on topic and exclusively on lasting', () => {
    const answers = (after: number, lasting: number) => ({
      topic_start: { type: 'choice' as const, choice: 'T02', confidence: 1, probabilities: { T01: 1 - after, T02: after } },
      lasting_T01: { type: 'noul' as const, noul: lasting },
    });
    expect(decideTurns([turn('T01', 0, 2), turn('T02', 2, 3, false)], answers(0.8, 0.29), thresholds)[0]!.dropped).toBe(true);
    expect(decideTurns([turn('T01', 0, 2), turn('T02', 2, 3, false)], answers(0.8, 0.3), thresholds)[0]!.dropped).toBe(false);
    expect(decideTurns([turn('T01', 0, 2), turn('T02', 2, 3, false)], answers(0.79, 0.1), thresholds)[0]!.dropped).toBe(false);
  });

  it('drops nothing when the topic answer is missing', () => {
    const decisions = decideTurns(turns, { lasting_T01: { type: 'noul', noul: 0 } }, thresholds);
    expect(decisions.map((d) => [d.after, d.dropped])).toEqual([
      [0, false],
      [0, false],
      [0, false],
    ]);
  });
});

describe('engine notices', () => {
  it('never opens a turn on "Tool loaded."', () => {
    const turns = segmentTurns(
      [message('user', 'req A'), message('assistant', 'a1'), message('user', 'Tool loaded.'), message('user', 'req B')],
      0,
    );
    expect(turns.map((t) => [t.request, t.start, t.end])).toEqual([
      ['req A', 0, 3],
      ['req B', 3, 4],
    ]);
  });
});

describe('dropTurns', () => {
  const messages = [
    message('user', 'req A'),
    message('assistant', 'a1'),
    message('user', 'req B'),
    message('assistant', 'b1'),
    message('user', 'req C'),
    message('assistant', 'c1'),
    message('user', 'req D'),
    message('assistant', 'd1'),
  ];

  it('merges an earlier placeholder into the new one instead of nesting it', () => {
    const earlier =
      '[fast-jev-compaction removed 1 earlier turn(s) whose topic the current work no longer needs. Their requests: "req 0"]';
    const history = [
      message('user', 'req A'),
      message('assistant', 'a1'),
      message('user', earlier),
      message('user', 'req B'),
      message('assistant', 'b1'),
      message('user', 'req C'),
    ];
    const turns = segmentTurns(history, 0);
    expect(turns.map((t) => t.request)).toEqual(['req A', 'req B', 'req C']);
    const out = dropTurns(history, [
      decision('T01', 0, 3, false, 'req A'),
      decision('T02', 3, 5, true, 'req B'),
      decision('T03', 5, 6, false, 'req C'),
    ]);
    expect(out.map((m) => m.text)).toEqual([
      'req A',
      'a1',
      '[fast-jev-compaction removed 2 earlier turn(s) whose topic the current work no longer needs. Their requests: "req 0"; "req B"]',
      'req C',
    ]);
  });

  it('keeps an old placeholder when the turn it sits in is removed', () => {
    const earlier =
      '[fast-jev-compaction removed 1 earlier turn(s) whose topic the current work no longer needs. Their requests: "req 0"]';
    const history = [message('user', 'req A'), message('user', earlier), message('user', 'req B')];
    const out = dropTurns(history, [decision('T01', 0, 2, true, 'req A'), decision('T02', 2, 3, false, 'req B')]);
    expect(out.map((m) => m.text)).toEqual([
      '[fast-jev-compaction removed 2 earlier turn(s) whose topic the current work no longer needs. Their requests: "req A"; "req 0"]',
      'req B',
    ]);
  });

  it('leaves one placeholder for two adjacent dropped turns and keeps the other messages as they are', () => {
    const out = dropTurns(messages, [
      decision('T01', 0, 2, true, 'req A'),
      decision('T02', 2, 4, true, 'req B'),
      decision('T03', 4, 6, false, 'req C'),
      decision('T04', 6, 8, false, 'req D'),
    ]);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({
      role: 'user',
      text: '[fast-jev-compaction removed 2 earlier turn(s) whose topic the current work no longer needs. Their requests: "req A"; "req B"]',
      toolUses: [],
    });
    expect(out[1]).toBe(messages[4]);
    expect(out[2]).toBe(messages[5]);
    expect(out[3]).toBe(messages[6]);
    expect(out[4]).toBe(messages[7]);
  });

  it('leaves one placeholder per run of dropped turns separated by kept turns', () => {
    const out = dropTurns(messages, [
      decision('T01', 0, 2, true, 'req A'),
      decision('T02', 2, 4, false, 'req B'),
      decision('T03', 4, 6, true, 'req C'),
      decision('T04', 6, 8, false, 'req D'),
    ]);
    expect(out).toHaveLength(6);
    expect(out[0]!.text).toContain('removed 1 earlier turn(s)');
    expect(out[0]!.text).toContain('Their requests: "req A"]');
    expect(out[1]).toBe(messages[2]);
    expect(out[2]).toBe(messages[3]);
    expect(out[3]!.text).toContain('Their requests: "req C"]');
    expect(out[4]).toBe(messages[6]);
    expect(out[5]).toBe(messages[7]);
  });

  it('returns the same messages when nothing is dropped', () => {
    const out = dropTurns(messages, [decision('T01', 0, 8, false)]);
    expect(out).toHaveLength(messages.length);
    out.forEach((m, i) => expect(m).toBe(messages[i]));
  });
});
