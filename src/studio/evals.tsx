import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CheckCircle2,
  ClipboardCheck,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useStudio } from '../provider';
import {
  evalInputSchema,
  evalCaseInputSchema,
  type EvalTask,
  type EvalInput,
  type EvalCaseInput,
} from './schema';
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  TagInput,
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
  Confirm,
  Dialog,
  DialogContent,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
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
} from './page';
import { useAgents } from './agents';
import { statusLabel } from '../labels';

const tone = (s: EvalTask['status']) =>
  s === 'completed' ? 'default' : s === 'failed' ? 'destructive' : s === 'running' ? 'warning' : 'secondary';

export function EvalManager() {
  const { client } = useStudio();
  const agents = useAgents();
  const q = useQuery({
    queryKey: keys.evals,
    queryFn: ({ signal }) => client.evals.list(signal),
    refetchInterval: (query) => (query.state.data?.some((e) => e.status === 'running') ? 1500 : false),
  });
  const [keyword, setKeyword] = React.useState('');
  const [editing, setEditing] = React.useState<EvalTask | null | undefined>();
  const [open, setOpen] = React.useState<string>();
  const [deleting, setDeleting] = React.useState<EvalTask>();
  const run = useAction((e: EvalTask) => client.evals.run(e.id), {
    invalidate: [keys.evals],
    success: '已开始运行',
  });
  const remove = useAction((e: EvalTask) => client.evals.remove(e.id), {
    invalidate: [keys.evals],
    success: '已删除',
  });
  const agentName = (id: string) => agents.data?.find((a) => a.id === id)?.name ?? id;
  const rows = (q.data ?? []).filter((e) => matches(keyword, e.name, e.description, agentName(e.agentId)));
  const current = q.data?.find((e) => e.id === open);
  return (
    <Page>
      <PageHeader
        title="评估"
        description="用一组用例衡量 Agent 的回答质量和工具使用；裁判模型为该 Agent 的辅助模型，6 分及以上为通过。"
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus />
            新建评估
          </Button>
        }
      >
        <SearchBox value={keyword} onChange={setKeyword} />
      </PageHeader>
      <PageBody>
        <LoadState loading={q.isLoading} error={q.error} />
        {q.data && rows.length === 0 && (
          <Empty icon={<ClipboardCheck />} title={q.data.length ? '没有匹配的评估' : '还没有评估任务'} />
        )}
        {rows.length > 0 && (
          <Table>
            <THead>
              <Tr>
                <Th className="pl-6">名称</Th>
                <Th>Agent</Th>
                <Th>用例</Th>
                <Th>状态</Th>
                <Th>平均分</Th>
                <Th>通过率</Th>
                <Th>更新时间</Th>
                <Th className="w-12 pr-6" />
              </Tr>
            </THead>
            <TBody>
              {rows.map((e) => (
                <Tr key={e.id}>
                  <Td className="max-w-sm pl-6">
                    <button type="button" className="cursor-pointer text-left" onClick={() => setOpen(e.id)}>
                      <span className="block font-medium hover:underline">{e.name}</span>
                      <span className="block truncate text-[12px] text-muted-foreground">
                        {e.description || '—'}
                      </span>
                    </button>
                  </Td>
                  <Td className="text-[12px]">{agentName(e.agentId)}</Td>
                  <Td className="tabular-nums">{e.caseCount}</Td>
                  <Td>
                    <Badge variant={tone(e.status)} title={e.error || undefined}>
                      {statusLabel(e.status)}
                    </Badge>
                  </Td>
                  <Td className="tabular-nums">
                    {e.avgScore === null ? '—' : `${e.avgScore.toFixed(1)} / 10`}
                  </Td>
                  <Td className="tabular-nums">
                    {e.passRate === null ? '—' : `${Math.round(e.passRate * 100)}%`}
                  </Td>
                  <Td className="text-[12px] whitespace-nowrap text-muted-foreground">
                    {formatTime(e.updatedAt)}
                  </Td>
                  <Td className="pr-6">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={e.status === 'running' || e.caseCount === 0}
                        onClick={() => run.mutate(e)}
                      >
                        <Play />
                        运行
                      </Button>
                      <Menu>
                        <MenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`${e.name} 操作`}>
                            <MoreHorizontal />
                          </Button>
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem onSelect={() => setOpen(e.id)}>
                            <ClipboardCheck />
                            用例与结果
                          </MenuItem>
                          <MenuItem onSelect={() => setEditing(e)}>
                            <Pencil />
                            编辑信息
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem destructive onSelect={() => setDeleting(e)}>
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
      <Dialog open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)}>
        {editing !== undefined && <EvalEditor task={editing} onDone={() => setEditing(undefined)} />}
      </Dialog>
      <Dialog open={!!current} onOpenChange={(o) => !o && setOpen(undefined)}>
        {current && <EvalDetail task={current} onRun={() => run.mutate(current)} />}
      </Dialog>
      <Confirm
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`删除评估「${deleting?.name}」？`}
        onConfirm={() => remove.mutateAsync(deleting!)}
      />
    </Page>
  );
}

