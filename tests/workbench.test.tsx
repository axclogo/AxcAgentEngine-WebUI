import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Workbench } from '../src/index';
import { fixtureHost, snapshot, deferred, message, studio, clickMenu } from './fixtures';
import type { Attachment } from '../src/core';
async function open(host: ReturnType<typeof fixtureHost>['host']) {
  const view = render(<Workbench scope={{ key: 'x' }} />, { wrapper: studio(host) });
  fireEvent.click(await screen.findByText('a'));
  await screen.findByLabelText('消息');
  return view;
}
it('IME Enter never sends, ordinary send submits once and errors restore draft', async () => {
  const { host } = fixtureHost();
  await open(host);
  const input = screen.getByLabelText('消息');
  fireEvent.change(input, { target: { value: '中文组词' } });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
  expect(host.command).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  host.command = vi.fn(async () => {
    throw new Error('发送被拒绝');
  });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('发送被拒绝');
  await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe('中文组词'));
  expect(host.command).toHaveBeenCalledTimes(1);
  const first = vi.mocked(host.command).mock.calls[0][1];
  host.command = vi.fn(async () => ({}));
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(host.command).toHaveBeenCalledTimes(1));
  expect(vi.mocked(host.command).mock.calls[0][1]).toEqual(first);
});
it('live insertion submits immediately without an optimistic duplicate or local queue', async () => {
  const { host, subscriptions } = fixtureHost();
  host.snapshot = vi.fn(async (r) => ({
    ...snapshot(r.id),
    meta: {
      ...snapshot(r.id).meta,
      status: 'running',
      capabilities: { ...snapshot().meta.capabilities, insert: true, stop: true, cancelRequest: true },
    },
    messages: [message('1', '已有消息')],
    queue: [{ id: 'q', order: 1, text: '请求一', status: 'accepted' as const }],
  }));
  await open(host);
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '插话一' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() =>
    expect(host.command).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'insert', text: '插话一' }),
    ),
  );
  expect(screen.queryByText('插话一')).toBeNull();
  act(() =>
    subscriptions
      .get('a')!
      .receive({ seq: 3, kind: 'message', value: { ...message('2', '插话一', '你'), role: 'user' } }),
  );
  expect(screen.getAllByText('插话一')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '取消请求 请求一' }));
  await waitFor(() =>
    expect(host.command).toHaveBeenCalledWith(expect.anything(), { type: 'cancelRequest', requestId: 'q' }),
  );
});
it('slow old send cannot clear another session draft', async () => {
  const { host } = fixtureHost();
  const pending = deferred<{}>();
  host.command = vi.fn(() => pending.promise);
  await open(host);
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: 'A' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  fireEvent.click(screen.getByText('b'));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'b' })).toBeTruthy());
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: 'B 草稿' } });
  await act(async () => pending.resolve({}));
  expect((screen.getByLabelText('消息') as HTMLTextAreaElement).value).toBe('B 草稿');
});
it('attachment upload failure, cancellation and retry retain the same composer', async () => {
  const { host } = fixtureHost();
  host.snapshot = vi.fn(async (r) => ({
    ...snapshot(r.id),
    meta: { ...snapshot(r.id).meta, capabilities: { ...snapshot().meta.capabilities, upload: true } },
  }));
  host.upload = vi.fn(async () => {
    throw new Error('上传失败');
  });
  await open(host);
  const file = new File(['x'], 'image.png', { type: 'image/png' });
  fireEvent.paste(screen.getByLabelText('消息'), { clipboardData: { files: [file], getData: () => '' } });
  await screen.findByText('image.png');
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '图片' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('上传失败');
  expect(host.command).not.toHaveBeenCalled();
  await screen.findByText('image.png');
  const pending = deferred<Attachment>();
  host.upload = vi.fn(() => pending.promise);
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('取消上传');
  fireEvent.click(screen.getByText('取消上传'));
  await screen.findByText('image.png');
  await act(async () =>
    pending.resolve({ id: 'asset', name: 'image.png', url: '/asset', contentType: 'image/png' }),
  );
  expect(host.command).not.toHaveBeenCalled();
  host.upload = vi.fn(async () => ({
    id: 'asset',
    name: 'image.png',
    url: '/asset',
    contentType: 'image/png',
  }));
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(host.command).toHaveBeenCalledTimes(1));
  expect(vi.mocked(host.command).mock.calls[0][1]).toMatchObject({ attachments: [{ id: 'asset' }] });
});
it('topic switches discard slow list and old subscriptions; workshop source is read-only', async () => {
  const { host } = fixtureHost();
  const old = deferred<ReturnType<typeof snapshot>['meta'][]>();
  host.list = vi.fn((_k, s) =>
    s.key === 'A' ? old.promise : Promise.resolve([{ ...snapshot('b').meta, source: 'example.topic' }]),
  );
  const view = render(<Workbench scope={{ key: 'A' }} />, { wrapper: studio(host) });
  view.rerender(<Workbench scope={{ key: 'B' }} />);
  await screen.findByText('b');
  await act(async () => old.resolve([snapshot('old').meta]));
  expect(screen.queryByText('old')).toBeNull();
  host.snapshot = vi.fn(async () => ({
    ...snapshot('b'),
    meta: { ...snapshot('b').meta, source: 'example.topic' },
  }));
  fireEvent.click(screen.getByText('b'));
  await screen.findByText('请回来源页继续对话。');
  expect((screen.getByLabelText('消息') as HTMLTextAreaElement).disabled).toBe(true);
});

