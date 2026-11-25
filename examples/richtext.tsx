import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Markdown,
  Workbench,
  StudioProvider,
  type Host,
  type LinkProps,
  type StudioClient,
} from '../src/index';
import { noCapabilities, type Snapshot, type ResourceEvent } from '../src/core';
import '../src/styles.css';
const scope = { key: 'qa' };
const state: Snapshot = {
  seq: 1,
  meta: {
    id: '1',
    title: '流式阅读',
    status: 'running',
    runId: 'run',
    agentId: 'agent',
    source: '',
    creator: '夹具',
    round: 1,
    capabilities: { ...noCapabilities, insert: true },
    checkpoints: [],
  },
  messages: Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    order: i,
    role: 'assistant',
    actor: 'Agent',
    text: `第 ${i} 条内容\n\n中文历史用于滚动阅读验证。`,
    createdAt: '2026-01-01T00:00:00Z',
    kind: 'chat',
  })),
  activities: [],
  queue: [],
  report: null,
};
const listeners = new Set<(e: ResourceEvent) => void>();
const host: Host = {
  catalog: async () => ({
    agents: [{ id: 'agent', name: 'Agent' }],
    defaultAgentId: 'agent',
    create: false,
    createSimulation: false,
  }),
  list: async () => [state.meta],
  snapshot: async () => state,
  subscribe: (_r, receive) => {
    listeners.add(receive);
    return () => {
      listeners.delete(receive);
    };
  },
  command: async () => ({}),
  create: async () => state.meta,
  saveSimulation: async () => state.meta,
};
const source =
  '## 中文报告\n\n|维度|结果|\n|---|---|\n|引用|[跨块][ref]|\n\n[ref]: https://example.com\n\n[有权引用](https://example.com/entities/2)\n\n```typescript\n' +
  Array.from({ length: 30 }, (_, i) => `const value${i} = "中文";`).join('\n') +
  '\n```\n\n```mermaid\ngraph TD\nA[问题] --> B[证据]\nB --> C[结论]\n```';
function App() {
  const [dark, setDark] = useState(false),
    [opened, setOpened] = useState(false);
  const Link = ({ href, children }: LinkProps) =>
    href.startsWith('https://example.com/entities/') ? (
      <button onClick={() => setOpened(true)}>{children}</button>
    ) : (
      <a href={href}>{children}</a>
    );
  return (
    <StudioProvider
      client={host as StudioClient}
      theme={dark ? 'dark' : 'light'}
      Link={Link}
      className="!h-auto"
    >
      <button onClick={() => setDark(!dark)}>切换主题</button>
      <button
        onClick={() => {
          const m = state.messages[49];
          m.text += '\n\n新增流式段落';
          const e: ResourceEvent = { seq: ++state.seq, kind: 'message', value: { ...m } };
          listeners.forEach((fn) => fn(e));
        }}
      >
        注入增量
      </button>
      {opened && (
        <div role="dialog">
          宿主详情 · 专题 1 / 情报 2<button onClick={() => setOpened(false)}>关闭详情</button>
        </div>
      )}
      <div style={{ height: 500 }}>
        <Workbench scope={scope} />
      </div>
      <section className="qa-richtext" style={{ padding: 24 }}>
        <Markdown text={source} Link={Link} />
        <Markdown text={'```mermaid\nnot-a-valid-diagram # broken\n```'} />
        <Markdown streaming text={'```js\nconst incomplete = "未闭合围栏'} />
      </section>
    </StudioProvider>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
