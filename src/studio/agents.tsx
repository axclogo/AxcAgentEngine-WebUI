import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  Bot,
  Copy,
  Download,
  FileCheck2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  BookOpen,
  Sparkles,
  Share2,
  ChevronRight,
  Plug,
} from 'lucide-react';
import { useStudio } from '../provider';
import { agentInputSchema, type Agent, type AgentInput, type PluginInfo, type Validation } from './schema';
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  Switch,
  Textarea,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  NativeSelect,
} from '../ui/primitives';
import {
  Combobox,
  Confirm,
  Dialog,
  DialogContent,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  MultiCombobox,
  SheetContent,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/overlay';
import {
  Page,
  PageBody,
  PageHeader,
  SearchBox,
  LoadState,
  keys,
  useAction,
  formatTime,
  matches,
  formatTokens,
} from './page';
import { modelGroups, modelLabel, useNavigate, useProviders, type ModelSlot } from './nav';
import { PluginConfigForm } from './plugin-form';
import { useMcpServers } from './mcp';
import { errorText } from '../state';
import { cn } from '../lib/utils';

export const blankAgent: AgentInput = {
  name: '',
  avatar: '🤖',
  description: '',
  enabled: true,
  systemPrompt: '',
  strategy: 'react',
  runtime: {
    maxRounds: 500,
    thinking: 'auto',
    streamIdleTimeout: null,
    stepTimeout: null,
    totalTimeout: null,
    parallelToolCalls: true,
    humanInTheLoop: false,
    sessionOperations: false,
    maxWakeups: 100,
    sessionGrants: [],
  },
  models: { main: null, utility: null, vision: null },
  plugins: { compress: { enabled: true, config: {} } },
  bindings: { skills: [], knowledge: [], graph: null, mcp: [] },
};
export const agentToInput = (a: Agent): AgentInput => {
  const { id: _id, modelStatus: _m, usage: _usage, createdAt: _c, updatedAt: _u, ...rest } = a;
  return rest;
};

export function useAgents() {
  const { client } = useStudio();
  return useQuery({ queryKey: keys.agents, queryFn: ({ signal }) => client.agents.list(signal) });
}

export function AgentManager() {
  const { client } = useStudio();
  const navigate = useNavigate();
  const q = useAgents();
  const providers = useProviders();
  const [keyword, setKeyword] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [editing, setEditing] = React.useState<{ agent?: Agent; initial: AgentInput } | undefined>();
  const [deleting, setDeleting] = React.useState<Agent>();
  const toggle = useAction(
    (a: Agent) => client.agents.update(a.id, { ...agentToInput(a), enabled: !a.enabled }),
    {
      invalidate: [keys.agents],
    },
  );
  const remove = useAction((a: Agent) => client.agents.remove(a.id), {
    invalidate: [keys.agents],
    success: '已删除',
  });
  const rows = (q.data ?? []).filter(
    (a) => matches(keyword, a.name, a.description) && (!status || (status === 'on' ? a.enabled : !a.enabled)),
  );
  return (
    <Page>
      <PageHeader
        title="Agent"
        description="定义提示词、模型、运行参数、插件，以及可用的技能、知识库和图谱。"
        actions={
          <Button onClick={() => setEditing({ initial: blankAgent })}>
            <Plus />
            新建 Agent
          </Button>
        }
      >
        <SearchBox value={keyword} onChange={setKeyword} />
        <NativeSelect
          aria-label="启用状态"
          className="w-32"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="on">已启用</option>
          <option value="off">已停用</option>
        </NativeSelect>
      </PageHeader>
      <PageBody>
        <LoadState loading={q.isLoading} error={q.error} />
        {q.data && rows.length === 0 && (
          <Empty icon={<Bot />} title={q.data.length ? '没有匹配的 Agent' : '还没有 Agent'}>
            {!q.data.length && '新建一个 Agent，先在「模型」里配置可用的模型。'}
          </Empty>
        )}
        {rows.length > 0 && (
          <Table>
            <THead>
              <Tr>
                <Th className="pl-6">名称</Th>
                <Th>策略</Th>
                <Th>主模型</Th>
                <Th>绑定</Th>
                <Th title="全部对话运行累计的输入 / 输出 token">用量</Th>
                <Th>启用</Th>
                <Th>更新时间</Th>
                <Th className="w-12 pr-6" />
              </Tr>
            </THead>
            <TBody>
              {rows.map((a) => (
                <Tr key={a.id}>
                  <Td className="max-w-md pl-6">
                    <button
                      type="button"
                      className="flex cursor-pointer items-center gap-3 text-left"
                      onClick={() => setEditing({ agent: a, initial: agentToInput(a) })}
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-lg">
                        {a.avatar || '🤖'}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium hover:underline">{a.name}</span>
                        <span className="block truncate text-[12px] text-muted-foreground">
                          {a.description || '—'}
                        </span>
                      </span>
                    </button>
                  </Td>
                  <Td>
                    <Badge variant="outline">{a.strategy === 'por' ? '规划执行' : 'ReAct'}</Badge>
                  </Td>
                  <Td className="text-[12px]">
                    {a.modelStatus === 'ok' ? (
                      <span className="font-mono">
                        {modelLabel(providers.data, a.models.main) ?? a.models.main}
                      </span>
                    ) : a.modelStatus === 'missing' ? (
                      <Badge variant="destructive">模型不可用</Badge>
                    ) : (
                      <Badge variant="warning">未配置</Badge>
                    )}
                  </Td>
                  <Td>
                    <div className="flex gap-1.5 text-[12px] text-muted-foreground">
                      {a.bindings.skills.length > 0 && (
                        <span className="inline-flex items-center gap-0.5" title="技能">
                          <Sparkles className="size-3.5" />
                          {a.bindings.skills.length}
                        </span>
                      )}
                      {a.bindings.knowledge.length > 0 && (
                        <span className="inline-flex items-center gap-0.5" title="知识库">
                          <BookOpen className="size-3.5" />
                          {a.bindings.knowledge.length}
                        </span>
                      )}
                      {a.bindings.graph && (
                        <span className="inline-flex items-center gap-0.5" title="图谱">
                          <Share2 className="size-3.5" />1
                        </span>
                      )}
                      {a.bindings.mcp.length > 0 && (
                        <span className="inline-flex items-center gap-0.5" title="MCP 服务">
                          <Plug className="size-3.5" />
                          {a.bindings.mcp.length}
                        </span>
                      )}
                      {!a.bindings.skills.length &&
                        !a.bindings.knowledge.length &&
                        !a.bindings.graph &&
                        !a.bindings.mcp.length &&
                        '—'}
                    </div>
                  </Td>
                  <Td className="text-[12px] whitespace-nowrap text-muted-foreground tabular-nums">
                    {a.usage.runs ? (
                      <span title={`${a.usage.runs} 次运行`}>
                        {formatTokens(a.usage.inputTokens)} / {formatTokens(a.usage.outputTokens)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>
                    <Switch
                      checked={a.enabled}
                      aria-label={`启用 ${a.name}`}
                      onCheckedChange={() => toggle.mutate(a)}
                    />
                  </Td>
                  <Td className="text-[12px] whitespace-nowrap text-muted-foreground">
                    {formatTime(a.updatedAt)}
                  </Td>
                  <Td className="pr-6">
                    <div className="flex items-center justify-end gap-1">
                      {navigate && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!a.enabled}
                          onClick={() => navigate({ section: 'chat', id: a.id })}
                        >
                          <MessageSquare />
                          对话
                        </Button>
                      )}
                      <Menu>
                        <MenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`${a.name} 操作`}>
                            <MoreHorizontal />
                          </Button>
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem onSelect={() => setEditing({ agent: a, initial: agentToInput(a) })}>
                            <Pencil />
                            编辑
                          </MenuItem>
                          <MenuItem
                            onSelect={() =>
                              setEditing({ initial: { ...agentToInput(a), name: `${a.name} 副本` } })
                            }
                          >
                            <Copy />
                            复制为新 Agent
                          </MenuItem>
                          <MenuItem asChild>
                            <a href={client.agents.exportUrl(a.id)} download>
                              <Download />
                              导出 YAML
                            </a>
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem destructive onSelect={() => setDeleting(a)}>
                            <Trash2 />
                            删除
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </PageBody>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(undefined)}>
        {editing && (
          <AgentEditor agent={editing.agent} initial={editing.initial} onDone={() => setEditing(undefined)} />
        )}
      </Dialog>
      <Confirm
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`删除 Agent「${deleting?.name}」？`}
        description="历史会话会保留，但无法再继续对话。"
        onConfirm={() => remove.mutateAsync(deleting!)}
      />
    </Page>
  );
}

const AVATARS = ['🤖', '🧭', '🧠', '📊', '🔍', '🛠️', '📝', '🧪', '💡', '🛡️', '📚', '🌐'];

/** Agent editor sheet; also used from the chat page ("新建 Agent / 编辑"). / Agent 编辑器，对话页也复用。 */
export function AgentEditor({
  agent,
  initial,
  onDone,
}: {
  agent?: Agent;
  initial: AgentInput;
  onDone: (saved?: Agent) => void;
}) {
  const { client } = useStudio();
  const form = useForm<AgentInput>({ resolver: zodResolver(agentInputSchema), defaultValues: initial });
  const [validation, setValidation] = React.useState<Validation>();
  const [validating, setValidating] = React.useState(false);
  const save = useAction(
    (v: AgentInput) => (agent ? client.agents.update(agent.id, v) : client.agents.create(v)),
    {
      invalidate: [keys.agents],
      success: agent ? '已保存' : '已创建 Agent',
    },
  );
  const errors = form.formState.errors;
  const firstError = errors.name ? 'basic' : errors.runtime ? 'runtime' : undefined;
  const [tab, setTab] = React.useState('basic');
  React.useEffect(() => {
    if (firstError) setTab(firstError);
  }, [firstError, form.formState.submitCount]);
  return (
    <SheetContent
      width="max-w-3xl"
      title={agent ? `编辑 ${agent.name}` : '新建 Agent'}
      description="保存后立即对新会话生效；运行中的会话使用旧定义直到结束。"
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto"
            loading={validating}
            onClick={form.handleSubmit(async (v) => {
              setValidating(true);
              try {
                setValidation(await client.agents.validate(v));
              } catch (e) {
                toast.error(errorText(e));
              } finally {
                setValidating(false);
              }
            })}
          >
            <FileCheck2 />
            校验并预览 YAML
          </Button>
          <Button variant="outline" onClick={() => onDone()}>
            取消
          </Button>
          <Button
            loading={save.isPending}
            onClick={form.handleSubmit((v) => save.mutateAsync(v).then(onDone))}
          >
            保存
          </Button>
        </>
      }
    >
      <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-5">
        <TabsList className="self-start">
          <TabsTrigger value="basic">基础信息</TabsTrigger>
          <TabsTrigger value="models">模型</TabsTrigger>
          <TabsTrigger value="resources">知识与技能</TabsTrigger>
          <TabsTrigger value="runtime">运行参数</TabsTrigger>
          <TabsTrigger value="plugins">插件</TabsTrigger>
        </TabsList>
        <TabsContent value="basic" forceMount hidden={tab !== 'basic'} className="flex flex-col gap-4">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-4">
            <Field label="头像">
              <Controller
                control={form.control}
                name="avatar"
                render={({ field }) => (
                  <Menu>
                    <MenuTrigger asChild>
                      <Button variant="outline" size="icon" aria-label="选择头像" className="text-lg">
                        {field.value || '🤖'}
                      </Button>
                    </MenuTrigger>
                    <MenuContent align="start" className="grid grid-cols-6 gap-1 p-2">
                      {AVATARS.map((e) => (
                        <MenuItem
                          key={e}
                          className="justify-center text-lg"
                          onSelect={() => field.onChange(e)}
                        >
                          {e}
                        </MenuItem>
                      ))}
                    </MenuContent>
                  </Menu>
                )}
              />
            </Field>
            <Field label="名称" htmlFor="a-name" required error={errors.name?.message}>
              <Input id="a-name" placeholder="例如 情报分析助手" {...form.register('name')} />
            </Field>
          </div>
          <Field label="描述" htmlFor="a-desc" hint="出现在 Agent 列表和对话页的选择器里">
            <Input id="a-desc" {...form.register('description')} />
          </Field>
          <Field label="系统提示词" htmlFor="a-prompt" hint="描述角色、规则与输出要求，支持 Markdown">
            <Textarea
              id="a-prompt"
              rows={10}
              className="font-mono text-[12px]"
              {...form.register('systemPrompt')}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="推理策略"
              htmlFor="a-strategy"
              hint="ReAct 适合工具问答；规划执行先拆解计划再逐步完成"
            >
              <NativeSelect id="a-strategy" {...form.register('strategy')}>
                <option value="react">ReAct</option>
                <option value="por">规划执行（POR）</option>
              </NativeSelect>
            </Field>
            <Field label="启用" htmlFor="a-enabled" hint="停用后不出现在对话与推演的 Agent 列表中">
              <Controller
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <Switch id="a-enabled" checked={field.value} onCheckedChange={field.onChange} />
                )}
              />
            </Field>
          </div>
        </TabsContent>
        <TabsContent value="models" forceMount hidden={tab !== 'models'}>
          <ModelFields form={form} />
        </TabsContent>
        <TabsContent value="resources" forceMount hidden={tab !== 'resources'}>
          <ResourceFields form={form} />
        </TabsContent>
        <TabsContent value="runtime" forceMount hidden={tab !== 'runtime'}>
          <RuntimeFields form={form} />
        </TabsContent>
        <TabsContent value="plugins" forceMount hidden={tab !== 'plugins'}>
          <PluginFields form={form} />
        </TabsContent>
      </Tabs>
      <Dialog open={!!validation} onOpenChange={(o) => !o && setValidation(undefined)}>
        {validation && (
          <DialogContent
            size="lg"
            title={validation.ok ? '校验通过' : '校验未通过'}
            description={validation.ok ? '引擎可以加载这份定义。' : '请根据下列问题修改。'}
          >
            {validation.errors.length > 0 && (
              <ul className="mb-3 flex flex-col gap-1 text-sm text-destructive">
                {validation.errors.map((e, i) => (
                  <li key={i}>
                    <code className="font-mono">{e.path || '—'}</code>：{e.message}
                  </li>
                ))}
              </ul>
            )}
            <pre className="max-h-[60vh] overflow-auto rounded-lg bg-code p-3 font-mono text-[12px] leading-relaxed">
              {validation.yaml}
            </pre>
          </DialogContent>
        )}
      </Dialog>
    </SheetContent>
  );
}

const SLOTS: { slot: Exclude<ModelSlot, 'embedding'>; label: string; hint: string }[] = [
  { slot: 'main', label: '主模型', hint: '对话与工具调用使用的模型，必填才能运行' },
  { slot: 'utility', label: '辅助模型', hint: '摘要、改写、重排与评估裁判；不设置时使用主模型' },
  { slot: 'vision', label: '视觉模型', hint: '消息含图片时替代主模型；仅列出标记为「视觉」的模型' },
];
function ModelFields({ form }: { form: UseFormReturn<AgentInput> }) {
  const providers = useProviders();
  const navigate = useNavigate();
  const list = providers.data ?? [];
  return (
    <div className="flex flex-col gap-4">
      {providers.data && list.every((p) => !p.models.length) && (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          还没有可选的模型。
          {navigate && (
            <Button variant="link" size="xs" onClick={() => navigate({ section: 'models' })}>
              去添加模型提供商
            </Button>
          )}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {SLOTS.map(({ slot, label, hint }) => (
          <Field key={slot} label={label} hint={hint} required={slot === 'main'}>
            <Controller
              control={form.control}
              name={`models.${slot}`}
              render={({ field }) => (
                <Combobox
                  aria-label={label}
                  value={field.value}
                  onChange={field.onChange}
                  groups={modelGroups(list, slot)}
                  placeholder="不设置"
                  searchPlaceholder="搜索提供商或模型"
                  empty="没有符合条件的模型"
                />
              )}
            />
          </Field>
        ))}
      </div>
    </div>
  );
}

function ResourceFields({ form }: { form: UseFormReturn<AgentInput> }) {
  const { client } = useStudio();
  const skills = useQuery({ queryKey: keys.skills, queryFn: ({ signal }) => client.skills.list(signal) });
  const kbs = useQuery({ queryKey: keys.knowledge, queryFn: ({ signal }) => client.knowledge.list(signal) });
  const graphs = useQuery({ queryKey: keys.graphs, queryFn: ({ signal }) => client.graphs.list(signal) });
  const mcp = useMcpServers();
  return (
    <div className="flex flex-col gap-4">
      <Field label="技能（Skills）" hint="Agent 可按需加载这些技能的说明与脚本">
        <Controller
          control={form.control}
          name="bindings.skills"
          render={({ field }) => (
            <MultiCombobox
              aria-label="技能"
              value={field.value}
              onChange={field.onChange}
              placeholder="选择技能"
              options={(skills.data ?? []).map((s) => ({
                value: s.id,
                label: s.name,
                hint: s.enabled ? undefined : '已停用',
              }))}
            />
          )}
        />
      </Field>
      <Field label="知识库" hint="对话时可通过 knowledge_search 检索这些知识库中的文档">
        <Controller
          control={form.control}
          name="bindings.knowledge"
          render={({ field }) => (
            <MultiCombobox
              aria-label="知识库"
              value={field.value}
              onChange={field.onChange}
              placeholder="选择知识库"
              options={(kbs.data ?? []).map((k) => ({
                value: k.id,
                label: k.name,
                hint: `${k.documentCount} 篇`,
              }))}
            />
          )}
        />
      </Field>
      <Field label="图谱" hint="引擎图谱插件每个 Agent 挂载一个图谱，Agent 可检索并写入实体与关系">
        <Controller
          control={form.control}
          name="bindings.graph"
          render={({ field }) => (
            <Combobox
              aria-label="图谱"
              value={field.value}
              onChange={field.onChange}
              placeholder="不绑定"
              groups={[
                {
                  label: '图谱',
                  options: (graphs.data ?? []).map((g) => ({
                    value: g.id,
                    label: g.name,
                    hint: `${g.entityCount} 实体`,
                  })),
                },
              ]}
            />
          )}
        />
      </Field>
      <Field label="MCP 服务" hint="Agent 可以调用这些 MCP Server 提供的工具">
        <Controller
          control={form.control}
          name="bindings.mcp"
          render={({ field }) => (
            <MultiCombobox
              aria-label="MCP 服务"
              value={field.value}
              onChange={field.onChange}
              placeholder="选择 MCP 服务"
              options={(mcp.data ?? []).map((m) => ({
                value: m.id,
                label: m.name,
                hint: m.enabled ? (m.transport === 'stdio' ? '本地命令' : 'HTTP') : '已停用',
              }))}
            />
          )}
        />
      </Field>
    </div>
  );
}

function RuntimeFields({ form }: { form: UseFormReturn<AgentInput> }) {
  const num = (name: 'runtime.streamIdleTimeout' | 'runtime.stepTimeout' | 'runtime.totalTimeout') =>
    form.register(name, { setValueAs: (v) => (v === '' || v === null ? null : Number(v)) });
  const errors = form.formState.errors.runtime;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        label="最大轮数"
        htmlFor="r-rounds"
        hint="单次运行中模型调用的上限，1–100000"
        error={errors?.maxRounds?.message}
      >
        <Input
          id="r-rounds"
          type="number"
          min={1}
          max={100000}
          {...form.register('runtime.maxRounds', { valueAsNumber: true })}
        />
      </Field>
      <Field label="思考模式" htmlFor="r-thinking" hint="模型支持时开启推理过程">
        <NativeSelect id="r-thinking" {...form.register('runtime.thinking')}>
          <option value="auto">自动</option>
          <option value="always">始终开启</option>
          <option value="never">关闭</option>
        </NativeSelect>
      </Field>
      <Field label="流空闲超时（秒）" htmlFor="r-idle" hint="留空使用引擎默认 60 秒">
        <Input id="r-idle" type="number" min={1} placeholder="60" {...num('runtime.streamIdleTimeout')} />
      </Field>
      <Field label="单步超时（秒）" htmlFor="r-step" hint="留空使用引擎默认 300 秒">
        <Input id="r-step" type="number" min={1} placeholder="300" {...num('runtime.stepTimeout')} />
      </Field>
      <Field label="总超时（秒）" htmlFor="r-total" hint="留空使用引擎默认 600 秒">
        <Input id="r-total" type="number" min={1} placeholder="600" {...num('runtime.totalTimeout')} />
      </Field>
      <div />
      <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
        <span>
          <span className="block text-sm font-medium">并行工具调用</span>
          <span className="block text-xs text-muted-foreground">一次回复里可同时执行多个工具</span>
        </span>
        <Controller
          control={form.control}
          name="runtime.parallelToolCalls"
          render={({ field }) => (
            <Switch aria-label="并行工具调用" checked={field.value} onCheckedChange={field.onChange} />
          )}
        />
      </label>
      <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
        <span>
          <span className="block text-sm font-medium">人工审批</span>
          <span className="block text-xs text-muted-foreground">
            高风险工具调用前先问你；Agent 也能向你提问（ask_human）
          </span>
        </span>
        <Controller
          control={form.control}
          name="runtime.humanInTheLoop"
          render={({ field }) => (
            <Switch aria-label="人工审批" checked={field.value} onCheckedChange={field.onChange} />
          )}
        />
      </label>
      <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
        <span>
          <span className="block text-sm font-medium">允许操作其他会话</span>
          <span className="block text-xs text-muted-foreground">
            Agent 可以读取、发消息、停止或新建其他会话；每个目标第一次访问时会请你授权
          </span>
        </span>
        <Controller
          control={form.control}
          name="runtime.sessionOperations"
          render={({ field }) => (
            <Switch aria-label="允许操作其他会话" checked={field.value} onCheckedChange={field.onChange} />
          )}
        />
      </label>
      {form.watch('runtime.sessionOperations') && <SessionOperationsFields form={form} />}
    </div>
  );
}

const numberCls =
  'h-8 w-24 rounded-md border border-input bg-card px-2 text-right text-sm tabular-nums outline-none focus-visible:border-ring';
function SettingRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      {children}
    </label>
  );
}

