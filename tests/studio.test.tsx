import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import {
  ArchiveManager,
  ProviderManager,
  AgentEditor,
  Workbench,
  type StudioClient,
  type Provider,
  type Agent,
} from '../src/index';
import { blankAgent } from '../src/studio/agents';
import { Dialog } from '../src/ui/overlay';
import { fixtureHost, snapshot, studio, clickMenu } from './fixtures';

const now = '2026-01-01T00:00:00Z';
const providers: Provider[] = [
  {
    id: 'p1',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyMasked: 'sk-••••abcd',
    hasKey: true,
    enabled: true,
    models: [
      { id: 'gpt-text', label: '', type: 'llm', vision: false, contextWindow: null },
      { id: 'gpt-eye', label: '', type: 'llm', vision: true, contextWindow: null },
      { id: 'img-1', label: '', type: 'image', vision: false, contextWindow: null },
    ],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'p2',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyMasked: '',
    hasKey: false,
    enabled: true,
    models: [{ id: 'deepseek-chat', label: '', type: 'llm', vision: false, contextWindow: null }],
    createdAt: now,
    updatedAt: now,
  },
];
function client() {
  const { host } = fixtureHost();
  const crud = () => ({
    list: vi.fn(async () => []),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  });
  const c = {
    ...host,
    providers: {
      ...crud(),
      list: vi.fn(async () => providers),
      update: vi.fn(async (_id, v) => ({ ...providers[0], ...v })),
      test: vi.fn(),
    },
    plugins: vi.fn(async () => []),
    agents: {
      ...crud(),
      create: vi.fn(
        async (v) => ({ ...v, id: 'new', modelStatus: 'ok', createdAt: now, updatedAt: now }) as Agent,
      ),
      validate: vi.fn(),
      exportUrl: () => '',
    },
    skills: { ...crud(), import: vi.fn() },
    knowledge: {
      ...crud(),
      documents: vi.fn(),
      upload: vi.fn(),
      addText: vi.fn(),
      removeDocument: vi.fn(),
      documentUrl: () => '',
    },
    graphs: {
      ...crud(),
      data: vi.fn(),
      upsertEntity: vi.fn(),
      removeEntity: vi.fn(),
      addRelation: vi.fn(),
      removeRelation: vi.fn(),
      import: vi.fn(),
    },
    evals: {
      ...crud(),
      cases: vi.fn(),
      addCase: vi.fn(),
      removeCase: vi.fn(),
      run: vi.fn(),
      results: vi.fn(),
    },
  };
  return c as unknown as StudioClient & { [k: string]: any };
}

it('providers show only masked keys and an empty key on edit keeps the stored one', async () => {
  const c = client();
  render(<ProviderManager />, { wrapper: studio(c) });
  expect(await screen.findByText('sk-••••abcd')).toBeTruthy();
  expect(screen.getByText('未设置')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
  const key = (await screen.findByLabelText(/API Key/)) as HTMLInputElement;
  expect(key.value).toBe('');
  expect(key.type).toBe('password');
  expect(screen.getByText('已保存 sk-••••abcd，留空保持不变')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() =>
    expect(c.providers.update).toHaveBeenCalledWith('p1', expect.objectContaining({ apiKey: '' })),
  );
});

it('agent model slots cascade provider → model and filter by capability', async () => {
  const c = client();
  const done = vi.fn();
  render(
    <Dialog open>
      <AgentEditor initial={blankAgent} onDone={done} />
    </Dialog>,
    { wrapper: studio(c) },
  );
  fireEvent.change(screen.getByLabelText(/名称/), { target: { value: '分析助手' } });
  fireEvent.mouseDown(screen.getByRole('tab', { name: '模型' }));
  const vision = await screen.findByRole('combobox', { name: '视觉模型' });
  fireEvent.click(vision);
  const list = await screen.findByRole('listbox');
  expect(within(list).getByText('gpt-eye')).toBeTruthy();
  expect(within(list).queryByText('gpt-text')).toBeNull();
  fireEvent.keyDown(vision, { key: 'Escape' });
  fireEvent.click(screen.getByRole('combobox', { name: '主模型' }));
  const main = await screen.findByRole('listbox');
  expect(within(main).getByText('OpenAI')).toBeTruthy();
  expect(within(main).getByText('DeepSeek')).toBeTruthy();
  expect(within(main).queryByText('img-1')).toBeNull();
  fireEvent.click(within(main).getByText('deepseek-chat'));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() =>
    expect(c.agents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '分析助手',
        models: expect.objectContaining({ main: 'p2:deepseek-chat' }),
      }),
    ),
  );
  await waitFor(() => expect(done).toHaveBeenCalled());
});

