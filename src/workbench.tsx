import * as React from 'react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  AttachmentPrimitive,
  MessageNotSentError,
  useAuiState,
  type ThreadMessageLike,
  type AppendMessage,
} from '@assistant-ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Copy,
  GitBranch,
  Info,
  ListTree,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Square,
  Play,
  Trash2,
  Archive,
  ArchiveRestore,
  Wrench,
  X,
  FileText,
  PanelLeft,
  Users,
  ShieldAlert,
  MessageCircleQuestion,
} from 'lucide-react';
import {
  type Scope,
  type Meta,
  type Message,
  type MessagePart,
  type Command,
  type Prompt,
  resourceKey,
} from './core';
import { useResource, errorText } from './state';
import { Markdown } from './markdown';
import { attachmentBridge } from './attachments';
import { statusLabel, partLabel, activityLabel } from './labels';
import { StructuredResult } from './structured';
import { useStudio } from './provider';
import { cn } from './lib/utils';
import { Badge, Button, NativeSelect } from './ui/primitives';
import {
  Combobox,
  Dialog,
  DialogContent,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Tip,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Confirm,
} from './ui/overlay';
import { keys, formatTime, formatTokens } from './studio/page';
import { AgentEditor, agentToInput, blankAgent } from './studio/agents';
import type { Agent } from './studio/schema';

export interface WorkbenchProps {
  scope: Scope;
  className?: string;
  /** Agent preselected when the workbench mounts. */
  initialAgentId?: string;
  /** Show 新建 / 编辑 Agent entry points next to the agent picker (needs management API). */
  manageAgents?: boolean;
  /** Extra controls under the conversation header. */
  toolbar?: React.ReactNode;
  /** Called when a conversation belongs to another page and the user wants to continue there. */
  openSource?: (meta: Meta) => void;
}

const dot: Record<string, string> = {
  running: 'bg-primary animate-pulse',
  completed: 'bg-primary/60',
  failed: 'bg-destructive',
  interrupted: 'bg-amber-500',
  cancelled: 'bg-muted-foreground/50',
  idle: 'bg-muted-foreground/30',
};
const tone = (s: string) =>
  s === 'failed'
    ? 'destructive'
    : s === 'running' || s === 'completed'
      ? 'default'
      : s === 'idle'
        ? 'secondary'
        : 'warning';

/**
 * Chat workbench: agent picker, conversation tree with unlimited fork depth, thread and composer.
 * The same component serves the full page and narrow embedded drawers (responds to its own width).
 * 会话工作台：整页与窄抽屉共用，按组件自身宽度响应。
 */
export function Workbench(props: WorkbenchProps) {
  return <WorkbenchScope key={props.scope.key} {...props} />;
}