function EvalEditor({ task, onDone }: { task: EvalTask | null; onDone: () => void }) {
  const { client } = useStudio();
  const agents = useAgents();
  const form = useForm<EvalInput>({
    resolver: zodResolver(evalInputSchema),
    defaultValues: task
      ? { name: task.name, agentId: task.agentId, description: task.description }
      : { name: '', agentId: '', description: '' },
  });
  const save = useAction(
    (v: EvalInput) => (task ? client.evals.update(task.id, v) : client.evals.create(v)),
    {
      invalidate: [keys.evals],
      success: task ? '已保存' : '已创建评估',
    },
  );
  const errors = form.formState.errors;
  return (
    <DialogContent
      size="sm"
      title={task ? '编辑评估' : '新建评估'}
      footer={
        <>
          <Button variant="outline" onClick={onDone}>
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
      <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
        <Field label="名称" htmlFor="ev-name" required error={errors.name?.message}>
          <Input id="ev-name" {...form.register('name')} />
        </Field>
        <Field label="Agent" htmlFor="ev-agent" required error={errors.agentId?.message}>
          <NativeSelect id="ev-agent" {...form.register('agentId')}>
            <option value="">选择 Agent</option>
            {agents.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.avatar} {a.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="描述" htmlFor="ev-desc">
          <Textarea id="ev-desc" rows={3} {...form.register('description')} />
        </Field>
      </form>
    </DialogContent>
  );
}

function EvalDetail({ task, onRun }: { task: EvalTask; onRun: () => void }) {
  const { client } = useStudio();
  const cases = useQuery({
    queryKey: keys.evalCases(task.id),
    queryFn: ({ signal }) => client.evals.cases(task.id, signal),
  });
  const results = useQuery({
    queryKey: [...keys.evalResults(task.id), task.status, task.updatedAt],
    queryFn: ({ signal }) => client.evals.results(task.id, signal),
  });
  const [adding, setAdding] = React.useState(false);
  const remove = useAction((caseId: string) => client.evals.removeCase(task.id, caseId), {
    invalidate: [keys.evalCases(task.id), keys.evals],
  });
  const resultOf = (id: string) => results.data?.find((r) => r.caseId === id);
  return (
    <SheetContent
      width="max-w-3xl"
      title={task.name}
      description={
        task.avgScore === null
          ? '尚未运行'
          : `平均 ${task.avgScore.toFixed(1)} 分 · 通过率 ${Math.round((task.passRate ?? 0) * 100)}%`
      }
      footer={
        <>
          <Button variant="outline" className="mr-auto" onClick={() => setAdding(true)}>
            <Plus />
            添加用例
          </Button>
          <Button
            disabled={task.status === 'running' || !cases.data?.length}
            loading={task.status === 'running'}
            onClick={onRun}
          >
            <Play />
            {task.status === 'running' ? '运行中' : '运行评估'}
          </Button>
        </>
      }
    >
      {task.error && (
        <p role="alert" className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {task.error}
        </p>
      )}
      <Tabs defaultValue="cases" className="flex flex-col gap-3">
        <TabsList className="self-start">
          <TabsTrigger value="cases">用例 {cases.data?.length ?? 0}</TabsTrigger>
          <TabsTrigger value="results">结果 {results.data?.length ?? 0}</TabsTrigger>
        </TabsList>
        <TabsContent value="cases">
          <LoadState loading={cases.isLoading} error={cases.error} />
          {cases.data?.length === 0 && <Empty title="还没有用例" className="py-10" />}
          <ol className="flex flex-col gap-2">
            {cases.data?.map((c, i) => {
              const r = resultOf(c.id);
              return (
                <li key={c.id} className="group rounded-lg border p-3">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 text-xs text-muted-foreground tabular-nums">#{i + 1}</span>
                    <p className="min-w-0 flex-1 text-sm whitespace-pre-wrap">{c.input}</p>
                    {r && (
                      <Badge variant={r.passed ? 'default' : 'destructive'}>
                        {r.passed ? <CheckCircle2 /> : <XCircle />}
                        {r.score.toFixed(1)}
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`删除用例 ${i + 1}`}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => remove.mutate(c.id)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  {(c.expectedOutput || c.expectedTools.length > 0) && (
                    <p className="mt-1.5 pl-6 text-[12px] text-muted-foreground">
                      {c.expectedOutput && <>期望：{c.expectedOutput}</>}
                      {c.expectedTools.length > 0 && <> · 工具：{c.expectedTools.join('、')}</>}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </TabsContent>
        <TabsContent value="results">
          {results.data?.length === 0 && (
            <Empty title="运行后在这里查看每条用例的得分与裁判理由" className="py-10" />
          )}
          <div className="flex flex-col gap-2">
            {results.data?.map((r) => (
              <Collapsible key={r.caseId} className="rounded-lg border">
                <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left">
                  <Badge variant={r.passed ? 'default' : 'destructive'}>
                    {r.passed ? <CheckCircle2 /> : <XCircle />}
                    {r.score.toFixed(1)}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-sm">{r.input}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {(r.durationMs / 1000).toFixed(1)}s
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-2 border-t px-3 py-3 text-sm">
                  {r.error && <p className="text-destructive">{r.error}</p>}
                  <div>
                    <div className="text-xs text-muted-foreground">输出</div>
                    <p className="whitespace-pre-wrap">{r.output || '—'}</p>
                  </div>
                  {r.tools.length > 0 && (
                    <div className="text-[12px] text-muted-foreground">调用工具：{r.tools.join('、')}</div>
                  )}
                  {r.reason && (
                    <div>
                      <div className="text-xs text-muted-foreground">裁判理由</div>
                      <p className="whitespace-pre-wrap text-muted-foreground">{r.reason}</p>
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        </TabsContent>
      </Tabs>
      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && <CaseEditor taskId={task.id} onDone={() => setAdding(false)} />}
      </Dialog>
    </SheetContent>
  );
}

function CaseEditor({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const { client } = useStudio();
  const form = useForm<EvalCaseInput>({
    resolver: zodResolver(evalCaseInputSchema),
    defaultValues: { input: '', expectedOutput: '', expectedTools: [] },
  });
  const save = useAction((v: EvalCaseInput) => client.evals.addCase(taskId, v), {
    invalidate: [keys.evalCases(taskId), keys.evals],
  });
  return (
    <DialogContent
      title="添加用例"
      footer={
        <>
          <Button variant="outline" onClick={onDone}>
            完成
          </Button>
          <Button
            loading={save.isPending}
            onClick={form.handleSubmit((v) =>
              save
                .mutateAsync(v)
                .then(() => form.reset({ input: '', expectedOutput: '', expectedTools: [] })),
            )}
          >
            保存并继续
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
        <Field label="输入" htmlFor="c-input" required error={form.formState.errors.input?.message}>
          <Textarea id="c-input" rows={4} {...form.register('input')} />
        </Field>
        <Field label="期望输出" htmlFor="c-expected" hint="可选；裁判据此判断回答是否正确">
          <Textarea id="c-expected" rows={3} {...form.register('expectedOutput')} />
        </Field>
        <Field label="期望调用的工具" hint="可选，例如 knowledge_search">
          <Controller
            control={form.control}
            name="expectedTools"
            render={({ field }) => (
              <TagInput aria-label="期望调用的工具" value={field.value} onChange={field.onChange} />
            )}
          />
        </Field>
      </form>
    </DialogContent>
  );
}
