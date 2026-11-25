// A business host page embedding SDK surfaces: a topic drawer (Workbench) and a standalone simulation panel.
// 宿主业务页嵌入示例：专题抽屉（Workbench）与独立推演详情。
import { useState } from 'react';
import {
  StudioProvider,
  Workbench,
  SimulationDetail,
  SafeLink,
  type StudioClient,
  type LinkProps,
} from '../src/index';

// The host owns entity links, permissions and in-app drawers. / 实体链接、权限与站内抽屉由宿主负责。
export function BusinessLink({ href, children }: LinkProps) {
  if (href.startsWith('raven-ref:')) return <span title="示例宿主未授予实体详情权限">{children}</span>;
  return <SafeLink href={href}>{children}</SafeLink>;
}
const topics = [
  { id: 1, name: '专题 A · 新品发布舆情' },
  { id: 2, name: '专题 B · 竞品价格监测' },
];
const s = {
  page: {
    fontFamily: 'system-ui, sans-serif',
    padding: 24,
    maxWidth: 960,
    margin: '0 auto',
    color: '#1f2a2e',
  },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const, margin: '12px 0' },
  drawer: (width: number) => ({
    position: 'fixed' as const,
    top: 0,
    right: 0,
    bottom: 0,
    width: `min(${width}px, 100vw)`,
    display: 'flex',
    flexDirection: 'column' as const,
    background: '#fff',
    boxShadow: '0 0 0 100vmax rgba(0,0,0,.3)',
    zIndex: 10,
  }),
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    height: 44,
    padding: '0 8px 0 16px',
    borderBottom: '1px solid #e3e7e4',
    fontWeight: 600,
    fontSize: 14,
  },
};

export function EmbedExamples({ client }: { client: StudioClient }) {
  const [topic, setTopic] = useState(1);
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(720);
  const [taskId, setTaskId] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const current = topics.find((t) => t.id === topic)!;
  return (
    <div style={s.page}>
      <p>
        <a href="/">← 返回 Agent Studio</a>
      </p>
      <h1 style={{ fontSize: 22 }}>宿主业务页</h1>
      <p style={{ color: '#5d6b6d' }}>
        同一个安装包：整页工坊、嵌在业务页里的专题抽屉，以及其他服务里的推演详情。SDK 样式限定在 .axc-root
        内，不影响本页。
      </p>
      <h2 style={{ fontSize: 16, marginTop: 28 }}>专题抽屉</h2>
      <div style={s.row}>
        <select aria-label="专题" value={topic} onChange={(e) => setTopic(Number(e.target.value))}>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select aria-label="抽屉宽度" value={width} onChange={(e) => setWidth(Number(e.target.value))}>
          {[390, 720, 960].map((w) => (
            <option key={w} value={w}>
              抽屉 {w}px
            </option>
          ))}
        </select>
        <button onClick={() => setOpen(true)}>AI 分析</button>
      </div>
      {open && (
        <section
          role="dialog"
          aria-modal="true"
          aria-label={`${current.name} · AI 分析`}
          style={s.drawer(width)}
        >
          <header style={s.bar}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {current.name}
            </span>
            <button
              aria-label="关闭抽屉"
              title="关闭"
              onClick={() => setOpen(false)}
              style={{ border: 0, background: 'none', fontSize: 18, cursor: 'pointer' }}
            >
              ✕
            </button>
          </header>
          <div style={{ flex: 1, minHeight: 0 }}>
            <StudioProvider client={client} Link={BusinessLink}>
              <Workbench
                scope={{
                  key: `topic:${topic}`,
                  shortcut: { shortcut_key: 'example.topic', context: { topic_id: topic } },
                }}
              />
            </StudioProvider>
          </div>
        </section>
      )}
      <h2 style={{ fontSize: 16, marginTop: 28 }}>其他服务 · 独立推演详情</h2>
      <div style={s.row}>
        <label>
          任务标识 <input value={taskId} onChange={(e) => setTaskId(e.target.value)} />
        </label>
        <label>
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          只读展示（服务端仍须独立鉴权）
        </label>
      </div>
      {taskId && (
        <div style={{ height: 640, border: '1px solid #e3e7e4', borderRadius: 12, overflow: 'hidden' }}>
          <StudioProvider client={client} Link={BusinessLink}>
            <SimulationDetail scope={{ key: 'local' }} taskId={taskId} readOnly={readOnly} />
          </StudioProvider>
        </div>
      )}
    </div>
  );
}