function WorkbenchScope({
  scope,
  className,
  initialAgentId,
  manageAgents,
  toolbar,
  openSource,
}: WorkbenchProps) {
  const { client } = useStudio();
  const qc = useQueryClient();
  const [agentId, setAgentId] = React.useState(initialAgentId ?? '');
  const [selected, setSelected] = React.useState<string>();
  const [listOpen, setListOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState('');
  const [editor, setEditor] = React.useState<{ agent?: Agent } | undefined>();
  const [liveMeta, setLiveMeta] = React.useState<Meta>();
  const catalog = useQuery({
    queryKey: keys.catalog(scope.key),
    queryFn: ({ signal }) => client.catalog(scope, signal),
  });
  const agent = agentId || catalog.data?.defaultAgentId || '';
  const listKey = ['conversations', scope.key, agent];
  const list = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) =>
      client.list('conversation', scope, { keyword: '', mode: '', status: '', agentId: agent }, signal),
    enabled: !!agent || !!scope.shortcut,
  });
  const reload = () => void qc.invalidateQueries({ queryKey: ['conversations', scope.key] });
  const rows = React.useMemo(
    () => list.data?.map((m) => (m.id === liveMeta?.id ? liveMeta : m)),
    [list.data, liveMeta],
  );
  // Live status from the open conversation reflows into the list. / 打开会话的实时状态回写列表。
  const onUpdated = React.useCallback((meta: Meta) => setLiveMeta(meta), []);
  const choose = (id: string) => {
    setSelected(id);
    setListOpen(false);
  };
  const chosen = rows?.find((m) => m.id === selected);
  const active = rows?.filter((m) => !m.archived);
  const [deleting, setDeleting] = React.useState<Meta>();
  // Quick actions from the list: archive / restore; delete only for archived (confirmed).
  // 列表快捷操作：归档、恢复；仅已归档会话可删除，且需确认。
  const rowAction = (m: Meta, type: 'archive' | 'unarchive' | 'delete') => {
    if (type === 'delete') return setDeleting(m);
    setError('');
    void client
      .command({ kind: 'conversation', scope, id: m.id }, { type })
      .then(() => {
        if (type === 'archive' && (selected === m.id || isDescendant(rows ?? [], m.id, selected)))
          setSelected(undefined);
        reload();
      })
      .catch((e) => setError(errorText(e)));
  };
  const agents = catalog.data?.agents ?? [];
  const create = () => {
    setCreating(true);
    setError('');
    void client
      .create(scope, agent)
      .then((m) => {
        choose(m.id);
        reload();
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setCreating(false));
  };
  const listToggle = (
    <Button
      variant="ghost"
      size="sm"
      className="@4xl:hidden"
      aria-expanded={listOpen}
      aria-controls="axc-conversation-list"
      onClick={() => setListOpen((v) => !v)}
    >
      <PanelLeft />
      会话列表
    </Button>
  );
  const editAgent = async () => {
    const a = await qc.fetchQuery({ queryKey: keys.agents, queryFn: () => client.agents.list() });
    setEditor({ agent: a.find((x) => x.id === (chosen?.agentId ?? agent)) });
  };
  return (
    <section
      className={cn('@container relative flex h-full min-h-0 bg-background', className)}
      aria-label="Agent 工作台"
    >
      <aside
        id="axc-conversation-list"
        aria-label="会话侧栏"
        className={cn(
          'flex w-72 shrink-0 flex-col border-r bg-sidebar',
          '@max-4xl:absolute @max-4xl:inset-y-0 @max-4xl:left-0 @max-4xl:z-30 @max-4xl:w-[min(20rem,88%)] @max-4xl:shadow-xl',
          !listOpen && '@max-4xl:hidden',
        )}
      >
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center gap-1.5">
            <Combobox
              aria-label="Agent"
              className="flex-1 bg-card"
              value={chosen?.agentId ?? (agent || null)}
              clearable={false}
              onChange={(v) => {
                if (!v) return;
                setAgentId(v);
                setSelected(undefined);
              }}
              placeholder="选择 Agent"
              searchPlaceholder="搜索 Agent"
              groups={[
                {
                  label: 'Agent',
                  options: agents.map((a) => ({ value: a.id, label: `${a.avatar ?? '🤖'} ${a.name}` })),
                },
              ]}
            />
            {manageAgents && (
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Agent 管理">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => setEditor({})}>
                    <Plus />
                    新建 Agent
                  </MenuItem>
                  <MenuItem disabled={!agent} onSelect={() => void editAgent()}>
                    <Pencil />
                    编辑当前 Agent
                  </MenuItem>
                </MenuContent>
              </Menu>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="@4xl:hidden"
              aria-label="收起会话列表"
              onClick={() => setListOpen(false)}
            >
              <X />
            </Button>
          </div>
          {catalog.data?.create && (
            <Button className="w-full" loading={creating} disabled={!agent} onClick={create}>
              <Plus />
              新会话
            </Button>
          )}
          {(error || catalog.error || list.error) && (
            <p role="alert" className="text-sm text-destructive">
              {error || errorText(catalog.error || list.error)}
            </p>
          )}
        </div>
        <div className="px-4 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">历史会话</div>
        <nav aria-label="会话列表" className="min-h-0 flex-1 overflow-auto px-2 pb-3">
          {active?.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">还没有会话</p>
          )}
          {active && (
            <ConversationTree rows={active} selected={selected} onChoose={choose} onAction={rowAction} />
          )}
        </nav>
      </aside>
      {listOpen && (
        <div
          aria-hidden
          className="absolute inset-0 z-20 bg-black/30 @4xl:hidden"
          onClick={() => setListOpen(false)}
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <Conversation
            key={resourceKey({ kind: 'conversation', scope, id: selected })}
            scope={scope}
            id={selected}
            toolbar={toolbar}
            openSource={openSource}
            listToggle={listToggle}
            onUpdated={onUpdated}
            onSelect={(id) => {
              choose(id);
              reload();
            }}
            onDelete={() => {
              setSelected(undefined);
              reload();
            }}
          />
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex h-12 items-center px-3 @4xl:hidden">{listToggle}</div>
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-accent text-2xl">
                {agents.find((a) => a.id === agent)?.avatar ?? (
                  <Bot className="size-6 text-accent-foreground" />
                )}
              </div>
              <h1 className="text-xl font-semibold">从一个问题开始</h1>
              <p className="max-w-sm text-sm text-muted-foreground">
                {agents.length
                  ? '选择 Agent 并新建会话，或打开一条历史会话。'
                  : '还没有可用的 Agent。先在「Agent」里新建并启用一个。'}
              </p>
              {toolbar}
            </div>
          </div>
        )}
      </main>
      <Confirm
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`永久删除「${deleting?.title}」？`}
        description="已归档会话的消息与附件会被删除，无法恢复；它的分支会保留。"
        confirmText="永久删除"
        onConfirm={() =>
          client.command({ kind: 'conversation', scope, id: deleting!.id }, { type: 'delete' }).then(() => {
            if (selected === deleting!.id) setSelected(undefined);
            reload();
          })
        }
      />
      <Dialog open={!!editor} onOpenChange={(o) => !o && setEditor(undefined)}>
        {editor && (
          <AgentEditor
            agent={editor.agent}
            initial={editor.agent ? agentToInput(editor.agent) : blankAgent}
            onDone={(saved) => {
              setEditor(undefined);
              void qc.invalidateQueries({ queryKey: ['catalog'] });
              if (saved && !editor.agent) setAgentId(saved.id);
            }}
          />
        )}
      </Dialog>
    </section>
  );
}

