import type { ComponentType } from 'react';
import { Markdown, type LinkProps } from './markdown';
// Only used for payloads the host marks as tool/artifact/activity output; plain speech is never parsed.
// 仅用于宿主标记为工具、产物或进度的载荷；普通发言不做解析。
function parse(text: string): Record<string, unknown> | unknown[] | undefined {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}
const brief = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') return v.length > 120 ? v.slice(0, 120) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `${v.length} 项`;
  return `${Object.keys(v).length} 个字段`;
};
export function StructuredResult({
  text,
  streaming,
  Link,
}: {
  text: string;
  streaming?: boolean;
  Link?: ComponentType<LinkProps>;
}) {
  const data = streaming ? undefined : parse(text);
  if (!data) return <Markdown text={text} streaming={streaming} Link={Link} />;
  const entries = Array.isArray(data)
    ? data.slice(0, 8).map((v, i) => [String(i + 1), v] as const)
    : Object.entries(data)
        .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
        .slice(0, 8);
  return (
    <div className="flex flex-col gap-1.5 text-[12.5px]">
      {entries.length > 0 ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-[11px] leading-6 text-muted-foreground">{k}</dt>
              <dd className="leading-6 break-words">{brief(v)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-muted-foreground">空结果</p>
      )}
      <details>
        <summary className="w-fit cursor-pointer text-xs text-muted-foreground">原始结果</summary>
        <pre className="mt-1.5 max-h-72 overflow-auto rounded-md bg-code p-2.5 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(data, null, 2)}
        </pre>
      </details>
    </div>
  );
}
