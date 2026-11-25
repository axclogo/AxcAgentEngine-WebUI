import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SimulationDetail, SimulationManager, SimulationForm } from '../src/simulation-view';
import { fixtureHost, snapshot, message, deferred, definition, studio, clickMenu } from './fixtures';
it('keeps early live messages across late snapshot; dedupes interview response and WS', async () => {
  const { host, subscriptions } = fixtureHost();
  const pending = deferred<ReturnType<typeof snapshot>>();
  host.snapshot = vi.fn(() => pending.promise);
  render(<SimulationDetail scope={{ key: 'x' }} taskId="a" />, { wrapper: studio(host) });
  act(() =>
    subscriptions.get('a')!.receive({ seq: 3, kind: 'message', value: message('3', '直播先到', 'B') }),
  );
  await act(async () => pending.resolve({ ...snapshot(), messages: [message('1', '历史', 'A')] }));
  expect(screen.getByText('直播先到')).toBeTruthy();
  expect(screen.getByText('尚未生成')).toBeTruthy();
  const event = {
    seq: 4,
    kind: 'message' as const,
    value: { ...message('4', '回答'), kind: 'interview' as const, target: 'all', question: '问题' },
  };
  host.command = vi.fn(async () => {
    subscriptions.get('a')!.receive(event);
    return { events: [event] };
  });
  fireEvent.change(screen.getByLabelText('问题'), { target: { value: '问题' } });
  fireEvent.click(screen.getByText('提交采访'));
  await waitFor(() => expect(screen.getAllByText('回答')).toHaveLength(1));
  expect(host.command).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ type: 'interview', target: 'all', question: '问题' }),
  );
});
it('task switch and unmount only detach; rejected command preserves state', async () => {
  const { host, subscriptions, off } = fixtureHost();
  const pending = deferred<ReturnType<typeof snapshot>>();
  host.snapshot = vi.fn((r) =>
    r.id === 'a'
      ? pending.promise
      : Promise.resolve({ ...snapshot('b'), messages: [message('2', '任务 B')] }),
  );
  const view = render(<SimulationDetail scope={{ key: 'x' }} taskId="a" />, { wrapper: studio(host) });
  const old = subscriptions.get('a')!;
  view.rerender(<SimulationDetail scope={{ key: 'x' }} taskId="b" />);
  await screen.findByText('任务 B');
  await act(async () => {
    pending.resolve({ ...snapshot('a'), messages: [message('1', '旧任务')] });
    old.receive({ seq: 8, kind: 'report', value: '旧报告' });
  });
  expect(screen.queryByText('旧任务')).toBeNull();
  expect(screen.queryByText('旧报告')).toBeNull();
  host.command = vi.fn(async () => {
    throw new Error('命令被拒绝');
  });
  fireEvent.click(screen.getByText('启动'));
  await screen.findByText('命令被拒绝');
  expect(screen.getByRole('status').textContent).toContain('未开始');
  view.unmount();
  expect(off).toHaveBeenCalledTimes(2);
  expect(host.command).toHaveBeenCalledTimes(1);
});
it('read-only hides all commands; reconnect reloads persisted snapshot', async () => {
  const { host, subscriptions } = fixtureHost();
  render(<SimulationDetail scope={{ key: 'x' }} taskId="a" readOnly />, { wrapper: studio(host) });
  await screen.findByText('尚未生成');
  expect(screen.queryByText('启动')).toBeNull();
  expect(screen.queryByText('提交采访')).toBeNull();
  act(() => subscriptions.get('a')!.reconnect());
  await waitFor(() => expect(host.snapshot).toHaveBeenCalledTimes(2));
});
it('manager reuses detail and saves validated form; filters sent to host', async () => {
  const { host } = fixtureHost();
  render(<SimulationManager scope={{ key: 'x' }} />, { wrapper: studio(host) });
  await screen.findByText('新建推演');
  fireEvent.change(screen.getByLabelText('搜索推演'), { target: { value: 'keyword' } });
  await waitFor(() =>
    expect(host.list).toHaveBeenLastCalledWith(
      'simulation',
      { key: 'x' },
      expect.objectContaining({ keyword: 'keyword' }),
      expect.anything(),
    ),
  );
  fireEvent.click(await screen.findByText('a'));
  await screen.findByLabelText('推演详情');
  fireEvent.click(screen.getByText('返回'));
  await screen.findByText('新建推演');
  fireEvent.click(screen.getByText('新建推演'));
  fireEvent.click(screen.getByText('保存'));
  expect(await screen.findByRole('alert')).toBeTruthy();
});
it('form edit shows mode fields and reports host save failure', async () => {
  render(
    <SimulationForm
      initial={{
        ...definition,
        mode: 'redblue' as const,
        agents: ['a', 'b'],
        redObjective: '红',
        blueObjective: '蓝',
      }}
      agents={[
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ]}
      onCancel={() => {}}
      onSave={async () => {
        throw new Error('保存失败');
      }}
    />,
  );
  expect(screen.getByLabelText('红方目标')).toBeTruthy();
  fireEvent.click(screen.getByText('保存'));
  await screen.findByText('保存失败');
});

