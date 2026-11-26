import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { AgentEditor, Workbench, type Prompt, type Grant } from '../src/index';
import { applyEvent } from '../src/core';
import { blankAgent } from '../src/studio/agents';
import { Dialog } from '../src/ui/overlay';
import { fixtureHost, snapshot, message, studio, clickMenu } from './fixtures';

const now = '2026-01-01T00:00:00Z';
const caps = (extra: Record<string, boolean>) => ({ ...snapshot().meta.capabilities, ...extra });
const user = (id: string, text: string, extra = {}) => ({
  ...message(id, text, '你'),
  role: 'user' as const,
  ...extra,
});

async function openA(host: ReturnType<typeof fixtureHost>['host']) {
  render(<Workbench scope={{ key: 'x' }} />, { wrapper: studio(host) });
  fireEvent.click(await screen.findByText('a'));
  await screen.findByLabelText('消息');
}

const field = (key: string, type: 'integer' | 'boolean', value: unknown) => ({
  key,
  label: key,
  type,
  description: '',
  default: value,
  required: false,
  enum: [],
  children: [],
  itemSchema: null,
  advanced: false,
});
// The engine catalog entry the editor reads its defaults from. / 编辑页读取默认值的引擎插件目录。
const sessionsPlugin = {
  name: 'sessions',
  displayName: '会话操作',
  description: '',
  version: '1',
  kind: 'plugin',
  managed: true,
  fields: [
    field('max_active', 'integer', 16),
    field('max_depth', 'integer', 3),
    field('allow_create', 'boolean', true),
    field('allow_operate', 'boolean', true),
    field('cross_agent', 'boolean', true),
  ],
};
it('agent editor offers the session-operations switch and wake-up limit', async () => {
  const { host } = fixtureHost();
  const create = vi.fn(async (body: unknown) => ({ id: 'x', ...(body as object) }));
  const c = {
    ...host,
    agents: { list: vi.fn(async () => [{ id: 'intel', name: '情报分析助手' }]), create, update: vi.fn() },
    plugins: vi.fn(async () => [sessionsPlugin]),
    providers: { list: vi.fn(async () => []) },
    skills: { list: vi.fn(async () => []) },
    knowledge: { list: vi.fn(async () => []) },
    graphs: { list: vi.fn(async () => []) },
    mcp: { list: vi.fn(async () => []) },
    validateAgent: vi.fn(async () => ({ ok: true, errors: [], yaml: '' })),
  };
  render(
    <Dialog open>
      <AgentEditor initial={blankAgent} onDone={vi.fn()} />
    </Dialog>,
    { wrapper: studio(c as never) },
  );
  fireEvent.change(screen.getByLabelText(/名称/), { target: { value: '写周报' } });
  fireEvent.mouseDown(screen.getByRole('tab', { name: '运行参数' }));
  expect(screen.queryByLabelText('自动唤醒上限')).toBeNull();
  fireEvent.click(await screen.findByRole('switch', { name: '允许操作其他会话' }));
  fireEvent.change(await screen.findByLabelText('自动唤醒上限'), { target: { value: '3' } });
  const active = (await screen.findByLabelText('同时运行的派发会话')) as HTMLInputElement;
  await waitFor(() => expect(active.value).toBe('16')); // engine default / 引擎默认值
  fireEvent.change(active, { target: { value: '2' } });
  fireEvent.click(screen.getByRole('switch', { name: '允许访问其他 Agent 的会话' }));
  fireEvent.click(screen.getByRole('button', { name: '添加授权' }));
  fireEvent.click(screen.getByRole('button', { name: '添加授权' }));
  await screen.findAllByRole('option', { name: '情报分析助手 的全部会话' });
  fireEvent.change(screen.getByLabelText('授权目标 2'), { target: { value: 'intel' } });
  fireEvent.change(screen.getByLabelText('授权级别 2'), { target: { value: 'operate' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: expect.objectContaining({
          sessionOperations: true,
          maxWakeups: 3,
          sessionGrants: [
            { target: '*', level: 'read' },
            { target: 'intel', level: 'operate' },
          ],
        }),
        plugins: expect.objectContaining({
          sessions: { enabled: true, config: { max_active: 2, cross_agent: false } },
        }),
      }),
    ),
  );
});

