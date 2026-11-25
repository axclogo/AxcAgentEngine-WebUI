import { describe, it, expect } from 'vitest';
import {
  ResourceStore,
  applyEvent,
  definitionSchema,
  modes,
  resourceKey,
  eventSchema,
  snapshotSchema,
} from '../src/core';
import { snapshot, message, definition } from './fixtures';
describe('authoritative merge', () => {
  it('replays live events over a late snapshot, dedupes HTTP/WS and orders roles', () => {
    const store = new ResourceStore();
    store.event({ seq: 3, kind: 'message', value: message('2', 'second', 'B') });
    store.event({ seq: 2, kind: 'message', value: message('1', 'first', 'A') });
    expect(store.value).toBeNull();
    store.snapshot(snapshot());
    expect(store.value!.messages.map((m) => m.actor)).toEqual(['A', 'B']);
    store.event({ seq: 3, kind: 'message', value: message('2', 'wrong') });
    store.snapshot({ ...snapshot(), seq: 2, messages: [message('1', 'first', 'A')] });
    store.snapshot(snapshot());
    expect(store.value!.messages.map((m) => m.text)).toEqual(['first', 'second']);
    store.event({ seq: 1, kind: 'message', value: message('9') });
    store.event({ seq: 4, kind: 'message', value: message('2', 'updated', 'B') });
    expect(store.value!.messages).toHaveLength(2);
    expect(store.value!.messages[1].text).toBe('updated');
  });
  it('merges only confirmed queue, progress, report and state', () => {
    let s = snapshot();
    s = applyEvent(s, {
      seq: 2,
      kind: 'activity',
      value: { id: 'step', order: 1, kind: 'step', title: '并发步骤', status: 'running', detail: 'x' },
    });
    s = applyEvent(s, { seq: 3, kind: 'activity', value: { ...s.activities[0], status: 'completed' } });
    s = applyEvent(s, {
      seq: 4,
      kind: 'queue',
      value: { id: 'request', order: 1, text: '插话', status: 'cancel_requested' },
    });
    s = applyEvent(s, { seq: 5, kind: 'report', value: 'report' });
    s = applyEvent(s, { seq: 6, kind: 'meta', value: { ...s.meta, status: 'failed' } });
    expect(s.activities).toHaveLength(1);
    expect(s.meta.status).toBe('failed');
    expect(s.report).toBe('report');
    expect(s.queue[0].status).toBe('cancel_requested');
  });
  it('isolates namespaces and scope', () => {
    expect(
      new Set(
        ['conversation', 'simulation'].flatMap((kind) =>
          ['a', 'b'].map((key) => resourceKey({ kind: kind as 'conversation', scope: { key }, id: '1' })),
        ),
      ).size,
    ).toBe(4);
  });
  it('validates unknown network input', () => {
    expect(() => snapshotSchema.parse({})).toThrow();
    expect(() => eventSchema.parse({ seq: 0, kind: 'report', value: null })).toThrow();
    expect(snapshotSchema.parse(snapshot())).toEqual(snapshot());
  });
});
describe('ten mode parity', () => {
  for (const [mode, min] of Object.entries(modes))
    it(`${mode} participant and 1–200 boundaries`, () => {
      const d = {
        ...definition,
        mode,
        agents: Array.from({ length: min }, (_, i) => String(i)),
        redObjective: '红方',
        blueObjective: '蓝方',
      };
      expect(definitionSchema.safeParse(d).success).toBe(true);
      expect(definitionSchema.safeParse({ ...d, agents: d.agents.slice(1) }).success).toBe(false);
      expect(definitionSchema.safeParse({ ...d, agents: ['a', 'a'] }).success).toBe(false);
      for (const n of [0, 201, 1.5])
        expect(definitionSchema.safeParse({ ...d, maxRounds: n, maxSteps: n }).success).toBe(false);
      expect(definitionSchema.safeParse({ ...d, maxRounds: 200, maxSteps: 200 }).success).toBe(true);
    });
  it('requires red-blue objectives and text', () => {
    expect(definitionSchema.safeParse({ ...definition, name: ' ' }).success).toBe(false);
    expect(definitionSchema.safeParse({ ...definition, mode: 'redblue', agents: ['a', 'b'] }).success).toBe(
      false,
    );
  });
});