it('forks nest under their parent at any depth and selecting a deep branch reveals its ancestors', async () => {
  const c = client();
  const m = (id: string, parentId: string | null) => ({
    ...snapshot(id).meta,
    title: `会话 ${id}`,
    parentId,
  });
  c.list = vi.fn(async () => [
    m('root', null),
    m('b1', 'root'),
    m('b2', 'b1'),
    m('b3', 'b2'),
    m('other', null),
  ]);
  c.snapshot = vi.fn(async (r) => ({ ...snapshot(r.id), meta: m(r.id, null) }));
  render(<Workbench scope={{ key: 'x' }} />, { wrapper: studio(c) });
  const tree = await screen.findByRole('tree');
  expect(within(tree).queryByText('会话 b1')).toBeNull();
  fireEvent.click(within(tree).getByRole('button', { name: '展开 会话 root 的 1 个分支' }));
  fireEvent.click(within(tree).getByRole('button', { name: '展开 会话 b1 的 1 个分支' }));
  fireEvent.click(within(tree).getByRole('button', { name: '展开 会话 b2 的 1 个分支' }));
  const deep = within(tree).getByText('会话 b3');
  expect(deep.closest('[role=treeitem]')?.parentElement?.closest('[role=treeitem]')?.textContent).toContain(
    '会话 b2',
  );
  fireEvent.click(within(tree).getByRole('button', { name: '收起 会话 root 的分支' }));
  expect(within(tree).queryByText('会话 b3')).toBeNull();
});

it('list rows archive in one click; archived conversations leave the list', async () => {
  const c = client();
  const caps = { ...snapshot().meta.capabilities, archive: true };
  c.list = vi.fn(async () => [
    { ...snapshot('a').meta, title: '活跃会话', capabilities: caps, archived: false },
    {
      ...snapshot('r').meta,
      title: '运行中会话',
      status: 'running',
      capabilities: { ...caps, archive: false },
      archived: false,
    },
    { ...snapshot('b').meta, title: '旧会话', capabilities: { ...caps, delete: true }, archived: true },
  ]);
  c.command = vi.fn(async () => ({}));
  render(<Workbench scope={{ key: 'x' }} />, { wrapper: studio(c) });
  const tree = await screen.findByRole('tree', { name: '会话' });
  expect(within(tree).queryByText('旧会话')).toBeNull();
  expect(within(tree).queryByRole('button', { name: /^删除/ })).toBeNull();
  // Every row shows the archive action; running ones are visibly disabled instead of missing.
  expect(within(tree).getByRole('button', { name: '归档 运行中会话' }).getAttribute('aria-disabled')).toBe(
    'true',
  );
  fireEvent.click(within(tree).getByRole('button', { name: '归档 运行中会话' }));
  expect(c.command).not.toHaveBeenCalled();
  fireEvent.click(within(tree).getByRole('button', { name: '归档 活跃会话' }));
  await waitFor(() =>
    expect(c.command).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), { type: 'archive' }),
  );
});

