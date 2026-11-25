import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ChevronRight, GitBranch, MessageSquare, Trash2 } from 'lucide-react';
import { useStudio } from '../provider';
import type { Meta, Scope, Snapshot } from '../core';
import { Badge, Button, Empty } from '../ui/primitives';
import {
  Confirm,
  Dialog,
  SheetContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/overlay';
import { Page, PageBody, PageHeader, SearchBox, LoadState, keys, formatTime, matches } from './page';
import { Markdown } from '../markdown';
import { statusLabel } from '../labels';
import { errorText } from '../state';
import { toast } from 'sonner';
import { cn } from '../lib/utils';
import { useNavigate } from './nav';

/**
 * Archived conversations of every agent as fork trees. Restoring or deleting a conversation also applies to
 * its branches, so a tree is never split between the workbench and the archive.
 * 归档页：按 Agent 分组，以分叉树展示全部已归档会话；恢复会连同分支一起恢复。
 */
export function ArchiveManager({
  scope = { key: 'local' },
  initialAgentId,
}: {
  scope?: Scope;
  initialAgentId?: string;
}) {
  const { client } = useStudio();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const catalog = useQuery({
    queryKey: keys.catalog(scope.key),
    queryFn: ({ signal }) => client.catalog(scope, signal),
  });
  const listKey = ['conversations', scope.key, 'archive'];
  const list = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) =>
      client.list('conversation', scope, { keyword: '', mode: '', status: '', agentId: '' }, signal),
  });
  const [keyword, setKeyword] = React.useState('');
  const [preview, setPreview] = React.useState<Meta>();
  const [deleting, setDeleting] = React.useState<Meta>();
  const reload = () => void qc.invalidateQueries({ queryKey: ['conversations', scope.key] });
  const all = list.data ?? [];
  const archived = all.filter((m) => m.archived);
  const byId = new Map(all.map((m) => [m.id, m]));
  // A search hit keeps its archived ancestors so the tree still reads correctly. / 搜索结果保留祖先，树结构不断。
  const visible = new Set<string>();
  for (const m of archived) {
    if (!matches(keyword, m.title)) continue;
    for (let x: Meta | undefined = m; x && x.archived; x = x.parentId ? byId.get(x.parentId) : undefined)
      visible.add(x.id);
  }
  const agentName = (id: string) => catalog.data?.agents.find((a) => a.id === id)?.name ?? id;
  const avatar = (id: string) => catalog.data?.agents.find((a) => a.id === id)?.avatar ?? '🤖';
  const groups = [...new Set(archived.filter((m) => visible.has(m.id)).map((m) => m.agentId))].sort((a, b) =>
    a === initialAgentId ? -1 : b === initialAgentId ? 1 : agentName(a).localeCompare(agentName(b)),
  );
  const act = (m: Meta, type: 'unarchive' | 'delete') =>
    client
      .command({ kind: 'conversation', scope, id: m.id }, { type })
      .then(() => {
        if (type === 'unarchive')
          toast.success(`已恢复「${m.title}」及其分支`, {
            action: navigate
              ? { label: '去对话', onClick: () => navigate({ section: 'chat', id: m.agentId }) }
              : undefined,
          });
        else toast.success(`已删除「${m.title}」`);
        if (preview?.id === m.id) setPreview(undefined);
        reload();
      })
      .catch((e) => toast.error(errorText(e)));
  return (
    <Page>
      <PageHeader
        title="归档"
        description="已归档的会话按 Agent 分组，保留分叉关系。恢复会连同分支一起回到对话列表；只有归档后的会话可以永久删除。"
      >
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索会话标题" />
      </PageHeader>
      <PageBody className="px-6 py-5">
        <LoadState loading={list.isLoading} error={list.error} />
        {list.data && groups.length === 0 && (
          <Empty icon={<Archive />} title={archived.length ? '没有匹配的会话' : '还没有归档的会话'}>
            {!archived.length && '在对话页的会话列表里，把鼠标移到会话上点归档按钮。'}
          </Empty>
        )}
        <div className="flex max-w-4xl flex-col gap-4">
          {groups.map((agentId) => {
            const rows = archived.filter((m) => m.agentId === agentId && visible.has(m.id));
            return (
              <Collapsible key={agentId} defaultOpen className="rounded-xl border bg-card">
                <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-left">
                  <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                  <span className="flex size-7 items-center justify-center rounded-md bg-muted">
                    {avatar(agentId)}
                  </span>
                  <span className="font-medium">{agentName(agentId)}</span>
                  <Badge variant="secondary" className="font-normal">
                    {rows.length} 个会话
                  </Badge>
                </CollapsibleTrigger>
                <CollapsibleContent className="border-t px-2 py-2">
                  <ArchiveTree
                    rows={rows}
                    all={byId}
                    selected={preview?.id}
                    onOpen={setPreview}
                    onRestore={(m) => void act(m, 'unarchive')}
                    onDelete={setDeleting}
                  />
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      </PageBody>
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(undefined)}>
        {preview && (
          <ArchivePreview
            scope={scope}
            meta={preview}
            onRestore={() => void act(preview, 'unarchive')}
            onDelete={() => setDeleting(preview)}
          />
        )}
      </Dialog>
      <Confirm
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`永久删除「${deleting?.title}」？`}
        description="消息和附件会被删除，无法恢复。它的分支会保留并提升一级。"
        confirmText="永久删除"
        onConfirm={async () => void (await act(deleting!, 'delete'))}
      />
    </Page>
  );
}

function ArchiveTree({
  rows,
  all,
  selected,
  onOpen,
  onRestore,
  onDelete,
}: {
  rows: Meta[];
  all: Map<string, Meta>;
  selected?: string;
  onOpen: (m: Meta) => void;
  onRestore: (m: Meta) => void;
  onDelete: (m: Meta) => void;
}) {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string, Meta[]>();
  const roots: Meta[] = [];
  for (const r of rows) {
    if (r.parentId && ids.has(r.parentId)) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
    else roots.push(r);
  }
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const render = (m: Meta, depth: number): React.ReactNode => {
    const kids = children.get(m.id) ?? [];
    const open = !collapsed.has(m.id);
    const parent = m.parentId ? all.get(m.parentId) : undefined;
    return (
      <li
        key={m.id}
        role="treeitem"
        aria-selected={selected === m.id}
        aria-expanded={kids.length ? open : undefined}
      >
        <div
          className={cn(
            'group flex items-center gap-1 rounded-lg pr-2 hover:bg-muted',
            selected === m.id && 'bg-accent hover:bg-accent',
          )}
          style={{ paddingLeft: 4 + depth * 18 }}
        >
          {kids.length ? (
            <button
              type="button"
              aria-label={open ? `收起 ${m.title} 的分支` : `展开 ${m.title} 的 ${kids.length} 个分支`}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(m.id)) next.delete(m.id);
                  else next.add(m.id);
                  return next;
                })
              }
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-background"
            >
              <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
            </button>
          ) : (
            <span className="flex size-6 shrink-0 items-center justify-center">
              {depth > 0 && <GitBranch className="size-3 text-muted-foreground/60" />}
            </span>
          )}
          <button
            type="button"
            onClick={() => onOpen(m)}
            className="flex min-w-0 flex-1 cursor-pointer flex-col items-start py-1.5 text-left"
          >
            <span className="w-full truncate text-sm">{m.title}</span>
            <span className="w-full truncate text-xs text-muted-foreground">
              {statusLabel(m.status)} · 归档于 {formatTime(m.archivedAt ?? undefined)}
              {kids.length > 0 && ` · ${kids.length} 个分支`}
              {depth === 0 && parent && !parent.archived && ` · 来自「${parent.title}」的分支`}
            </span>
          </button>
          <Button variant="ghost" size="xs" aria-label={`恢复 ${m.title}`} onClick={() => onRestore(m)}>
            <ArchiveRestore />
            恢复
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-label={`删除 ${m.title}`}
            className="text-muted-foreground hover:text-destructive"
            disabled={!m.capabilities.delete}
            onClick={() => onDelete(m)}
          >
            <Trash2 />
            删除
          </Button>
        </div>
        {kids.length > 0 && open && <ul role="group">{kids.map((k) => render(k, depth + 1))}</ul>}
      </li>
    );
  };
  return (
    <ul role="tree" aria-label="已归档会话" className="flex flex-col gap-0.5">
      {roots.map((r) => render(r, 0))}
    </ul>
  );
}

