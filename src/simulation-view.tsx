import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  FileText,
  ListOrdered,
  MessagesSquare,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import {
  definitionSchema,
  modes,
  resourceKey,
  type Scope,
  type SimulationDefinition,
  type Meta,
  type Filter,
  type Command,
  type Message,
} from './core';
import { useResource, errorText } from './state';
import { Markdown } from './markdown';
import { modeLabel, modeLabels, phaseLabel, statusLabel } from './labels';
import { useStudio } from './provider';
import { cn } from './lib/utils';
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  Textarea,
  NativeSelect,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  Checkbox,
} from './ui/primitives';
import {
  Confirm,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from './ui/overlay';
import { Page, PageBody, PageHeader, SearchBox, keys, formatTime } from './studio/page';

export interface SimulationDetailProps {
  scope: Scope;
  taskId: string;
  readOnly?: boolean;
  onBack?: () => void;
}
const tone = (s: string) =>
  s === 'failed'
    ? 'destructive'
    : s === 'running' || s === 'completed'
      ? 'default'
      : s === 'idle'
        ? 'secondary'
        : 'warning';
const SPEAKER = ['#2f7d6d', '#5a6fb0', '#b0702c', '#8a5aa6', '#2f8396', '#a2506a'];

/** Read-only or operable simulation detail; shared by the manager and standalone embeds. / 推演详情，管理页与独立嵌入共用。 */
export function SimulationDetail(props: SimulationDetailProps) {
  return (
    <Detail key={resourceKey({ kind: 'simulation', scope: props.scope, id: props.taskId })} {...props} />
  );
}
function useAgentNames(scope: Scope) {
  const { client } = useStudio();
  const catalog = useQuery({
    queryKey: keys.catalog(scope.key),
    queryFn: ({ signal }) => client.catalog(scope, signal),
  });
  return (id: string) => catalog.data?.agents.find((a) => a.id === id)?.name ?? id;
}
function Detail({ scope, taskId, readOnly = false, onBack }: SimulationDetailProps) {
  const { client, Link, renderMessage } = useStudio();
  const {
    snapshot: s,
    error,
    busy,
    command,
  } = useResource(client, { kind: 'simulation', scope, id: taskId });
  const name = useAgentNames(scope);
  const [target, setTarget] = React.useState('all');
  const [question, setQuestion] = React.useState('');
  const [tab, setTab] = React.useState<'process' | 'report'>('process');
  // Command failures surface through useResource's error banner. / 命令失败由 useResource 的错误横幅展示。
  const act = (c: Command) => void command(c).catch(() => {});
  if (!s)
    return (
      <section className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <p
          role={error ? 'alert' : 'status'}
          className={cn('text-sm', error ? 'text-destructive' : 'text-muted-foreground')}
        >
          {error || '正在读取推演…'}
        </p>
        {onBack && (
          <Button variant="outline" size="sm" onClick={onBack}>
            返回
          </Button>
        )}
      </section>
    );
  const d = s.meta.definition!;
  const participants = d.agents.map(name);
  const rounds = groupRounds(s.messages);
  const controls = (['start', 'pause', 'resume', 'stop'] as const).filter(
    (a) => !readOnly && s.meta.capabilities[a],
  );
  const icon = { start: Play, pause: Pause, resume: Play, stop: Square };
  return (
    <section className="@container flex h-full min-h-0 flex-col" aria-label="推演详情">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3 @2xl:px-6">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft />
            返回
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold" title={s.meta.title}>
            {s.meta.title}
          </h2>
          <p className="truncate text-[12px] text-muted-foreground">
            {modeLabel(d.mode)} · {participants.join('、')}
          </p>
        </div>
        <Badge role="status" variant={tone(s.meta.status)} className="font-normal">
          {statusLabel(s.meta.status)}
          {s.meta.round > 0 && ` · 第 ${s.meta.round} 轮`}
        </Badge>
        {controls.map((a) => {
          const Icon = icon[a];
          return (
            <Button
              key={a}
              size="sm"
              variant={a === 'start' ? 'default' : a === 'stop' ? 'outline' : 'outline'}
              className={a === 'stop' ? 'text-destructive' : undefined}
              disabled={busy}
              onClick={() => act({ type: a })}
            >
              <Icon className="!size-3.5" />
              {{ start: '启动', pause: '暂停', resume: '恢复', stop: '停止' }[a]}
            </Button>
          );
        })}
      </header>
      {error && (
        <p role="alert" className="border-b bg-destructive/10 px-6 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_auto] @4xl:grid-cols-[minmax(0,1fr)_320px] @4xl:grid-rows-1">
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'process')} className="flex min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b px-4 py-2 @2xl:px-6">
            <TabsList aria-label="阅读视图">
              <TabsTrigger value="process">
                <ListOrdered className="size-3.5" />
                过程
              </TabsTrigger>
              <TabsTrigger value="report">
                <FileText className="size-3.5" />
                报告
                {s.report !== null && (
                  <span className="size-1.5 rounded-full bg-primary" aria-label="已生成" />
                )}
              </TabsTrigger>
            </TabsList>
            {!readOnly && s.meta.capabilities.report && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto text-primary"
                disabled={busy}
                onClick={() =>
                  void command({ type: 'generateReport' })
                    .then(() => setTab('report'))
                    .catch(() => {})
                }
              >
                {s.report === null ? <FileText /> : <RefreshCw />}
                {s.report === null ? '生成报告' : '重新生成报告'}
              </Button>
            )}
          </div>
          <TabsContent
            value="process"
            forceMount
            hidden={tab !== 'process'}
            className="min-h-0 flex-1 overflow-auto"
            aria-label="推演事件流"
          >
            <div className="mx-auto max-w-3xl px-4 py-5 @2xl:px-6">
              {s.messages.length === 0 && (
                <Empty icon={<MessagesSquare />} title={s.meta.status === 'idle' ? '尚未开始' : '暂无事件'}>
                  {s.meta.status === 'idle' && '启动后，参与者的发言和系统进度会按轮次显示在这里。'}
                </Empty>
              )}
              {rounds.map((r) => (
                <section key={r.key} aria-label={r.title ?? '准备阶段'} className="mb-2">
                  {r.title && (
                    <h3 className="sticky -top-5 z-10 flex items-center gap-3 bg-background py-2 text-[12px] font-medium text-muted-foreground after:h-px after:flex-1 after:bg-border">
                      {r.title}
                    </h3>
                  )}
                  {r.messages.map((m) => (
                    <React.Fragment key={m.id}>
                      {simEvent(
                        m,
                        d.agents.indexOf(m.actor) >= 0
                          ? d.agents.indexOf(m.actor)
                          : participants.indexOf(m.actor),
                      )}
                    </React.Fragment>
                  ))}
                </section>
              ))}
            </div>
          </TabsContent>
          <TabsContent
            value="report"
            forceMount
            hidden={tab !== 'report'}
            className="min-h-0 flex-1 overflow-auto"
            aria-label="推演报告"
          >
            <article className="mx-auto max-w-3xl px-4 py-6 @2xl:px-6">
              {s.report === null ? (
                <Empty icon={<FileText />} title="尚未生成">
                  推演结束后可生成报告，在这里完整阅读。
                </Empty>
              ) : (
                <Markdown text={s.report} Link={Link} />
              )}
            </article>
          </TabsContent>
        </Tabs>
        <aside
          className="flex min-h-0 flex-col gap-5 overflow-auto border-t bg-sidebar p-4 @4xl:max-h-none @4xl:border-t-0 @4xl:border-l @max-4xl:max-h-[45%]"
          aria-label="采访与设置"
        >
          {!readOnly && s.meta.capabilities.interview && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void command({ type: 'interview', requestId: crypto.randomUUID(), target, question })
                  .then(() => {
                    setQuestion('');
                    setTab('process');
                  })
                  .catch(() => {});
              }}
            >
              <h3 className="text-sm font-semibold">采访</h3>
              <Field label="采访对象" htmlFor="sim-target">
                <NativeSelect
                  id="sim-target"
                  aria-label="采访对象"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="all">全体参与者</option>
                  {d.agents.map((a) => (
                    <option key={a} value={a}>
                      {name(a)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="问题" htmlFor="sim-question">
                <Textarea
                  id="sim-question"
                  aria-label="问题"
                  rows={3}
                  required
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                />
              </Field>
              <Button type="submit" size="sm" className="self-start" disabled={busy || !question.trim()}>
                提交采访
              </Button>
            </form>
          )}
          <section className="flex flex-col gap-2 text-sm">
            <h3 className="text-sm font-semibold">任务设置</h3>
            <dl className="flex flex-col gap-2">
              {(
                [
                  ['目标', d.objective],
                  ['议题', d.topic !== d.objective ? d.topic : ''],
                  ['背景', d.background],
                  ...(d.mode === 'redblue'
                    ? [
                        ['红方', d.redObjective],
                        ['蓝方', d.blueObjective],
                      ]
                    : []),
                  ['角色设定', d.persona],
                  ['上限', `轮次 ${d.maxRounds} · 步骤 ${d.maxSteps}`],
                ] as [string, string][]
              )
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-xs text-muted-foreground">{k}</dt>
                    <dd className="whitespace-pre-wrap">{v}</dd>
                  </div>
                ))}
            </dl>
          </section>
        </aside>
      </div>
    </section>
  );

  function simEvent(m: Message, tone: number) {
    if (m.kind === 'phase') {
      const label = phaseLabel(m.text);
      const failed = m.actor === '运行错误';
      return (
        <div
          data-message-id={m.id}
          className={cn(
            'my-1.5 flex items-baseline gap-2 text-[12px] text-muted-foreground',
            failed && 'text-destructive',
          )}
        >
          <Badge variant={failed ? 'destructive' : 'secondary'} className="font-normal">
            {failed ? m.actor : (label ?? '系统')}
          </Badge>
          {!label && (
            <span className="min-w-0 [&_.axc-md]:text-[12px]">
              {renderMessage?.(m) ?? <Markdown text={m.text} Link={Link} />}
            </span>
          )}
        </div>
      );
    }
    if (m.kind === 'interview')
      return (
        <article data-message-id={m.id} className="my-3 rounded-xl border border-dashed bg-card p-4">
          <header className="mb-1 flex items-center gap-2 text-sm">
            <Badge variant="outline" className="font-normal">
              采访
            </Badge>
            <strong>{m.target === 'all' ? '全体参与者' : name(m.target ?? '')}</strong>
          </header>
          <p className="mb-1.5 font-medium">问：{m.question}</p>
          {renderMessage?.(m) ?? <Markdown text={m.text} streaming={m.streaming} Link={Link} />}
        </article>
      );
    const color = SPEAKER[(tone >= 0 ? tone : 0) % SPEAKER.length];
    return (
      <article
        data-message-id={m.id}
        className="my-3 rounded-xl border bg-card px-4 pt-3 pb-2"
        style={{ borderLeft: `3px solid ${color}` }}
      >
        <header className="mb-1 flex items-center gap-2 text-sm">
          <span
            className="flex size-6 items-center justify-center rounded-md text-xs font-bold text-white"
            style={{ background: color }}
            aria-hidden
          >
            {m.actor.slice(0, 1).toUpperCase()}
          </span>
          <strong style={{ color }}>{m.actor}</strong>
        </header>
        {renderMessage?.(m) ?? <Markdown text={m.text} streaming={m.streaming} Link={Link} />}
      </article>
    );
  }
}
type Round = { key: string; title?: string; messages: Message[] };
// Group by engine round markers; modes without markers stay one flat group. / 按引擎轮次标记分组。
function groupRounds(messages: Message[]): Round[] {
  const out: Round[] = [];
  let n = 0;
  for (const m of messages) {
    if (m.kind === 'phase' && m.text.trim() === 'round_start') {
      n += 1;
      out.push({ key: m.id, title: `第 ${n} 轮`, messages: [] });
      continue;
    }
    if (!out.length) out.push({ key: 'lead', messages: [] });
    out[out.length - 1].messages.push(m);
  }
  return out;
}