it('archive page groups by agent, keeps the fork tree, restores and deletes with confirmation', async () => {
  const c = client();
  c.catalog = vi.fn(async () => ({
    agents: [
      { id: 'analyst', name: '分析师' },
      { id: 'writer', name: '写手' },
    ],
    defaultAgentId: 'analyst',
    create: true,
    createSimulation: true,
  }));
  const m = (id: string, agentId: string, parentId: string | null, archived = true) => ({
    ...snapshot(id).meta,
    title: `会话 ${id}`,
    agentId,
    parentId,
    archived,
    archivedAt: now,
    capabilities: { ...snapshot().meta.capabilities, archive: true, delete: archived },
  });
  c.list = vi.fn(async () => [
    m('p', 'analyst', null),
    m('p1', 'analyst', 'p'),
    m('p2', 'analyst', 'p1'),
    m('w', 'writer', null),
    m('live', 'analyst', null, false),
  ]);
  c.command = vi.fn(async () => ({}));
  render(<ArchiveManager scope={{ key: 'x' }} />, { wrapper: studio(c) });
  expect(await screen.findByText('分析师')).toBeTruthy();
  expect(screen.getByText('写手')).toBeTruthy();
  expect(screen.queryByText('会话 live')).toBeNull();
  const deep = screen.getByText('会话 p2').closest('[role=treeitem]')!;
  expect(deep.parentElement!.closest('[role=treeitem]')!.querySelector('span')!.textContent).toBeDefined();
  expect(deep.parentElement!.closest('[role=treeitem]')!.textContent).toContain('会话 p1');
  fireEvent.click(screen.getByRole('button', { name: '恢复 会话 p' }));
  await waitFor(() =>
    expect(c.command).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }), { type: 'unarchive' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '删除 会话 w' }));
  expect(c.command).not.toHaveBeenCalledWith(expect.anything(), { type: 'delete' });
  fireEvent.click(await screen.findByRole('button', { name: '永久删除' }));
  await waitFor(() =>
    expect(c.command).toHaveBeenCalledWith(expect.objectContaining({ id: 'w' }), { type: 'delete' }),
  );
});

it('fork picker lists replies in plain words instead of engine checkpoint ids', async () => {
  const c = client();
  const meta = {
    ...snapshot('a').meta,
    capabilities: { ...snapshot().meta.capabilities, fork: true },
    checkpoints: [
      { id: 'cp1', label: '3 · step', messageId: 'a2' },
      { id: 'cp2', label: '7 · step', messageId: 'a4' },
    ],
  };
  const msg = (id: string, role: 'user' | 'assistant', text: string) => ({
    ...snapshot().messages[0],
    id,
    order: Number(id.slice(1)),
    role,
    actor: role,
    text,
    kind: 'chat' as const,
    createdAt: now,
  });
  c.snapshot = vi.fn(async () => ({
    ...snapshot('a'),
    meta,
    messages: [
      msg('a1', 'user', '问题一'),
      msg('a2', 'assistant', '回答一'),
      msg('a3', 'user', '问题二'),
      msg('a4', 'assistant', '回答二'),
    ],
  }));
  c.command = vi.fn(async () => ({}));
  render(<Workbench scope={{ key: 'x' }} />, { wrapper: studio(c) });
  fireEvent.click(await screen.findByText('a'));
  await screen.findByText('回答二');
  clickMenu('会话操作');
  fireEvent.click(await screen.findByRole('menuitem', { name: '开分支…' }));
  const list = await screen.findByRole('list', { name: '分叉位置' });
  expect(within(list).queryByText(/step/)).toBeNull();
  expect(within(list).getByText('问：问题一')).toBeTruthy();
  fireEvent.click(within(list).getByText('回答一'));
  await waitFor(() =>
    expect(c.command).toHaveBeenCalledWith(expect.anything(), { type: 'fork', checkpointId: 'cp1' }),
  );
  expect(screen.getAllByRole('button', { name: '从这里开分支' })).toHaveLength(2);
});
