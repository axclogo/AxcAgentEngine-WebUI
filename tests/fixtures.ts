import { vi } from 'vitest';
import { noCapabilities, type Host, type Snapshot, type ResourceEvent } from '../src/core';
export const definition = {
  name: '任务 A',
  mode: 'discussion' as const,
  objective: '目标',
  topic: '议题',
  background: '背景',
  persona: '',
  agents: ['analyst'],
  maxRounds: 1,
  maxSteps: 1,
  redObjective: '',
  blueObjective: '',
};
export const message = (id = '1', text = '内容', actor = 'analyst') => ({
  id,
  order: Number(id) || 1,
  role: 'assistant' as const,
  actor,
  text,
  kind: 'chat' as const,
  createdAt: '2026-01-01T00:00:00Z',
});
export const snapshot = (id = 'a'): Snapshot => ({
  seq: 1,
  meta: {
    id,
    title: id,
    agentId: 'analyst',
    status: 'idle',
    runId: null,
    source: '',
    creator: '测试用户',
    round: 0,
    capabilities: {
      ...noCapabilities,
      send: true,
      start: true,
      interview: true,
      report: true,
      delete: true,
      edit: true,
    },
    checkpoints: [],
    definition,
  },
  messages: [],
  activities: [],
  queue: [],
  report: null,
});
export const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
export function fixtureHost() {
  const subscriptions = new Map<
    string,
    { receive: (e: ResourceEvent) => void; reconnect: () => void; error: (e: Error) => void }
  >();
  const off = vi.fn();
  const host: Host = {
    catalog: vi.fn(async () => ({
      agents: [{ id: 'analyst', name: '分析师' }],
      defaultAgentId: 'analyst',
      create: true,
      createSimulation: true,
    })),
    list: vi.fn(async () => [snapshot('a').meta, snapshot('b').meta]),
    snapshot: vi.fn(async (r) => snapshot(r.id)),
    subscribe: vi.fn((r, receive, reconnect, error) => {
      subscriptions.set(r.id, { receive, reconnect, error });
      return off;
    }),
    command: vi.fn(async () => ({})),
    create: vi.fn(async () => snapshot('new').meta),
    saveSimulation: vi.fn(async () => snapshot().meta),
  };
  return { host, subscriptions, off };
}

import * as React from 'react';
import { StudioProvider } from '../src/provider';
import type { StudioClient } from '../src/client';
/** Wrap SDK components for tests; only conversation methods are needed. / 测试用包装。 */
export const studio = (host: Host, extra: Partial<React.ComponentProps<typeof StudioProvider>> = {}) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(StudioProvider, {
      client: host as unknown as StudioClient,
      ...extra,
      children,
    });
  };
export function clickMenu(name: string) {
  // Radix menus open on pointerdown/keyboard; Enter works the same in jsdom. / Radix 菜单在 jsdom 中用键盘打开。
  const { fireEvent, screen } = require('@testing-library/react');
  const trigger = screen.getByRole('button', { name });
  fireEvent.keyDown(trigger, { key: 'Enter' });
}
