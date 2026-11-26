import * as React from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search } from 'lucide-react';
import { cn } from '../lib/utils';
import { Input } from '../ui/primitives';
import { errorText } from '../state';

export const keys = {
  providers: ['providers'] as const,
  plugins: ['plugins'] as const,
  agents: ['agents'] as const,
  skills: ['skills'] as const,
  knowledge: ['knowledge'] as const,
  documents: (id: string) => ['knowledge', id, 'documents'] as const,
  graphs: ['graphs'] as const,
  graphData: (id: string) => ['graphs', id, 'data'] as const,
  mcp: ['mcp'] as const,
  memories: (agentId: string) => ['memories', agentId] as const,
  analytics: (kind: string, agentId: string, days: number) => ['analytics', kind, agentId, days] as const,
  evals: ['evals'] as const,
  evalCases: (id: string) => ['evals', id, 'cases'] as const,
  evalResults: (id: string) => ['evals', id, 'results'] as const,
  catalog: (scope: string) => ['catalog', scope] as const,
};

/** Mutation that toasts errors/success and invalidates the given keys. / 统一的变更：错误提示与缓存失效。 */
export function useAction<V, R>(
  fn: (v: V) => Promise<R>,
  { invalidate = [], success }: { invalidate?: QueryKey[]; success?: string | ((r: R) => string) } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['catalog'] });
      if (success) toast.success(typeof success === 'function' ? success(r) : success);
    },
    onError: (e) => toast.error(errorText(e)),
  });
}

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 border-b px-6 pt-5 pb-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder = '搜索名称或描述',
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn('relative w-64 max-w-full', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pl-8"
      />
    </div>
  );
}

export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn('flex h-full min-h-0 flex-col', className)}>{children}</section>;
}
export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('min-h-0 flex-1 overflow-auto', className)}>{children}</div>;
}

export function LoadState({ loading, error }: { loading: boolean; error: unknown }) {
  if (error)
    return (
      <p role="alert" className="px-6 py-10 text-center text-sm text-destructive">
        {errorText(error)}
      </p>
    );
  if (loading) return <p className="px-6 py-10 text-center text-sm text-muted-foreground">正在加载…</p>;
  return null;
}

export const formatTime = (iso?: string) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

/** 1234 → 1.2k, 1234567 → 1.23M */
export const formatTokens = (n: number) =>
  n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`;

export function matches(keyword: string, ...fields: (string | undefined)[]) {
  const k = keyword.trim().toLowerCase();
  return !k || fields.some((f) => f?.toLowerCase().includes(k));
}