it('management create/edit/delete, empty state and errors follow the host', async () => {
  const { host } = fixtureHost();
  render(<SimulationManager scope={{ key: 'x' }} />, { wrapper: studio(host) });
  await screen.findByText('a');
  clickMenu('a 操作');
  fireEvent.click(await screen.findByRole('menuitem', { name: '编辑' }));
  fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '修改后的任务' } });
  fireEvent.click(screen.getByText('保存'));
  await waitFor(() =>
    expect(host.saveSimulation).toHaveBeenCalledWith(
      { key: 'x' },
      expect.objectContaining({ name: '修改后的任务' }),
      'a',
    ),
  );
  fireEvent.click(await screen.findByText('新建推演'));
  fireEvent.click(screen.getByText('取消'));
  fireEvent.change(screen.getByLabelText('类型筛选'), { target: { value: 'social' } });
  fireEvent.change(screen.getByLabelText('状态筛选'), { target: { value: 'failed' } });
  await waitFor(() =>
    expect(host.list).toHaveBeenLastCalledWith(
      'simulation',
      expect.anything(),
      expect.objectContaining({ mode: 'social', status: 'failed' }),
      expect.anything(),
    ),
  );
  host.command = vi.fn(async () => {
    throw new Error('删除失败');
  });
  await screen.findByText('a');
  clickMenu('a 操作');
  fireEvent.click(await screen.findByRole('menuitem', { name: '删除 a' }));
  fireEvent.click(await screen.findByRole('button', { name: '删除' }));
  await screen.findByText('删除失败');
  host.command = vi.fn(async () => ({}));
  host.list = vi.fn(async () => []);
  clickMenu('a 操作');
  fireEvent.click(await screen.findByRole('menuitem', { name: '删除 a' }));
  fireEvent.click(await screen.findByRole('button', { name: '删除' }));
  await screen.findByText('暂无推演任务');
});
it('participant interview, delayed report and snapshot error stay isolated on task switch', async () => {
  const { host, subscriptions } = fixtureHost();
  host.snapshot = vi.fn(async (r) => ({
    ...snapshot(r.id),
    meta: {
      ...snapshot(r.id).meta,
      definition: {
        ...definition,
        mode: 'redblue' as const,
        agents: ['analyst', 'reviewer'],
        redObjective: '红方',
        blueObjective: '蓝方',
      },
    },
  }));
  const view = render(<SimulationDetail scope={{ key: 'x' }} taskId="a" />, { wrapper: studio(host) });
  await screen.findByText('尚未生成');
  fireEvent.change(screen.getByLabelText('采访对象'), { target: { value: 'reviewer' } });
  fireEvent.change(screen.getByLabelText('问题'), { target: { value: '具体问题' } });
  fireEvent.click(screen.getByText('提交采访'));
  await waitFor(() =>
    expect(host.command).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'interview', target: 'reviewer' }),
    ),
  );
  const pending = deferred<{ events: { seq: number; kind: 'report'; value: string }[] }>();
  host.command = vi.fn(() => pending.promise);
  fireEvent.click(screen.getByText('生成报告'));
  view.rerender(<SimulationDetail scope={{ key: 'x' }} taskId="b" />);
  await screen.findByRole('heading', { name: 'b' });
  await act(async () => pending.resolve({ events: [{ seq: 9, kind: 'report', value: '旧报告' }] }));
  expect(screen.queryByText('旧报告')).toBeNull();
  act(() => subscriptions.get('b')!.receive({ seq: 10, kind: 'report', value: '当前报告' }));
  await screen.findByText('当前报告');
});

it('mode-specific form fields and participant changes submit canonical values', async () => {
  const save = vi.fn(async () => {});
  render(
    <SimulationForm
      agents={[
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ]}
      onSave={save}
      onCancel={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '社群' } });
  fireEvent.change(screen.getByLabelText('目标'), { target: { value: '目标' } });
  fireEvent.change(screen.getByLabelText('模式'), { target: { value: 'social' } });
  expect(screen.queryByLabelText('讨论议题')).toBeNull();
  fireEvent.change(screen.getByLabelText('角色设定'), { target: { value: '用户' } });
  fireEvent.click(screen.getByLabelText('A'));
  fireEvent.click(screen.getByLabelText('B'));
  fireEvent.click(screen.getByLabelText('B'));
  fireEvent.change(screen.getByLabelText('最大步骤'), { target: { value: '200' } });
  fireEvent.click(screen.getByText('保存'));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: ['a'],
        topic: '目标',
        mode: 'social',
        persona: '用户',
        maxSteps: 200,
      }),
    ),
  );
});
