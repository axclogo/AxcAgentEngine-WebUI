import * as React from 'react';
import { Blocks, Puzzle } from 'lucide-react';
import type { PluginField, PluginInfo } from './schema';
import { Badge, Empty, Table, THead, TBody, Tr, Th, Td } from '../ui/primitives';
import { Dialog, SheetContent } from '../ui/overlay';
import { Page, PageBody, PageHeader, SearchBox, LoadState, matches } from './page';
import { usePlugins } from './agents';
import { cn } from '../lib/utils';

const typeLabel: Record<string, string> = {
  string: '文本',
  integer: '整数',
  number: '数字',
  boolean: '开关',
  object: '对象',
  array: '列表',
};

export function ToolCatalog() {
  const q = usePlugins();
  const [keyword, setKeyword] = React.useState('');
  const [open, setOpen] = React.useState<PluginInfo>();
  const rows = (q.data ?? []).filter((p) => matches(keyword, p.name, p.displayName, p.description));
  const groups: [string, PluginInfo[]][] = [
    ['推理策略', rows.filter((p) => p.kind === 'strategy')],
    ['由资源绑定启用', rows.filter((p) => p.kind === 'plugin' && p.managed)],
    ['能力插件', rows.filter((p) => p.kind === 'plugin' && !p.managed)],
  ];
  const total = q.data?.length ?? 0;
  const fields = q.data?.reduce((n, p) => n + p.fields.length, 0) ?? 0;
  return (
    <Page>
      <PageHeader
        title="工具目录"
        description={`引擎已注册 ${total} 个插件、${fields} 个可配置项。在 Agent 的「插件」页按需开启。`}
      >
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索插件" />
      </PageHeader>
      <PageBody className="px-6 py-5">
        <LoadState loading={q.isLoading} error={q.error} />
        {q.data && rows.length === 0 && <Empty icon={<Puzzle />} title="没有匹配的插件" />}
        <div className="flex flex-col gap-7">
          {groups
            .filter(([, list]) => list.length)
            .map(([title, list]) => (
              <section key={title}>
                <h2 className="mb-2.5 text-sm font-medium text-muted-foreground">
                  {title} <span className="tabular-nums">{list.length}</span>
                </h2>
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
                  {list.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => setOpen(p)}
                      className="flex cursor-pointer flex-col gap-1.5 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:shadow-sm"
                    >
                      <span className="flex items-center gap-2">
                        <Blocks className="size-4 text-primary" />
                        <span className="font-medium">{p.displayName || p.name}</span>
                        <span className="ml-auto text-xs text-muted-foreground">v{p.version}</span>
                      </span>
                      <code className="font-mono text-xs text-muted-foreground">plugins.{p.name}</code>
                      <span className="line-clamp-2 text-[12px] text-muted-foreground">
                        {p.description || '—'}
                      </span>
                      <span className="mt-1 text-xs text-muted-foreground">配置项 {p.fields.length}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
        </div>
      </PageBody>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(undefined)}>
        {open && (
          <SheetContent
            width="max-w-3xl"
            title={open.displayName || open.name}
            description={open.description}
          >
            <p className="mb-3 text-sm">
              在 agent.yaml 中通过{' '}
              <code className="rounded bg-muted px-1 font-mono text-[12px]">plugins.{open.name}</code>{' '}
              启用与配置。
            </p>
            {open.fields.length ? (
              <FieldTable fields={open.fields} />
            ) : (
              <p className="text-sm text-muted-foreground">无配置项。</p>
            )}
          </SheetContent>
        )}
      </Dialog>
    </Page>
  );
}

function FieldTable({ fields, depth = 0 }: { fields: PluginField[]; depth?: number }) {
  return (
    <Table className={cn(depth > 0 && 'text-[12px]')}>
      {depth === 0 && (
        <THead>
          <Tr>
            <Th>字段</Th>
            <Th>类型</Th>
            <Th>默认</Th>
            <Th>说明</Th>
          </Tr>
        </THead>
      )}
      <TBody>
        {fields.map((f) => (
          <React.Fragment key={f.key}>
            <Tr>
              <Td className="align-top" style={{ paddingLeft: 12 + depth * 16 }}>
                <code className="font-mono text-[12px]">{f.key}</code>
                <div className="text-xs text-muted-foreground">{f.label}</div>
              </Td>
              <Td className="align-top whitespace-nowrap">
                <Badge variant="secondary" className="font-normal">
                  {typeLabel[f.type] ?? f.type}
                </Badge>
                {f.advanced && (
                  <Badge variant="outline" className="ml-1 font-normal">
                    高级
                  </Badge>
                )}
              </Td>
              <Td className="max-w-40 align-top font-mono text-xs break-all text-muted-foreground">
                {f.default === null || f.default === undefined ? '—' : JSON.stringify(f.default)}
                {f.enum.length > 0 && <div className="mt-1">可选：{f.enum.map(String).join(' / ')}</div>}
              </Td>
              <Td className="align-top text-[12px] leading-relaxed text-muted-foreground">{f.description}</Td>
            </Tr>
            {f.children.length > 0 && (
              <tr>
                <td colSpan={4} className="p-0">
                  <FieldTable fields={f.children} depth={depth + 1} />
                </td>
              </tr>
            )}
          </React.Fragment>
        ))}
      </TBody>
    </Table>
  );
}