function ArchivePreview({
  scope,
  meta,
  onRestore,
  onDelete,
}: {
  scope: Scope;
  meta: Meta;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { client, Link } = useStudio();
  const snap = useQuery<Snapshot>({
    queryKey: ['archive-preview', meta.id],
    queryFn: ({ signal }) => client.snapshot({ kind: 'conversation', scope, id: meta.id }, signal),
  });
  return (
    <SheetContent
      width="max-w-3xl"
      title={meta.title}
      description={`只读预览 · 归档于 ${formatTime(meta.archivedAt ?? undefined)}`}
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto text-destructive"
            disabled={!meta.capabilities.delete}
            onClick={onDelete}
          >
            <Trash2 />
            永久删除
          </Button>
          <Button onClick={onRestore}>
            <ArchiveRestore />
            恢复到对话列表
          </Button>
        </>
      }
    >
      <LoadState loading={snap.isLoading} error={snap.error} />
      {snap.data?.messages.length === 0 && <Empty icon={<MessageSquare />} title="这个会话没有消息" />}
      <div className="flex flex-col gap-4">
        {snap.data?.messages.map((m) =>
          m.role === 'user' ? (
            <div
              key={m.id}
              className="self-end rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-accent-foreground"
            >
              <Markdown text={m.text} Link={Link} />
            </div>
          ) : (
            <div key={m.id}>
              <div className="mb-1 text-xs text-muted-foreground">{m.actor}</div>
              <Markdown text={m.text} Link={Link} />
            </div>
          ),
        )}
      </div>
    </SheetContent>
  );
}