/**
 * Session-operation settings: wake-up limit, the sessions plugin config (defaults from the engine catalog) and
 * pre-authorized access for unattended runs.
 * 会话操作设置：唤醒上限、sessions 插件配置（默认值取自引擎插件目录）、无人值守时的预先授权。
 */
function SessionOperationsFields({ form }: { form: UseFormReturn<AgentInput> }) {
  const plugins = usePlugins();
  const agents = useAgents();
  const fields = plugins.data?.find((p) => p.name === 'sessions')?.fields ?? [];
  const config = form.watch('plugins.sessions.config') ?? {};
  const grants = form.watch('runtime.sessionGrants');
  const value = (key: string) => config[key] ?? fields.find((f) => f.key === key)?.default;
  const setConfig = (key: string, v: unknown) =>
    form.setValue(
      'plugins.sessions',
      { enabled: true, config: { ...config, [key]: v } },
      { shouldDirty: true },
    );
  const setGrants = (next: AgentInput['runtime']['sessionGrants']) =>
    form.setValue('runtime.sessionGrants', next, { shouldDirty: true });
  const numberSetting = (key: string, label: string, hint: string, min: number, max: number) => (
    <SettingRow key={key} label={label} hint={hint}>
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        value={String(value(key) ?? '')}
        onChange={(e) => setConfig(key, Number(e.target.value))}
        className={numberCls}
      />
    </SettingRow>
  );
  const switchSetting = (key: string, label: string, hint: string) => (
    <SettingRow key={key} label={label} hint={hint}>
      <Switch aria-label={label} checked={value(key) === true} onCheckedChange={(v) => setConfig(key, v)} />
    </SettingRow>
  );
  return (
    <>
      <SettingRow
        label="自动唤醒上限"
        hint="后台会话完成通知让本会话多跑一步就计一次，达到后等你继续；0 为不限制"
      >
        <Controller
          control={form.control}
          name="runtime.maxWakeups"
          render={({ field }) => (
            <input
              type="number"
              aria-label="自动唤醒上限"
              min={0}
              max={100000}
              value={field.value}
              onChange={(e) => field.onChange(e.target.value === '' ? 0 : Number(e.target.value))}
              className={numberCls}
            />
          )}
        />
      </SettingRow>
      {numberSetting(
        'max_active',
        '同时运行的派发会话',
        '本会话派出去、仍在运行的会话数上限，超过直接拒绝',
        1,
        256,
      )}
      {numberSetting('max_depth', '派发层数上限', 'A 派 B、B 再派 C 算两层', 1, 20)}
      {switchSetting('allow_create', '允许新建会话', '关闭后只能操作已有会话')}
      {switchSetting('allow_operate', '允许发消息和停止', '关闭后只能读取其他会话')}
      {switchSetting('cross_agent', '允许访问其他 Agent 的会话', '关闭后只能访问同一个 Agent 的会话')}
      <section aria-label="预先授权" className="rounded-lg border p-3">
        <p className="text-sm font-medium">预先授权</p>
        <p className="mb-2 text-xs text-muted-foreground">
          无人值守的长任务用：这里列出的目标不再弹窗确认。你对某个会话的明确拒绝仍然优先。
        </p>
        <ul className="flex flex-col gap-1.5">
          {grants.map((g, i) => (
            <li key={i} className="flex items-center gap-2">
              <NativeSelect
                aria-label={`授权目标 ${i + 1}`}
                className="h-8 min-w-0 flex-1 text-sm"
                value={g.target}
                onChange={(e) =>
                  setGrants(grants.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))
                }
              >
                <option value="*">全部会话</option>
                {(agents.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} 的全部会话
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label={`授权级别 ${i + 1}`}
                className="h-8 w-28 text-sm"
                value={g.level}
                onChange={(e) =>
                  setGrants(grants.map((x, j) => (j === i ? { ...x, level: e.target.value as 'read' } : x)))
                }
              >
                <option value="read">只读</option>
                <option value="operate">读取和操作</option>
              </NativeSelect>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`删除授权 ${i + 1}`}
                onClick={() => setGrants(grants.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => setGrants([...grants, { target: '*', level: 'read' }])}
        >
          <Plus />
          添加授权
        </Button>
      </section>
    </>
  );
}

export function usePlugins() {
  const { client } = useStudio();
  return useQuery({
    queryKey: keys.plugins,
    queryFn: ({ signal }) => client.plugins(signal),
    staleTime: Infinity,
  });
}
function PluginFields({ form }: { form: UseFormReturn<AgentInput> }) {
  const plugins = usePlugins();
  const value = form.watch('plugins');
  const list = (plugins.data ?? []).filter((p) => p.kind === 'plugin' && !p.managed);
  if (plugins.isLoading) return <p className="text-sm text-muted-foreground">正在读取插件目录…</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="mb-1 text-sm text-muted-foreground">
        技能、知识库、图谱、MCP
        插件由「知识与技能」中的绑定自动启用，人工审批由「运行参数」里的开关控制。其余插件按需开启，未填写的配置使用引擎默认值。
      </p>
      {list.map((p) => (
        <PluginRow
          key={p.name}
          plugin={p}
          state={value[p.name]}
          onChange={(next) =>
            form.setValue('plugins', { ...form.getValues('plugins'), [p.name]: next }, { shouldDirty: true })
          }
        />
      ))}
    </div>
  );
}
function PluginRow({
  plugin,
  state,
  onChange,
}: {
  plugin: PluginInfo;
  state?: { enabled: boolean; config: Record<string, unknown> };
  onChange: (v: { enabled: boolean; config: Record<string, unknown> }) => void;
}) {
  const enabled = !!state?.enabled;
  const [open, setOpen] = React.useState(false);
  const fields = plugin.fields.filter((f) => f.key !== 'enabled');
  return (
    <Collapsible
      open={open && enabled}
      onOpenChange={setOpen}
      className={cn('rounded-lg border', enabled && 'border-primary/40')}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <CollapsibleTrigger
          disabled={!enabled || !fields.length}
          className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left disabled:cursor-default"
        >
          <ChevronRight
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90',
              (!enabled || !fields.length) && 'opacity-0',
            )}
          />
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-sm font-medium">
              {plugin.displayName || plugin.name}
              <code className="font-mono text-[10px] font-normal text-muted-foreground">{plugin.name}</code>
            </span>
            <span className="block truncate text-xs text-muted-foreground">{plugin.description}</span>
          </span>
        </CollapsibleTrigger>
        {enabled && fields.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {Object.keys(state?.config ?? {}).length} 项已设置
          </span>
        )}
        <Switch
          aria-label={`启用插件 ${plugin.displayName || plugin.name}`}
          checked={enabled}
          onCheckedChange={(v) => {
            onChange({ enabled: v, config: state?.config ?? {} });
            if (v) setOpen(true);
          }}
        />
      </div>
      <CollapsibleContent className="border-t px-4 py-4">
        <PluginConfigForm
          plugin={plugin.name}
          fields={fields}
          value={state?.config ?? {}}
          onChange={(config) => onChange({ enabled: true, config })}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}