it('agent picker switches agents; failed creation stays actionable', async () => {
  const { host } = fixtureHost();
  host.catalog = vi.fn(async () => ({
    agents: [
      { id: 'analyst', name: '分析师' },
      { id: 'reviewer', name: '评审' },
    ],
    defaultAgentId: 'analyst',
    create: true,
    createSimulation: false,
  }));
  host.create = vi.fn(async () => {
    throw new Error('创建失败');
  });
  render(<Workbench scope={{ key: 'x' }} toolbar={<span>业务工具栏</span>} />, { wrapper: studio(host) });
  fireEvent.click(await screen.findByRole('combobox', { name: 'Agent' }));
  fireEvent.click(await screen.findByRole('option', { name: /评审/ }));
  await waitFor(() =>
    expect(host.list).toHaveBeenLastCalledWith(
      'conversation',
      { key: 'x' },
      expect.objectContaining({ agentId: 'reviewer' }),
      expect.anything(),
    ),
  );
  fireEvent.click(await screen.findByText('新会话'));
  await screen.findByText('创建失败');
  host.create = vi.fn(async () => snapshot('new').meta);
  fireEvent.click(screen.getByText('新会话'));
  await screen.findByRole('heading', { name: 'new' });
  expect(host.create).toHaveBeenCalledWith({ key: 'x' }, 'reviewer');
});
it('progress and stable message parts update; fork navigates to host ID, stop/resume/delete are distinct', async () => {
  const { host, subscriptions } = fixtureHost();
  const state = {
    ...snapshot('a'),
    meta: {
      ...snapshot('a').meta,
      capabilities: { ...snapshot().meta.capabilities, stop: true, resume: true, fork: true, archive: true },
      archived: true,
      checkpoints: [{ id: 'cut', label: '切点' }],
    },
    messages: [
      {
        ...message('1'),
        parts: [
          { id: 'p', kind: 'text' as const, text: '正文' },
          { id: 'tool', kind: 'tool' as const, title: '工具调用', text: '工具结果', status: 'completed' },
        ],
      },
    ],
    activities: [
      { id: 'step', order: 1, kind: 'step' as const, title: '检查', status: 'running', detail: '详细进度' },
    ],
  };
  host.snapshot = vi.fn(async (r) =>
    r.id === 'a' ? state : { ...snapshot(r.id), meta: { ...state.meta, id: r.id, title: r.id } },
  );
  await open(host);
  fireEvent.click(screen.getByText('执行进度'));
  fireEvent.click(await screen.findByText('检查'));
  expect(await screen.findByText('详细进度')).toBeTruthy();
  fireEvent.click(screen.getByText('工具调用'));
  expect(await screen.findByText('工具结果')).toBeTruthy();
  expect(await screen.findByText('正文')).toBeTruthy();
  const node = document.querySelector('[data-part-id=p]');
  act(() =>
    subscriptions.get('a')!.receive({
      seq: 4,
      kind: 'message',
      value: {
        ...state.messages[0],
        parts: [{ ...state.messages[0].parts[0], text: '更新正文' }, state.messages[0].parts[1]],
      },
    }),
  );
  expect(document.querySelector('[data-part-id=p]')).toBe(node);
  fireEvent.click(screen.getByText('停止运行'));
  await waitFor(() => expect(host.command).toHaveBeenCalledWith(expect.anything(), { type: 'stop' }));
  fireEvent.click(screen.getByText('恢复运行'));
  await waitFor(() => expect(host.command).toHaveBeenCalledWith(expect.anything(), { type: 'resume' }));
  host.command = vi.fn(async () => ({
    resource: { kind: 'conversation' as const, scope: { key: 'x' }, id: 'child' },
  }));
  clickMenu('会话操作');
  fireEvent.click(await screen.findByRole('menuitem', { name: '开分支…' }));
  fireEvent.click(await screen.findByRole('button', { name: '运行过程中的保存点 1' }));
  await screen.findByRole('heading', { name: 'child' });
  host.command = vi.fn(async () => ({}));
  clickMenu('会话操作');
  fireEvent.click(await screen.findByRole('menuitem', { name: '删除会话' }));
  fireEvent.click(await screen.findByRole('button', { name: '删除会话' }));
  await screen.findByText('从一个问题开始');
});
it('source navigation and custom domain rendering stay in host', async () => {
  const { host } = fixtureHost();
  host.snapshot = vi.fn(async () => ({
    ...snapshot(),
    meta: { ...snapshot().meta, source: 'topic' },
    messages: [message('1', '业务消息')],
  }));
  const source = vi.fn();
  render(<Workbench scope={{ key: 'x' }} openSource={source} />, {
    wrapper: studio(host, { renderMessage: (m) => <p>领域：{m.text}</p> }),
  });
  fireEvent.click(await screen.findByText('a'));
  await screen.findByText('领域：业务消息');
  fireEvent.click(screen.getByText('打开来源'));
  expect(source).toHaveBeenCalledWith(expect.objectContaining({ source: 'topic' }));
});
it('enqueue and priority are host commands, and a pending fork cannot navigate after switching', async () => {
  const { host } = fixtureHost();
  host.snapshot = vi.fn(async (r) => ({
    ...snapshot(r.id),
    meta: {
      ...snapshot(r.id).meta,
      status: 'running',
      capabilities: {
        ...snapshot().meta.capabilities,
        insert: true,
        enqueue: true,
        priority: true,
        fork: true,
      },
      checkpoints: [{ id: 'cut', label: '切点' }],
    },
  }));
  await open(host);
  for (const mode of ['enqueue', 'priority']) {
    fireEvent.change(screen.getByLabelText('发送方式'), { target: { value: mode } });
    fireEvent.change(screen.getByLabelText('消息'), { target: { value: mode } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect(host.command).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode })),
    );
  }
  const pending = deferred<{ resource: { kind: 'conversation'; scope: { key: string }; id: string } }>();
  host.command = vi.fn(() => pending.promise);
  clickMenu('会话操作');
  fireEvent.click(await screen.findByRole('menuitem', { name: '开分支…' }));
  fireEvent.click(await screen.findByRole('button', { name: '运行过程中的保存点 1' }));
  fireEvent.click(await screen.findByText('b'));
  await screen.findByRole('heading', { name: 'b' });
  await act(async () =>
    pending.resolve({ resource: { kind: 'conversation' as const, scope: { key: 'x' }, id: 'old-child' } }),
  );
  expect(screen.queryByRole('heading', { name: 'old-child' })).toBeNull();
});