// ---------- Form ----------
const blank: SimulationDefinition = {
  name: '',
  mode: 'discussion',
  objective: '',
  topic: '',
  background: '',
  persona: '',
  agents: [],
  maxRounds: 10,
  maxSteps: 10,
  redObjective: '',
  blueObjective: '',
};
export function SimulationForm({
  initial,
  agents,
  onSave,
  onCancel,
}: {
  initial?: SimulationDefinition;
  agents: { id: string; name: string; avatar?: string }[];
  onSave: (v: SimulationDefinition) => Promise<void>;
  onCancel: () => void;
}) {
  const [v, setV] = React.useState(initial ?? blank);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const text = (
    key: keyof SimulationDefinition,
    label: string,
    opts: { multiline?: boolean; hint?: string; wide?: boolean } = {},
  ) => (
    <Field
      key={key}
      label={label}
      htmlFor={`sf-${key}`}
      hint={opts.hint}
      className={opts.wide || opts.multiline ? 'sm:col-span-2' : undefined}
    >
      {opts.multiline ? (
        <Textarea
          id={`sf-${key}`}
          aria-label={label}
          rows={3}
          value={String(v[key])}
          onChange={(e) => setV({ ...v, [key]: e.target.value })}
        />
      ) : (
        <Input
          id={`sf-${key}`}
          aria-label={label}
          value={String(v[key])}
          onChange={(e) => setV({ ...v, [key]: e.target.value })}
        />
      )}
    </Field>
  );
  const num = (key: 'maxRounds' | 'maxSteps', label: string) => (
    <Field label={label} htmlFor={`sf-${key}`}>
      <Input
        id={`sf-${key}`}
        aria-label={label}
        type="number"
        min={1}
        max={200}
        value={String(v[key])}
        onChange={(e) => setV({ ...v, [key]: Number(e.target.value) })}
      />
    </Field>
  );
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      aria-label="推演任务表单"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        setError('');
        const parsed = definitionSchema.safeParse({ ...v, topic: v.topic.trim() || v.objective });
        if (!parsed.success) {
          setError(parsed.error.issues.map((i) => i.message).join('；'));
          return;
        }
        setBusy(true);
        void onSave(parsed.data)
          .catch((e) => setError(errorText(e)))
          .finally(() => setBusy(false));
      }}
    >
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-7">
          <h2 className="text-lg font-semibold">{initial ? '编辑推演' : '新建推演'}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {text('name', '任务名称')}
            <Field label="模式" htmlFor="sf-mode">
              <NativeSelect
                id="sf-mode"
                aria-label="模式"
                value={v.mode}
                onChange={(e) => setV({ ...v, mode: e.target.value as SimulationDefinition['mode'] })}
              >
                {Object.keys(modes).map((m) => (
                  <option key={m} value={m}>
                    {modeLabel(m)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {text('objective', '目标', { multiline: true })}
            {['group_chat', 'supervisor', 'discussion'].includes(v.mode) &&
              text('topic', '讨论议题', { hint: '留空时使用目标', wide: true })}
            <fieldset className="sm:col-span-2">
              <legend className="mb-2 text-[12px] font-medium">
                参与者{' '}
                <span className="font-normal text-muted-foreground">
                  至少 {modes[v.mode]} 名 · 已选 {v.agents.length}
                </span>
              </legend>
              <div className="flex flex-wrap gap-2">
                {agents.map((a) => {
                  const on = v.agents.includes(a.id);
                  return (
                    <label
                      key={a.id}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
                        on && 'border-primary bg-accent text-accent-foreground',
                      )}
                    >
                      <Checkbox
                        aria-label={a.name}
                        checked={on}
                        onCheckedChange={(c) =>
                          setV({
                            ...v,
                            agents: c === true ? [...v.agents, a.id] : v.agents.filter((id) => id !== a.id),
                          })
                        }
                      />
                      {a.avatar && <span aria-hidden>{a.avatar}</span>}
                      {a.name}
                    </label>
                  );
                })}
                {agents.length === 0 && <p className="text-sm text-muted-foreground">没有可用的 Agent</p>}
              </div>
            </fieldset>
            {v.mode === 'redblue' ? (
              <>
                {text('redObjective', '红方目标')}
                {text('blueObjective', '蓝方目标')}
              </>
            ) : (
              ['interview', 'social'].includes(v.mode) && text('persona', '角色设定', { wide: true })
            )}
            {text('background', '背景', { multiline: true })}
          </div>
          <fieldset className="border-t border-dashed pt-4">
            <legend className="sr-only">运行参数</legend>
            <p className="mb-3 text-[12px] text-muted-foreground">运行参数</p>
            <div className="grid max-w-md grid-cols-2 gap-4">
              {num('maxRounds', '最大轮次')}
              {num('maxSteps', '最大步骤')}
            </div>
          </fieldset>
        </div>
      </div>
      <footer className="border-t bg-background">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-6 py-3">
          {error ? (
            <p role="alert" className="flex-1 text-sm text-destructive">
              {error}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" loading={busy} className="min-w-20">
            保存
          </Button>
        </div>
      </footer>
    </form>
  );
}

// ---------- Manager ----------
export interface SimulationManagerProps {
  scope: Scope;
}
export function SimulationManager(props: SimulationManagerProps) {
  return <Manager key={props.scope.key} {...props} />;
}
function Manager({ scope }: SimulationManagerProps) {
  const { client } = useStudio();
  const qc = useQueryClient();
  const [filter, setFilter] = React.useState<Filter>({ keyword: '', mode: '', status: '' });
  const [selected, setSelected] = React.useState<string>();
  const [editing, setEditing] = React.useState<Meta | null | undefined>();
  const [deleting, setDeleting] = React.useState<Meta>();
  const [error, setError] = React.useState('');
  const catalog = useQuery({
    queryKey: keys.catalog(scope.key),
    queryFn: ({ signal }) => client.catalog(scope, signal),
  });
  const listKey = ['simulations', scope.key, filter];
  const list = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => client.list('simulation', scope, filter, signal),
  });
  const reload = () => void qc.invalidateQueries({ queryKey: ['simulations', scope.key] });
  const name = (id: string) => catalog.data?.agents.find((a) => a.id === id)?.name ?? id;
  if (selected)
    return (
      <SimulationDetail
        scope={scope}
        taskId={selected}
        onBack={() => {
          setSelected(undefined);
          reload();
        }}
      />
    );
  if (editing !== undefined)
    return (
      <Page>
        <SimulationForm
          initial={editing?.definition}
          agents={catalog.data?.agents ?? []}
          onCancel={() => setEditing(undefined)}
          onSave={async (d) => {
            await client.saveSimulation(scope, d, editing?.id);
            setEditing(undefined);
            reload();
          }}
        />
      </Page>
    );
  return (
    <Page>
      <PageHeader
        title="推演"
        description="让多个 Agent 围绕一个目标讨论、对抗或模拟，观察过程、随时采访并生成报告。"
        actions={
          catalog.data?.createSimulation && (
            <Button onClick={() => setEditing(null)}>
              <Plus />
              新建推演
            </Button>
          )
        }
      >
        <SearchBox
          value={filter.keyword}
          onChange={(keyword) => setFilter({ ...filter, keyword })}
          placeholder="搜索推演"
        />
        <NativeSelect
          aria-label="类型筛选"
          className="w-32"
          value={filter.mode}
          onChange={(e) => setFilter({ ...filter, mode: e.target.value as Filter['mode'] })}
        >
          <option value="">全部类型</option>
          {Object.keys(modes).map((m) => (
            <option key={m} value={m}>
              {modeLabels[m]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="状态筛选"
          className="w-32"
          value={filter.status}
          onChange={(e) => setFilter({ ...filter, status: e.target.value })}
        >
          <option value="">全部状态</option>
          {['idle', 'running', 'paused', 'completed', 'cancelled', 'failed'].map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </NativeSelect>
      </PageHeader>
      {(error || catalog.error || list.error) && (
        <p role="alert" className="border-b bg-destructive/10 px-6 py-2 text-sm text-destructive">
          {error || errorText(catalog.error || list.error)}
        </p>
      )}
      <PageBody>
        {list.data?.length === 0 && <Empty icon={<MessagesSquare />} title="暂无推演任务" />}
        {!!list.data?.length && (
          <Table>
            <THead>
              <Tr>
                <Th className="pl-6">任务</Th>
                <Th>类型</Th>
                <Th>参与者</Th>
                <Th>状态</Th>
                <Th>轮次</Th>
                <Th>创建时间</Th>
                <Th className="w-12 pr-6" />
              </Tr>
            </THead>
            <TBody>
              {list.data.map((m) => (
                <Tr key={m.id}>
                  <Td className="max-w-sm pl-6">
                    <button
                      type="button"
                      className="cursor-pointer text-left font-medium hover:underline"
                      onClick={() => setSelected(m.id)}
                    >
                      {m.title}
                    </button>
                  </Td>
                  <Td>
                    <Badge variant="outline" className="font-normal">
                      {modeLabel(m.definition?.mode)}
                    </Badge>
                  </Td>
                  <Td className="max-w-56 truncate text-[12px] text-muted-foreground">
                    {m.definition?.agents.map(name).join('、')}
                  </Td>
                  <Td>
                    <Badge variant={tone(m.status)} className="font-normal">
                      {statusLabel(m.status)}
                    </Badge>
                  </Td>
                  <Td className="tabular-nums">{m.round || '—'}</Td>
                  <Td className="text-[12px] whitespace-nowrap text-muted-foreground">
                    {formatTime(m.createdAt)}
                  </Td>
                  <Td className="pr-6">
                    <Menu>
                      <MenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`${m.title} 操作`}>
                          <MoreHorizontal />
                        </Button>
                      </MenuTrigger>
                      <MenuContent>
                        <MenuItem onSelect={() => setSelected(m.id)}>
                          <MessagesSquare />
                          打开
                        </MenuItem>
                        {m.capabilities.edit && (
                          <MenuItem onSelect={() => setEditing(m)}>
                            <Pencil />
                            编辑
                          </MenuItem>
                        )}
                        {m.capabilities.delete && (
                          <>
                            <MenuSeparator />
                            <MenuItem destructive onSelect={() => setDeleting(m)}>
                              <Trash2 />
                              删除 {m.title}
                            </MenuItem>
                          </>
                        )}
                      </MenuContent>
                    </Menu>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </PageBody>
      <Confirm
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`删除推演「${deleting?.title}」？`}
        onConfirm={() =>
          client
            .command({ kind: 'simulation', scope, id: deleting!.id }, { type: 'delete' })
            .then(reload)
            .catch((e) => setError(errorText(e)))
        }
      />
    </Page>
  );
}