function isDescendant(rows: Meta[], ancestor: string, id?: string) {
  const parent = new Map(rows.map((r) => [r.id, r.parentId ?? null]));
  for (let p = id && parent.get(id); p; p = parent.get(p)) if (p === ancestor) return true;
  return false;
}

// ---------- Conversation tree (forks nest under their parent, any depth) ----------
function ConversationTree({
  rows,
  selected,
  onChoose,
  onAction,
  archived = false,
}: {
  rows: Meta[];
  selected?: string;
  onChoose: (id: string) => void;
  onAction: (m: Meta, type: 'archive' | 'unarchive' | 'delete') => void;
  archived?: boolean;
}) {
  const { children, roots, parentOf } = React.useMemo(() => {
    const ids = new Set(rows.map((r) => r.id));
    const children = new Map<string, Meta[]>();
    const parentOf = new Map<string, string>();
    const roots: Meta[] = [];
    for (const r of rows) {
      const p = r.parentId && ids.has(r.parentId) ? r.parentId : null;
      if (p) {
        parentOf.set(r.id, p);
        children.set(p, [...(children.get(p) ?? []), r]);
      } else roots.push(r);
    }
    return { children, roots, parentOf };
  }, [rows]);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  // Reveal the selected conversation by expanding its ancestors. / 展开选中会话的所有祖先。
  React.useEffect(() => {
    if (!selected) return;
    setOpen((prev) => {
      const next = new Set(prev);
      for (let p = parentOf.get(selected); p; p = parentOf.get(p)) next.add(p);
      return next.size === prev.size ? prev : next;
    });
  }, [selected, parentOf]);
  const render = (m: Meta, depth: number): React.ReactNode => {
    const kids = children.get(m.id) ?? [];
    const expanded = open.has(m.id);
    return (
      <li
        key={m.id}
        role="treeitem"
        aria-expanded={kids.length ? expanded : undefined}
        aria-selected={selected === m.id}
      >
        <div
          className={cn(
            'group relative flex items-center rounded-lg pr-1 transition-colors hover:bg-muted',
            selected === m.id && 'bg-accent hover:bg-accent',
          )}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          {kids.length > 0 ? (
            <button
              type="button"
              aria-label={expanded ? `收起 ${m.title} 的分支` : `展开 ${m.title} 的 ${kids.length} 个分支`}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted"
              onClick={() =>
                setOpen((prev) => {
                  const next = new Set(prev);
                  if (next.has(m.id)) next.delete(m.id);
                  else next.add(m.id);
                  return next;
                })
              }
            >
              <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
            </button>
          ) : (
            <span className="flex size-6 shrink-0 items-center justify-center">
              {depth > 0 && <GitBranch className="size-3 text-muted-foreground/60" />}
            </span>
          )}
          <button
            type="button"
            aria-current={selected === m.id}
            onClick={() => onChoose(m.id)}
            className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 py-1.5 pr-1 text-left"
          >
            <span
              className={cn(
                'w-full truncate text-[12.5px] leading-snug',
                selected === m.id ? 'font-medium text-accent-foreground' : 'text-foreground/90',
              )}
            >
              {m.title}
            </span>
            <span className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn('size-1.5 shrink-0 rounded-full', dot[m.status] ?? dot.idle)} />
              <span className="truncate">
                {statusLabel(m.status)}
                {m.createdAt && ` · ${formatTime(m.createdAt).slice(5)}`}
                {kids.length > 0 && ` · ${kids.length} 个分支`}
              </span>
            </span>
          </button>
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {archived ? (
              <>
                <Tip content="恢复">
                  <button
                    type="button"
                    aria-label={`恢复 ${m.title}`}
                    onClick={() => onAction(m, 'unarchive')}
                    className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    <ArchiveRestore className="size-3.5" />
                  </button>
                </Tip>
                <Tip content="永久删除">
                  <button
                    type="button"
                    aria-label={`删除 ${m.title}`}
                    onClick={() => onAction(m, 'delete')}
                    className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </Tip>
              </>
            ) : (
              <Tip
                content={
                  m.capabilities.archive ? (kids.length ? '归档（含分支）' : '归档') : '运行中，结束后可归档'
                }
              >
                <button
                  type="button"
                  aria-label={`归档 ${m.title}`}
                  aria-disabled={!m.capabilities.archive}
                  onClick={() => m.capabilities.archive && onAction(m, 'archive')}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
                >
                  <Archive className="size-3.5" />
                </button>
              </Tip>
            )}
          </span>
        </div>
        {kids.length > 0 && expanded && (
          <ul
            role="group"
            className="relative before:absolute before:top-0 before:bottom-2 before:w-px before:bg-border"
            style={{ ['--d' as string]: depth }}
          >
            {kids.map((k) => render(k, depth + 1))}
          </ul>
        )}
      </li>
    );
  };
  return (
    <ul role="tree" aria-label={archived ? '已归档会话' : '会话'} className="flex flex-col gap-0.5">
      {roots.map((r) => render(r, 0))}
    </ul>
  );
}

