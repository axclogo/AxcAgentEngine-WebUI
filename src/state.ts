import { useCallback, useEffect, useMemo, useState } from 'react';
import { ResourceStore, resourceKey, type Host, type Resource, type Command } from './core';
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export function useResource(host: Host, resource: Resource) {
  const key = resourceKey(resource);
  const store = useMemo(() => new ResourceStore(), [host, key]);
  const [, render] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lifecycle = useMemo(() => ({ active: true, locked: false }), [store]);
  useEffect(() => {
    lifecycle.active = true;
    let live = true;
    const controllers = new Set<AbortController>();
    setError('');
    setBusy(false);
    const fail = (e: unknown) => {
      if (live) setError(errorText(e));
    };
    const refresh = () => {
      const controller = new AbortController();
      controllers.add(controller);
      host
        .snapshot(resource, controller.signal)
        .then((s) => {
          if (live) {
            store.snapshot(s);
            render((n) => n + 1);
            setError('');
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) fail(e);
        })
        .finally(() => controllers.delete(controller));
    };
    const off = host.subscribe(
      resource,
      (e) => {
        if (live) {
          store.event(e);
          render((n) => n + 1);
        }
      },
      refresh,
      fail,
    );
    refresh();
    return () => {
      live = false;
      lifecycle.active = false;
      off();
      controllers.forEach((c) => c.abort());
    };
  }, [host, key, store, lifecycle]);
  const command = useCallback(
    async (c: Command) => {
      if (lifecycle.locked) throw new Error('上一条命令仍在提交');
      lifecycle.locked = true;
      setBusy(true);
      setError('');
      try {
        const result = await host.command(resource, c);
        if (lifecycle.active) {
          result.events?.forEach((e) => store.event(e));
          render((n) => n + 1);
        }
        return result;
      } catch (e) {
        if (lifecycle.active) setError(errorText(e));
        throw e;
      } finally {
        lifecycle.locked = false;
        if (lifecycle.active) setBusy(false);
      }
    },
    [host, key, store, lifecycle],
  );
  return { snapshot: store.value, error, busy, command };
}
