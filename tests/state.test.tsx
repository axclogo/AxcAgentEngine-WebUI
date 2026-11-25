import { it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useResource, errorText } from '../src/state';
import { fixtureHost, snapshot, deferred } from './fixtures';
it('replacing the host detaches an outstanding command and its lock', async () => {
  const first = fixtureHost().host;
  const second = fixtureHost().host;
  const pending = deferred<{}>();
  first.command = vi.fn(() => pending.promise);
  const view = renderHook(
    ({ host }) => useResource(host, { kind: 'conversation', scope: { key: 'x' }, id: 'a' }),
    { initialProps: { host: first } },
  );
  await waitFor(() => expect(view.result.current.snapshot).not.toBeNull());
  let sent!: Promise<{}>;
  act(() => {
    sent = view.result.current.command({ type: 'stop' });
  });
  view.rerender({ host: second });
  await waitFor(() => expect(view.result.current.snapshot).not.toBeNull());
  await act(async () => {
    await view.result.current.command({ type: 'resume' });
  });
  await act(async () => {
    pending.reject(new Error('旧宿主失败'));
    await expect(sent).rejects.toThrow('旧宿主失败');
  });
  expect(view.result.current.error).toBe('');
  expect(view.result.current.busy).toBe(false);
});
it('exposes load and connection errors and clears them only after successful snapshot recovery', async () => {
  const { host, subscriptions } = fixtureHost();
  host.snapshot = vi.fn(async () => {
    throw new Error('加载失败');
  });
  const { result } = renderHook(() =>
    useResource(host, { kind: 'simulation', scope: { key: 'x' }, id: 'a' }),
  );
  await waitFor(() => expect(result.current.error).toBe('加载失败'));
  act(() => subscriptions.get('a')!.error(new Error('断线')));
  expect(result.current.error).toBe('断线');
  host.snapshot = vi.fn(async () => snapshot());
  act(() => subscriptions.get('a')!.reconnect());
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());
  expect(result.current.error).toBe('');
});
it('serializes commands, ignores rejection after unmount and keeps failed query visible', async () => {
  const { host } = fixtureHost();
  const pending = deferred<{}>();
  host.command = vi.fn(() => pending.promise);
  const view = renderHook(() => useResource(host, { kind: 'conversation', scope: { key: 'x' }, id: 'a' }));
  await waitFor(() => expect(view.result.current.snapshot).not.toBeNull());
  let sent!: Promise<{}>;
  act(() => {
    sent = view.result.current.command({ type: 'stop' });
  });
  await expect(view.result.current.command({ type: 'resume' })).rejects.toThrow('仍在提交');
  view.unmount();
  pending.reject(new Error('旧错误'));
  await expect(sent).rejects.toThrow('旧错误');
  expect(errorText(42)).toBe('42');
});
