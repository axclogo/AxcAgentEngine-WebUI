import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const packageRequire = createRequire(import.meta.resolve('@axc/agent-workbench'));
const primitivesRequire = createRequire(packageRequire.resolve('@assistant-ui/react'));
assert.equal(packageRequire.resolve('react'), require.resolve('react'));
assert.equal(primitivesRequire.resolve('react'), require.resolve('react'));
assert.equal(packageRequire.resolve('react-dom'), require.resolve('react-dom'));
assert.ok(
  readFileSync(new URL(import.meta.resolve('@axc/agent-workbench/styles.css')), 'utf8').includes('.axc-root'),
);
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost',
});
for (const key of [
  'window',
  'document',
  'HTMLElement',
  'Element',
  'Node',
  'MutationObserver',
  'getComputedStyle',
  'HTMLTextAreaElement',
  'HTMLInputElement',
  'navigator',
  'DocumentFragment',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  'CustomEvent',
])
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollTo = () => {};
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
Element.prototype.scrollIntoView = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const { Workbench, SimulationDetail, SimulationManager, StudioProvider } = await import(
  '@axc/agent-workbench'
);
// Same module instance the SDK resolves. / 与 SDK 解析到的是同一个模块实例。
const { QueryClient } = await import(
  new URL(import.meta.resolve('@tanstack/react-query', import.meta.resolve('@axc/agent-workbench'))).href
);
const { noCapabilities } = await import('@axc/agent-workbench/core');
const caps = { ...noCapabilities, send: true };
const meta = {
  id: '1',
  title: '安装验证',
  status: 'idle',
  runId: null,
  agentId: 'agent',
  source: '',
  creator: 'test',
  round: 0,
  capabilities: caps,
  checkpoints: [],
  definition: {
    name: '推演',
    mode: 'discussion',
    objective: '验证',
    topic: '验证',
    background: '',
    persona: '',
    agents: ['agent'],
    maxRounds: 1,
    maxSteps: 1,
    redObjective: '',
    blueObjective: '',
  },
};
let subscriptions = 0,
  unsubscriptions = 0;
const host = {
  catalog: async () => ({
    agents: [{ id: 'agent', name: 'Agent' }],
    defaultAgentId: 'agent',
    create: true,
    createSimulation: true,
  }),
  list: async () => [meta],
  snapshot: async () => ({ seq: 1, meta, messages: [], activities: [], queue: [], report: null }),
  subscribe: () => {
    subscriptions++;
    return () => unsubscriptions++;
  },
  command: async () => ({}),
  create: async () => meta,
  saveSimulation: async () => meta,
};
const root = createRoot(document.getElementById('root')),
  scope = { key: 'test' };
// Own the QueryClient so its garbage-collection timers can be cleared; otherwise Node never exits.
// 自己持有 QueryClient，结束时清掉它的回收计时器，否则 Node 进程不会退出。
const queryClient = new QueryClient();
const wrap = (child) => React.createElement(StudioProvider, { client: host, queryClient }, child);
for (const width of [1200, 560]) {
  await act(async () => {
    root.render(
      React.createElement(
        'div',
        { style: { height: 600, width } },
        wrap(React.createElement(Workbench, { scope })),
      ),
    );
  });
  const find = () => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('安装验证'));
  for (let i = 0; i < 50 && !find(); i++) await act(() => new Promise((r) => setTimeout(r, 20)));
  const button = find();
  assert.ok(button);
  await act(async () => button.click());
  await (async () => {
    for (let i = 0; i < 50 && !document.querySelector('[aria-label="消息"]'); i++)
      await act(() => new Promise((r) => setTimeout(r, 20)));
  })();
  assert.ok(document.querySelector('[aria-label="消息"]'));
  await act(async () => root.render(null));
}
await act(async () => root.render(wrap(React.createElement(SimulationManager, { scope }))));
const settle = async (ok) => {
  for (let i = 0; i < 50 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 20)));
  assert.ok(ok());
};
await settle(() => [...document.querySelectorAll('button')].some((b) => b.textContent === '安装验证'));
await act(async () =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === '安装验证').click(),
);
await settle(() => document.querySelector('[aria-label="推演详情"]'));
await act(async () =>
  root.render(wrap(React.createElement(SimulationDetail, { scope, taskId: '1', readOnly: true }))),
);
await settle(() => document.body.textContent.includes('尚未生成'));
await act(async () => root.unmount());
queryClient.clear();
assert.equal(subscriptions, unsubscriptions);
console.log(
  `React ${React.version}: installed page/drawer/manager/standalone detail passed; ${subscriptions} subscriptions detached`,
);