it('session_access prompt shows three choices and sends the chosen scope', async () => {
  const { host } = fixtureHost();
  const prompt: Prompt = {
    id: 'p1',
    order: 1,
    status: 'pending',
    createdAt: now,
    kind: 'session_access',
    level: 'read',
    targetSessionId: 'b',
    targetTitle: '客户访谈',
    targetAgentId: 'analyst',
    targetAgentName: '情报分析助手',
    targetScope: 'local',
  };
  host.snapshot = vi.fn(async () => ({
    ...snapshot('a'),
    meta: { ...snapshot('a').meta, status: 'running', capabilities: caps({ respond: true }) },
    prompts: [prompt],
  }));
  await openA(host);
  const card = await screen.findByRole('region', { name: '会话授权' });
  expect(within(card).getByText(/读取会话「客户访谈」/)).toBeTruthy();
  for (const [name, choice] of [
    ['仅这个会话', 'session'],
    ['该 Agent 的全部会话', 'agent'],
    ['拒绝', 'deny'],
  ] as const) {
    fireEvent.click(within(card).getByRole('button', { name }));
    await waitFor(() =>
      expect(host.command).toHaveBeenCalledWith(expect.anything(), {
        type: 'respond',
        promptId: 'p1',
        choice,
      }),
    );
  }
});

it('editing a user message previews the impact, confirms and resends', async () => {
  const { host } = fixtureHost();
  host.snapshot = vi.fn(async () => ({
    ...snapshot('a'),
    meta: { ...snapshot('a').meta, status: 'completed', capabilities: caps({ editMessage: true }) },
    messages: [
      user('1', '第一轮', { startsRun: true, rewindable: true, runId: 'r1' }),
      message('2', '回答'),
      user('3', '旧消息', { startsRun: true, runId: 'r0' }),
    ],
  }));
  host.command = vi.fn(async (_r, c) =>
    c.type === 'editPreview' ? { preview: { messages: 4, branches: 1, sessions: 2 } } : {},
  );
  await openA(host);
  expect(screen.getAllByRole('button', { name: '编辑' })).toHaveLength(1); // not rewindable: no button
  fireEvent.click(screen.getByRole('button', { name: '编辑' }));
  fireEvent.change(await screen.findByLabelText('编辑内容'), { target: { value: '改过的第一轮' } });
  fireEvent.click(screen.getByRole('button', { name: '重新发送' }));
  expect(await screen.findByText('将删除 4 条消息，归档 1 个分支和 2 个派生会话')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '确认发送' }));
  await waitFor(() =>
    expect(host.command).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'editMessage', messageId: '1', text: '改过的第一轮', attachments: [] }),
    ),
  );
});

it('remove events drop items by id', () => {
  const s = { ...snapshot('a'), messages: [message('1', 'a'), message('2', 'b')] };
  const next = applyEvent(s, { seq: 2, kind: 'remove', value: { messages: ['2'] } });
  expect(next.messages.map((m) => m.id)).toEqual(['1']);
});

