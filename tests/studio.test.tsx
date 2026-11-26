import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import {
  ArchiveManager,
  McpManager,
  MemoryManager,
  ProviderManager,
  AgentEditor,
  Workbench,
  type StudioClient,
  type Provider,
  type Agent,
  type Prompt,
} from '../src/index';
import { blankAgent } from '../src/studio/agents';
import { Dialog } from '../src/ui/overlay';
import { fixtureHost, snapshot, message, studio, clickMenu } from './fixtures';

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
      {
        id: 'gpt-text',
        label: '',
        type: 'llm',
        vision: false,
        contextWindow: null,
        inputPricePer1k: null,
        outputPricePer1k: null,
      },
      {
        id: 'gpt-eye',
        label: '',
        type: 'llm',
        vision: true,
        contextWindow: null,
        inputPricePer1k: null,
        outputPricePer1k: null,
      },
      {
        id: 'emb-1',
        label: '',
        type: 'embedding',
        vision: false,
        contextWindow: null,
        inputPricePer1k: null,
        outputPricePer1k: null,
      },
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
    models: [
      {
        id: 'deepseek-chat',
        label: '',
        type: 'llm',
        vision: false,
        contextWindow: null,
        inputPricePer1k: null,
        outputPricePer1k: null,
      },
    ],
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
      review: vi.fn(),
      reportUrl: () => '/report',
    },
    mcp: { ...crud(), test: vi.fn() },
    memories: { list: vi.fn(async () => []), remove: vi.fn() },
    analytics: { failures: vi.fn(), distill: vi.fn(), cost: vi.fn() },
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
  expect(within(main).queryByText('emb-1')).toBeNull();
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

it('pending approvals and ask_human questions are answered from the composer area', async () => {
  const c = client();
  const prompt = (id: string, extra: Partial<Prompt> & Pick<Prompt, 'kind'>): Prompt => ({
    id,
    order: 1,
    status: 'pending',
    createdAt: now,
    ...extra,
  });
  c.snapshot = vi.fn(async () => ({
    ...snapshot('a'),
    meta: {
      ...snapshot('a').meta,
      status: 'running',
      capabilities: { ...snapshot().meta.capabilities, respond: true },
    },
    prompts: [
      prompt('p1', {
        kind: 'approval',
        toolName: 'run_shell',
        arguments: { cmd: 'rm -rf /tmp/x' },
        riskLevel: 'dangerous',
      }),
      prompt('p2', { kind: 'question', question: '要用哪个城市？', options: ['北京', '上海'] }),
      prompt('p3', { kind: 'question', question: '旧问题', status: 'answered', answer: '好' }),
    ],
  }));
  c.command = vi.fn(async () => ({}));
  render(<Workbench scope={{ key: 'x' }} />, { wrapper: studio(c) });
  fireEvent.click(await screen.findByText('a'));
  const approval = await screen.findByRole('region', { name: '工具审批' });
  expect(within(approval).getByText('run_shell')).toBeTruthy();
  expect(screen.queryByText('旧问题')).toBeNull();
  fireEvent.click(within(approval).getByRole('button', { name: '拒绝' }));
  await waitFor(() =>
    expect(c.command).toHaveBeenCalledWith(expect.anything(), {
      type: 'respond',
      promptId: 'p1',
      approved: false,
    }),
  );
  const question = screen.getByRole('region', { name: 'Agent 提问' });
  fireEvent.click(within(question).getByRole('button', { name: '上海' }));
  await waitFor(() =>
    expect(c.command).toHaveBeenCalledWith(expect.anything(), {
      type: 'respond',
      promptId: 'p2',
      answer: '上海',
    }),
  );
  fireEvent.change(within(question).getByLabelText('回答'), { target: { value: '杭州' } });
  fireEvent.click(within(question).getByRole('button', { name: '回答' }));
  await waitFor(() =>
    expect(c.command).toHaveBeenCalledWith(expect.anything(), {
      type: 'respond',
      promptId: 'p2',
      answer: '杭州',
    }),
  );
});

it('assistant replies show the run token usage', async () => {
  const c = client();
  c.snapshot = vi.fn(async () => ({
    ...snapshot('a'),
    messages: [{ ...message('1', '答', 'A'), usage: { inputTokens: 1234, outputTokens: 56 } }],
  }));
  render(<Workbench scope={{ key: 'x' }} />, { wrapper: studio(c) });
  fireEvent.click(await screen.findByText('a'));
  expect(await screen.findByText('1.2k / 56 tokens')).toBeTruthy();
});

it('MCP secrets are write-only: stored keys come back blank and blank keeps the value', async () => {
  const c = client();
  const server = {
    id: 'm1',
    name: 'files',
    description: '',
    enabled: true,
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', 'srv'],
    envKeys: ['TOKEN'],
    url: '',
    headerKeys: [],
    createdAt: now,
    updatedAt: now,
  };
  c.mcp.list = vi.fn(async () => [server]);
  c.mcp.update = vi.fn(async () => server);
  c.mcp.test = vi.fn(async () => ({ ok: false, message: '连接失败：ENOENT', tools: [] }));
  render(<McpManager />, { wrapper: studio(c) });
  fireEvent.click(await screen.findByRole('button', { name: '测试' }));
  expect(await screen.findByText('files 连接失败')).toBeTruthy();
  expect(screen.getByText('连接失败：ENOENT')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  fireEvent.click(await screen.findByRole('button', { name: 'files —' }));
  const env = (await screen.findByLabelText('环境变量')) as HTMLTextAreaElement;
  expect(env.value).toBe('TOKEN=');
  expect(screen.getByText(/已保存：TOKEN/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() =>
    expect(c.mcp.update).toHaveBeenCalledWith('m1', expect.objectContaining({ env: { TOKEN: '' } })),
  );
});

it('memories list per agent and delete with confirmation', async () => {
  const c = client();
  c.agents.list = vi.fn(async () => []);
  c.memories.list = vi.fn(async () => [
    {
      id: 'memory:k1',
      agentId: 'agent-general',
      layer: 'semantic',
      content: '用户偏好简洁的回答',
      factType: 'preference',
      importance: 0.8,
      source: '',
      accessCount: 2,
      createdAt: now,
      lastAccessedAt: now,
    },
  ]);
  c.memories.remove = vi.fn(async () => {});
  render(<MemoryManager />, { wrapper: studio(c) });
  expect(await screen.findByText('用户偏好简洁的回答')).toBeTruthy();
  expect(screen.getByText('事实')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '删除这条记忆' }));
  expect(c.memories.remove).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: '删除' }));
  await waitFor(() => expect(c.memories.remove).toHaveBeenCalledWith('memory:k1'));
});