// ---------- Messages ----------
const Presentation = React.createContext<{
  messages: Message[];
  forkAt: Map<string, string>;
  fork: (checkpointId: string) => void;
  canFork: boolean;
  agentName: string;
  avatar?: string;
}>({ messages: [], forkAt: new Map(), fork: () => {}, canFork: false, agentName: '' });

function ChatMessage() {
  const messageId = useAuiState((s) => s.message.id);
  const p = React.useContext(Presentation);
  const { Link, renderMessage } = useStudio();
  const m = p.messages.find((x) => x.id === messageId);
  if (!m) return null;
  const checkpoint = p.forkAt.get(m.id);
  if (m.role === 'user')
    return (
      <MessagePrimitive.Root data-message-id={m.id} className="group flex flex-col items-end gap-1.5 py-2">
        <span className="sr-only">{m.actor}</span>
        {m.attachments && m.attachments.length > 0 && <AttachmentList items={m.attachments} />}
        {m.text && (
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-accent-foreground [&_.axc-md]:text-[14px] [&_.axc-md]:leading-relaxed">
            {renderMessage?.(m) ?? <Markdown text={m.text} streaming={m.streaming} Link={Link} />}
          </div>
        )}
      </MessagePrimitive.Root>
    );
  return (
    <MessagePrimitive.Root data-message-id={m.id} className="group flex flex-col gap-1.5 py-3">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span className="flex size-6 items-center justify-center rounded-md bg-muted text-sm">
          {m.role === 'system' ? <Info className="size-3.5" /> : (p.avatar ?? '🤖')}
        </span>
        <span className="font-medium text-foreground/80">{m.actor}</span>
        {m.streaming && <Loader2 className="size-3.5 animate-spin" aria-label="生成中" />}
      </div>
      <div className={cn('min-w-0', m.role === 'system' && 'text-sm text-muted-foreground')}>
        {renderMessage?.(m) ?? <MessageBody message={m} />}
      </div>
      {!m.streaming && m.role === 'assistant' && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton text={m.text} />
          {m.usage && (
            <Tip content="这次运行的输入 / 输出 token">
              <span className="px-1.5 text-[11px] text-muted-foreground tabular-nums">
                {formatTokens(m.usage.inputTokens)} / {formatTokens(m.usage.outputTokens)} tokens
              </span>
            </Tip>
          )}
          {p.canFork && checkpoint && (
            <Tip content="从这条回复之后开一个分支，原会话保持不变">
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                onClick={() => p.fork(checkpoint)}
              >
                <GitBranch />
                从这里开分支
              </Button>
            </Tip>
          )}
        </div>
      )}
    </MessagePrimitive.Root>
  );
}
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="复制"
      className="text-muted-foreground"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
    >
      {done ? <Check /> : <Copy />}
    </Button>
  );
}
function AttachmentList({ items }: { items: NonNullable<Message['attachments']> }) {
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
      {items.map((a) =>
        a.contentType.startsWith('image/') ? (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noreferrer"
            className="block overflow-hidden rounded-xl border"
          >
            <img src={a.url} alt={a.name} className="max-h-40 max-w-56 object-cover" />
          </a>
        ) : (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm hover:bg-muted"
          >
            <FileText className="size-4 text-muted-foreground" />
            <span className="max-w-48 truncate">{a.name}</span>
          </a>
        ),
      )}
    </div>
  );
}
const partIcon = { thinking: Brain, tool: Wrench, agent: Users, artifact: FileText, text: FileText } as const;
function PartBlock({ part, streaming }: { part: MessagePart; streaming?: boolean }) {
  const { Link } = useStudio();
  const Icon = partIcon[part.kind];
  const running = part.status === 'running' || (streaming && part.kind === 'thinking' && !part.status);
  return (
    <Collapsible
      data-part-id={part.id}
      defaultOpen={false}
      className="my-2 rounded-lg border bg-card/60 text-sm"
    >
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-muted-foreground">{partLabel(part.kind)}</span>
          {part.title && part.title !== partLabel(part.kind) && (
            <span className="ml-1.5 font-mono text-[12px]">{part.title}</span>
          )}
        </span>
        {running ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          part.status && (
            <Badge variant={part.status === 'failed' ? 'destructive' : 'secondary'} className="font-normal">
              {statusLabel(part.status)}
            </Badge>
          )
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-2.5 text-[12.5px] [&_.axc-md]:text-[12.5px]">
        {part.kind === 'tool' || part.kind === 'artifact' ? (
          <StructuredResult text={part.text} streaming={streaming} Link={Link} />
        ) : (
          <div className={cn(part.kind === 'thinking' && 'text-muted-foreground')}>
            <Markdown text={part.text} streaming={streaming} Link={Link} />
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
function MessageBody({ message: m }: { message: Message }) {
  const { Link } = useStudio();
  if (!m.parts) return <Markdown text={m.text} streaming={m.streaming} Link={Link} />;
  return (
    <>
      {m.parts.map((part) =>
        part.kind === 'text' ? (
          <div key={part.id} data-part-id={part.id}>
            <Markdown text={part.text} streaming={m.streaming} Link={Link} />
          </div>
        ) : (
          <PartBlock key={part.id} part={part} streaming={m.streaming} />
        ),
      )}
    </>
  );
}

// ---------- Conversation ----------
function Conversation({
  scope,
  id,
  toolbar,
  openSource,
  listToggle,
  onSelect,
  onDelete,
  onUpdated,
}: {
  scope: Scope;
  id: string;
  toolbar?: React.ReactNode;
  openSource?: (meta: Meta) => void;
  listToggle: React.ReactNode;
  onSelect: (id: string) => void;
  onDelete: () => void;
  onUpdated: (meta: Meta) => void;
}) {
  const { client } = useStudio();
  const resource = React.useMemo(() => ({ kind: 'conversation' as const, scope, id }), [scope, id]);
  const { snapshot: s, error, busy, command } = useResource(client, resource);
  const catalog = useQuery({
    queryKey: keys.catalog(scope.key),
    queryFn: ({ signal }) => client.catalog(scope, signal),
  });
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  React.useEffect(() => {
    if (s) onUpdated(s.meta);
  }, [s?.meta, onUpdated]);
  const [sendError, setSendError] = React.useState('');
  const [mode, setMode] = React.useState<'send' | 'insert' | 'enqueue' | 'priority'>('send');
  const [sending, setSending] = React.useState(false);
  const [forkOpen, setForkOpen] = React.useState(false);
  const [infoOpen, setInfoOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const sendLock = React.useRef(false);
  const receipt = React.useRef({ fingerprint: '', id: '' });
  const canUpload = React.useRef(false);
  // Adapter is stable from the first render so capability arrival never races a paste.
  // 适配器从首帧起稳定，能力到达与粘贴不竞争。
  const bridge = React.useMemo(
    () =>
      attachmentBridge(
        (file, signal) => client.upload!(resource, file, signal),
        setSendError,
        () => canUpload.current,
      ),
    [client, resource],
  );
  const blocked = !!s?.meta.source && !scope.shortcut;
  const c = s?.meta.capabilities;
  const running = s?.meta.status === 'running';
  const selectedMode = running ? (mode === 'send' ? 'insert' : mode) : 'send';
  const allowed = !blocked && !!c?.[selectedMode];
  canUpload.current = !!c?.upload && !blocked;
  const onNew = async (message: AppendMessage) => {
    if (sendLock.current) return;
    sendLock.current = true;
    setSending(true);
    setSendError('');
    const text = message.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    try {
      const attachments = bridge.resolve(message.attachments ?? []);
      const fingerprint = JSON.stringify([text, attachments, selectedMode]);
      if (receipt.current.fingerprint !== fingerprint)
        receipt.current = { fingerprint, id: crypto.randomUUID() };
      await command({ type: 'send', requestId: receipt.current.id, text, attachments, mode: selectedMode });
      receipt.current = { fingerprint: '', id: '' };
    } catch (e) {
      setSendError(errorText(e));
      throw new MessageNotSentError(errorText(e));
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  };
  // Host queues and live insertion submit immediately; never use a second runtime queue.
  // 宿主排队与插话立即提交，不创建第二条运行时队列。
  const runtime = useExternalStoreRuntime<Message>({
    messages: s?.messages ?? [],
    isRunning: false,
    isDisabled: !allowed || sending,
    adapters: { attachments: client.upload ? bridge.adapter : undefined },
    convertMessage: (m): ThreadMessageLike => ({
      id: m.id,
      role: m.role,
      content: [{ type: 'text', text: m.text }],
      createdAt: new Date(m.createdAt),
    }),
    onNew,
  });
  const act = (action: Command) => {
    void command(action)
      .then((result) => {
        if (!mounted.current) return;
        if (result.resource) onSelect(result.resource.id);
        if (action.type === 'delete') onDelete();
      })
      // Failures are already shown in the header via useResource's error state. / 失败已由 useResource 的 error 展示。
      .catch(() => {});
  };
  const forkAt = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const cp of s?.meta.checkpoints ?? []) if (cp.messageId) map.set(cp.messageId, cp.id);
    return map;
  }, [s?.meta.checkpoints]);
  if (!s)
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-12 items-center px-3 @4xl:hidden">{listToggle}</div>
        <p className="px-6 py-10 text-center text-sm text-muted-foreground" role={error ? 'alert' : 'status'}>
          {error || '正在读取会话…'}
        </p>
      </div>
    );
  const agentInfo = catalog.data?.agents.find((a) => a.id === s.meta.agentId);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Presentation.Provider
        value={{
          messages: s.messages,
          forkAt,
          fork: (checkpointId) => act({ type: 'fork', checkpointId }),
          canFork: !!c?.fork && !busy,
          agentName: agentInfo?.name ?? s.meta.agentId,
          avatar: agentInfo?.avatar,
        }}
      >
        <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 @2xl:px-5">
            {listToggle}
            <h2 className="min-w-0 truncate text-[13.5px] font-semibold" title={s.meta.title}>
              {s.meta.title}
            </h2>
            <Badge role="status" variant={tone(s.meta.status)} className="font-normal">
              {statusLabel(s.meta.status)}
            </Badge>
            {s.meta.archived && (
              <Badge variant="outline" className="font-normal">
                <Archive />
                已归档
              </Badge>
            )}
            {s.meta.parentId && (
              <Tip content="这是一个分支会话">
                <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-label="分支" />
              </Tip>
            )}
            <div className="ml-auto flex items-center gap-1">
              {c?.stop && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => act({ type: 'stop' })}>
                  <Square className="!size-3" />
                  停止运行
                </Button>
              )}
              {c?.resume && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => act({ type: 'resume' })}>
                  <Play className="!size-3" />
                  恢复运行
                </Button>
              )}
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="会话操作">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => setInfoOpen(true)}>
                    <Info />
                    会话信息
                  </MenuItem>
                  {c?.fork && (
                    <MenuItem
                      disabled={busy || !s.meta.checkpoints.length}
                      onSelect={() => setForkOpen(true)}
                    >
                      <GitBranch />
                      开分支…
                    </MenuItem>
                  )}
                  {(c?.archive || c?.delete) && <MenuSeparator />}
                  {c?.archive && (
                    <MenuItem
                      disabled={busy}
                      onSelect={() => act({ type: s.meta.archived ? 'unarchive' : 'archive' })}
                    >
                      {s.meta.archived ? <ArchiveRestore /> : <Archive />}
                      {s.meta.archived ? '取消归档' : '归档会话'}
                    </MenuItem>
                  )}
                  {c?.delete && s.meta.archived && (
                    <MenuItem destructive disabled={busy} onSelect={() => setConfirmDelete(true)}>
                      <Trash2 />
                      删除会话
                    </MenuItem>
                  )}
                </MenuContent>
              </Menu>
            </div>
          </header>
          {toolbar}
          <ThreadPrimitive.Viewport className="relative flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
            <div className="mx-auto w-full max-w-3xl flex-1 px-4 pt-5 pb-2 @2xl:px-6">
              {blocked && (
                <p className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
                  请回来源页继续对话。
                  {openSource && (
                    <Button size="xs" variant="outline" onClick={() => openSource(s.meta)}>
                      打开来源
                    </Button>
                  )}
                </p>
              )}
              {s.activities.length > 0 && (
                <Collapsible defaultOpen={running} className="mb-4 rounded-lg border bg-card/60 text-sm">
                  <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left">
                    <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                    <ListTree className="size-3.5 text-muted-foreground" />
                    执行进度
                    <span className="text-muted-foreground">{s.activities.length} 项</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="max-h-72 overflow-auto border-t px-2 py-1.5">
                    {s.activities.map((a) => (
                      <Collapsible key={a.id} data-activity-id={a.id}>
                        <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted">
                          <Badge variant="outline" className="font-normal">
                            {activityLabel(a.kind)}
                          </Badge>
                          <span className="min-w-0 flex-1 truncate">{a.title}</span>
                          <span className="text-xs text-muted-foreground">{statusLabel(a.status)}</span>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="px-2 pb-2">
                          <StructuredResult text={a.detail} />
                        </CollapsibleContent>
                      </Collapsible>
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              )}
              <ThreadPrimitive.Messages
                components={{
                  UserMessage: ChatMessage,
                  AssistantMessage: ChatMessage,
                  SystemMessage: ChatMessage,
                }}
              />
            </div>
            <ThreadPrimitive.ViewportFooter className="sticky bottom-0 z-10 bg-gradient-to-t from-background from-80% to-transparent pt-4">
              <ThreadPrimitive.ScrollToBottom
                className="absolute -top-8 left-1/2 flex h-8 -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full border bg-card px-3 text-xs shadow-md hover:bg-muted disabled:hidden"
                aria-label="回到底部"
              >
                <ArrowDown className="size-3.5" />
                回到底部
              </ThreadPrimitive.ScrollToBottom>
              <div className="mx-auto w-full max-w-3xl px-4 pb-4 @2xl:px-6">
                {(error || sendError) && (
                  <p className="mb-2 px-1 text-sm text-destructive" role="alert">
                    {error || sendError}
                  </p>
                )}
                {s.prompts
                  .filter((p) => p.status === 'pending')
                  .map((p) => (
                    <PromptCard
                      key={p.id}
                      prompt={p}
                      busy={busy || !c?.respond}
                      onRespond={(r) => act({ type: 'respond', promptId: p.id, ...r })}
                    />
                  ))}
                {s.queue.length > 0 && (
                  <ul
                    className="mb-2 flex max-h-32 flex-col gap-1 overflow-auto rounded-lg border bg-card p-1.5 text-sm"
                    aria-label="请求队列"
                  >
                    {s.queue.map((q) => (
                      <li key={q.id} className="flex items-center gap-2 px-1.5">
                        <span className="min-w-0 flex-1 truncate">{q.text}</span>
                        <Badge variant="secondary" className="font-normal">
                          {statusLabel(q.status)}
                        </Badge>
                        {q.error && <span className="text-xs text-destructive">{q.error}</span>}
                        {c?.cancelRequest && ['pending', 'accepted'].includes(q.status) && (
                          <Button
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            aria-label={`取消请求 ${q.text}`}
                            onClick={() => act({ type: 'cancelRequest', requestId: q.id })}
                          >
                            取消
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <Composer
                  blocked={blocked}
                  running={running}
                  upload={!!c?.upload && !!client.upload && !blocked}
                  mode={selectedMode}
                  setMode={setMode}
                  modes={{ insert: !!c?.insert, enqueue: !!c?.enqueue, priority: !!c?.priority }}
                  disabled={!allowed || sending}
                />
              </div>
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
        <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
          {infoOpen && (
            <DialogContent size="sm" title="会话信息">
              <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Agent</dt>
                <dd>{agentInfo?.name ?? s.meta.agentId}</dd>
                <dt className="text-muted-foreground">创建人</dt>
                <dd>{s.meta.creator || '—'}</dd>
                <dt className="text-muted-foreground">创建时间</dt>
                <dd>{formatTime(s.meta.createdAt)}</dd>
                <dt className="text-muted-foreground">来源</dt>
                <dd>
                  <code className="font-mono text-[12px] break-all">{s.meta.source || '工坊'}</code>
                </dd>
                <dt className="text-muted-foreground">会话 ID</dt>
                <dd>
                  <code className="font-mono text-[12px] break-all">{s.meta.id}</code>
                </dd>
              </dl>
            </DialogContent>
          )}
        </Dialog>
        <Dialog open={forkOpen} onOpenChange={setForkOpen}>
          {forkOpen && (
            <ForkPicker
              messages={s.messages}
              checkpoints={s.meta.checkpoints}
              onPick={(checkpointId) => {
                setForkOpen(false);
                act({ type: 'fork', checkpointId });
              }}
            />
          )}
        </Dialog>
        <Confirm
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title="删除这个会话？"
          description="已归档会话的消息与附件会被永久删除，无法恢复；它的分支会保留，并提升到上一级。"
          confirmText="删除会话"
          onConfirm={() => act({ type: 'delete' })}
        />
      </Presentation.Provider>
    </AssistantRuntimeProvider>
  );
}

function Composer({
  blocked,
  running,
  upload,
  mode,
  setMode,
  modes,
  disabled,
}: {
  blocked: boolean;
  running: boolean;
  upload: boolean;
  mode: string;
  setMode: (m: 'send' | 'insert' | 'enqueue' | 'priority') => void;
  modes: { insert: boolean; enqueue: boolean; priority: boolean };
  disabled: boolean;
}) {
  return (
    <ComposerPrimitive.Root className="rounded-2xl border border-input bg-card shadow-sm transition-colors focus-within:border-ring/70 focus-within:ring-3 focus-within:ring-ring/10">
      <ComposerPrimitive.AttachmentDropzone className="relative rounded-2xl data-[dragging=true]:bg-accent/40">
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5 empty:hidden">
          <ComposerPrimitive.Attachments>
            {({ attachment }) => (
              <AttachmentPrimitive.Root className="flex items-center gap-1.5 rounded-lg border bg-muted/60 py-1 pr-1 pl-2.5 text-[12px]">
                <FileText className="size-3.5 text-muted-foreground" />
                <span className="max-w-40 truncate">
                  <AttachmentPrimitive.Name />
                </span>
                <AttachmentPrimitive.Remove
                  aria-label={`移除 ${attachment.name}`}
                  className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" />
                </AttachmentPrimitive.Remove>
              </AttachmentPrimitive.Root>
            )}
          </ComposerPrimitive.Attachments>
        </div>
        <ComposerPrimitive.Input
          aria-label="消息"
          rows={1}
          placeholder={
            blocked
              ? '回来源页继续对话'
              : running
                ? '运行中，可继续补充要求…'
                : '输入消息，Enter 发送，Shift + Enter 换行'
          }
          className="block max-h-[40vh] min-h-12 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[14.5px] leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:outline-none"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2">
          {upload && (
            <Tip content="添加附件，也可直接拖入或粘贴">
              <ComposerPrimitive.AddAttachment
                aria-label="添加附件"
                className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Paperclip className="size-4" />
              </ComposerPrimitive.AddAttachment>
            </Tip>
          )}
          <span className="flex-1" />
          {running && !blocked && (
            <NativeSelect
              aria-label="发送方式"
              className="h-8 w-auto text-[12px]"
              value={mode}
              onChange={(e) => setMode(e.target.value as 'insert')}
            >
              {modes.insert && <option value="insert">运行中插话</option>}
              {modes.enqueue && <option value="enqueue">排队</option>}
              {modes.priority && <option value="priority">优先发送</option>}
            </NativeSelect>
          )}
          <UploadCancel />
          <ComposerPrimitive.Send
            aria-label="发送"
            disabled={disabled}
            className="flex size-8 cursor-pointer items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <ArrowUp className="size-4" />
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
}
function UploadCancel() {
  const submission = useAuiState((s) => s.composer.submission);
  return submission ? (
    <ComposerPrimitive.Cancel className="h-8 cursor-pointer rounded-lg px-2.5 text-[12px] text-muted-foreground hover:bg-muted">
      取消上传
    </ComposerPrimitive.Cancel>
  ) : null;
}

/**
 * Pick where to branch by reply, not by engine checkpoint ids. The new branch keeps everything up to
 * and including that reply; the original conversation is untouched.
 * 按「哪条回复之后」选择分叉位置：新分支包含到该回复为止的全部内容，原会话不变。
 */
function ForkPicker({
  messages,
  checkpoints,
  onPick,
}: {
  messages: Message[];
  checkpoints: Meta['checkpoints'];
  onPick: (checkpointId: string) => void;
}) {
  const byMessage = new Map<string, string>();
  for (const cp of checkpoints) if (cp.messageId) byMessage.set(cp.messageId, cp.id);
  const points = messages
    .map((m, i) => ({ m, i, cp: byMessage.get(m.id) }))
    .filter((x): x is { m: Message; i: number; cp: string } => !!x.cp)
    .reverse();
  const question = (i: number) => {
    for (let j = i - 1; j >= 0; j--) if (messages[j].role === 'user') return messages[j].text;
    return '';
  };
  const loose = checkpoints.filter((cp) => !cp.messageId);
  return (
    <DialogContent
      size="md"
      title="开分支"
      description="选择从哪条回复之后分出新会话。新分支保留到这条回复为止的内容，挂在当前会话下方；原会话不受影响。"
    >
      {points.length === 0 && loose.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">这个会话还没有可以分叉的回复。</p>
      )}
      <ul className="flex flex-col gap-1.5" aria-label="分叉位置">
        {points.map(({ m, i, cp }, k) => (
          <li key={cp}>
            <button
              type="button"
              onClick={() => onPick(cp)}
              className="flex w-full cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-accent/40"
            >
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <GitBranch className="size-3.5" />第 {points.length - k} 轮回复之后{k === 0 && ' · 最新'}
              </span>
              {question(i) && (
                <span className="line-clamp-1 text-[12px] text-muted-foreground">问：{question(i)}</span>
              )}
              <span className="line-clamp-2 text-sm">{m.text || '（无文本内容）'}</span>
            </button>
          </li>
        ))}
        {loose.map((cp, k) => (
          <li key={cp.id}>
            <button
              type="button"
              onClick={() => onPick(cp.id)}
              className="w-full cursor-pointer rounded-lg border border-dashed px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
            >
              运行过程中的保存点 {k + 1}
            </button>
          </li>
        ))}
      </ul>
    </DialogContent>
  );
}

/**
 * A pending engine interaction: approve a risky tool call, or answer an ask_human question.
 * The run is paused on the server until this is answered or the run ends.
 * 待处理的人工交互：审批高风险工具，或回答 ask_human 提问；回答前运行在服务端暂停。
 */
function PromptCard({
  prompt: p,
  busy,
  onRespond,
}: {
  prompt: Prompt;
  busy: boolean;
  onRespond: (r: { approved?: boolean; answer?: string }) => void;
}) {
  const [answer, setAnswer] = React.useState('');
  if (p.kind === 'approval')
    return (
      <section
        aria-label="工具审批"
        className="mb-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
      >
        <header className="flex items-center gap-2 font-medium">
          <ShieldAlert className="size-4 text-amber-600 dark:text-amber-400" />
          Agent 想调用工具 <code className="font-mono">{p.toolName}</code>
          {p.riskLevel && (
            <Badge variant="warning" className="font-normal">
              风险：{p.riskLevel}
            </Badge>
          )}
        </header>
        {p.arguments && Object.keys(p.arguments).length > 0 && (
          <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-code p-2 font-mono text-[11px] leading-relaxed">
            {JSON.stringify(p.arguments, null, 2)}
          </pre>
        )}
        <div className="mt-2.5 flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onRespond({ approved: false })}>
            拒绝
          </Button>
          <Button size="sm" disabled={busy} onClick={() => onRespond({ approved: true })}>
            允许
          </Button>
        </div>
      </section>
    );
  return (
    <section
      aria-label="Agent 提问"
      className="mb-2 rounded-xl border border-primary/40 bg-accent/30 p-3 text-sm"
    >
      <header className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="font-medium whitespace-pre-wrap">{p.question}</p>
      </header>
      {!!p.options?.length && (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
          {p.options.map((o) => (
            <Button
              key={o}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onRespond({ answer: o })}
            >
              {o}
            </Button>
          ))}
        </div>
      )}
      <form
        className="mt-2 flex gap-2 pl-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (answer.trim()) onRespond({ answer: answer.trim() });
        }}
      >
        <input
          aria-label="回答"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder={p.options?.length ? '或输入其他回答' : '输入回答'}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 text-[13px] outline-none focus-visible:border-ring"
        />
        <Button type="submit" size="sm" disabled={busy || !answer.trim()}>
          回答
        </Button>
      </form>
    </section>
  );
}