it('notices render as system cards, held notices offer continue, session tools render as cards', async () => {
  const { host, subscriptions } = fixtureHost();
  const sidebar = host.list;
  host.list = vi.fn(async (kind, scope, filter, signal) =>
    filter.agentId === ''
      ? [snapshot('a').meta, { ...snapshot('b').meta, title: '客户访谈', status: 'running' }]
      : sidebar(kind, scope, filter, signal),
  );
  const notice = {
    ...user(
      '2',
      '后台会话「客户访谈」（情报分析助手）已完成。\n改好了\n除非你继续给它发消息，否则它不会再做别的事。',
    ),
    actor: '后台会话通知',
    kind: 'notice' as const,
    held: true,
    sourceSessionId: 'b',
  };
  const tool = {
    ...message('3', ''),
    parts: [
      {
        id: 't',
        kind: 'tool' as const,
        title: 'session_send',
        status: 'completed',
        text: JSON.stringify({ session_id: 'b', accepted: true, message_id: 'm' }),
      },
    ],
  };
  host.snapshot = vi.fn(async (r) =>
    r.id === 'a'
      ? {
          ...snapshot('a'),
          meta: {
            ...snapshot('a').meta,
            status: 'completed',
            autoWakeups: 3,
            maxWakeups: 3,
            capabilities: caps({ wake: true }),
          },
          messages: [user('1', '开始'), notice, tool],
        }
      : snapshot(r.id),
  );
  await openA(host);
  const card = await screen.findByRole('region', { name: '后台会话通知' });
  expect(within(card).getByText('后台会话「客户访谈」（情报分析助手）已完成。')).toBeTruthy();
  expect(within(card).getByText('等待继续')).toBeTruthy();
  expect(screen.queryByText('你', { selector: 'span:not(.sr-only)' })).toBeNull();
  const limit = screen.getByRole('region', { name: '自动唤醒已达上限' });
  expect(within(limit).getByText(/3\/3/)).toBeTruthy();
  fireEvent.click(within(limit).getByRole('button', { name: '继续' }));
  await waitFor(() => expect(host.command).toHaveBeenCalledWith(expect.anything(), { type: 'wake' }));
  const toolCard = document.querySelector('[data-session-tool="session_send"]') as HTMLElement;
  expect(within(toolCard).getByText('发消息给会话')).toBeTruthy();
  expect(within(toolCard).getByText('已接收')).toBeTruthy();
  // Target title and live status come from the conversation list. / 目标标题与实时状态来自会话列表。
  expect(await within(toolCard).findByText('客户访谈')).toBeTruthy();
  expect(within(toolCard).getByLabelText('目标会话状态').textContent).toBe('运行中');
  expect(within(card).getByLabelText('目标会话状态').textContent).toBe('运行中');
  fireEvent.click(within(toolCard).getByRole('button', { name: '打开' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'b' })).toBeTruthy());
  expect(subscriptions.has('b')).toBe(true);
});

it('conversation info lists grants and revokes them', async () => {
  const { host } = fixtureHost();
  const grants: Grant[] = [
    {
      id: 'g1',
      targetType: 'session',
      targetId: 'b',
      targetTitle: '客户访谈',
      level: 'read',
      decision: 'granted',
      reason: 'user',
      createdAt: now,
    },
    {
      id: 'g2',
      targetType: 'agent',
      targetId: 'x',
      targetTitle: '情报分析助手',
      level: 'operate',
      decision: 'granted',
      reason: 'user',
      createdAt: now,
    },
  ];
  host.snapshot = vi.fn(async () => ({
    ...snapshot('a'),
    meta: { ...snapshot('a').meta, capabilities: caps({ grants: true }) },
  }));
  host.command = vi.fn(async (_r, c) => (c.type === 'listGrants' ? { grants } : {}));
  await openA(host);
  act(() => clickMenu('会话操作'));
  fireEvent.click(await screen.findByRole('menuitem', { name: '会话信息' }));
  const list = await screen.findByRole('region', { name: '会话授权' });
  expect(await within(list).findByText('会话「客户访谈」')).toBeTruthy();
  expect(within(list).getByText('Agent「情报分析助手」的全部会话')).toBeTruthy();
  fireEvent.click(within(list).getByRole('button', { name: '撤销 客户访谈' }));
  await waitFor(() =>
    expect(host.command).toHaveBeenCalledWith(expect.anything(), { type: 'revokeGrant', grantId: 'g1' }),
  );
});
