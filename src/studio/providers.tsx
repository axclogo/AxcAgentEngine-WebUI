import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFieldArray, useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { KeyRound, MoreHorizontal, Plus, PlugZap, Server, Trash2, Pencil, Eye } from 'lucide-react';
import { useStudio } from '../provider';
import { providerInputSchema, type Provider, type ProviderInput } from './schema';
import {
  Button,
  Input,
  Switch,
  Field,
  Badge,
  Checkbox,
  Empty,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  NativeSelect,
} from '../ui/primitives';
import {
  Dialog,
  SheetContent,
  Confirm,
  Menu,
  MenuTrigger,
  MenuContent,
  MenuItem,
  MenuSeparator,
} from '../ui/overlay';
import {
  Page,
  PageHeader,
  PageBody,
  SearchBox,
  LoadState,
  keys,
  useAction,
  formatTime,
  matches,
} from './page';
import { errorText } from '../state';

const blank: ProviderInput = {
  name: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  enabled: true,
  models: [],
};

export function ProviderManager() {
  const { client } = useStudio();
  const q = useQuery({ queryKey: keys.providers, queryFn: ({ signal }) => client.providers.list(signal) });
  const [keyword, setKeyword] = React.useState('');
  const [editing, setEditing] = React.useState<Provider | null | undefined>();
  const [deleting, setDeleting] = React.useState<Provider>();
  const toggle = useAction(
    (p: Provider) => client.providers.update(p.id, { ...p, apiKey: '', enabled: !p.enabled }),
    { invalidate: [keys.providers, keys.agents] },
  );
  const remove = useAction((p: Provider) => client.providers.remove(p.id), {
    invalidate: [keys.providers, keys.agents],
    success: '已删除提供商',
  });
  const rows = (q.data ?? []).filter((p) =>
    matches(keyword, p.name, p.baseUrl, ...p.models.map((m) => m.id)),
  );
  return (
    <Page>
      <PageHeader
        title="模型"
        description="配置 OpenAI 兼容的模型服务。密钥只保存在服务端，创建 Agent 时可按提供商级联选择模型。"
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus />
            添加提供商
          </Button>
        }
      >
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索提供商、地址或模型" />
      </PageHeader>
      <PageBody>
        <LoadState loading={q.isLoading} error={q.error} />
        {q.data && rows.length === 0 && (
          <Empty icon={<Server />} title={q.data.length ? '没有匹配的提供商' : '还没有模型提供商'}>
            {!q.data.length &&
              '添加一个 OpenAI 兼容服务（OpenAI、DeepSeek、通义、Ollama、各类中转等），填写地址和 API Key。'}
          </Empty>
        )}
        {rows.length > 0 && (
          <Table>
            <THead>
              <Tr>
                <Th className="pl-6">名称</Th>
                <Th>地址</Th>
                <Th>密钥</Th>
                <Th>模型</Th>
                <Th>启用</Th>
                <Th>更新时间</Th>
                <Th className="w-12 pr-6" />
              </Tr>
            </THead>
            <TBody>
              {rows.map((p) => (
                <Tr key={p.id}>
                  <Td className="pl-6 font-medium">
                    <button
                      type="button"
                      className="cursor-pointer hover:underline"
                      onClick={() => setEditing(p)}
                    >
                      {p.name}
                    </button>
                  </Td>
                  <Td
                    className="max-w-64 truncate font-mono text-[12px] text-muted-foreground"
                    title={p.baseUrl}
                  >
                    {p.baseUrl}
                  </Td>
                  <Td className="font-mono text-[12px] text-muted-foreground">
                    {p.hasKey ? p.apiKeyMasked : <Badge variant="warning">未设置</Badge>}
                  </Td>
                  <Td>
                    <div className="flex max-w-80 flex-wrap gap-1">
                      {p.models.slice(0, 4).map((m) => (
                        <Badge key={m.id + m.type} variant="secondary" className="font-mono font-normal">
                          {m.id}
                          {m.vision && <Eye aria-label="支持视觉" />}
                        </Badge>
                      ))}
                      {p.models.length > 4 && <Badge variant="outline">+{p.models.length - 4}</Badge>}
                      {!p.models.length && <span className="text-sm text-muted-foreground">—</span>}
                    </div>
                  </Td>
                  <Td>
                    <Switch
                      checked={p.enabled}
                      aria-label={`启用 ${p.name}`}
                      onCheckedChange={() => toggle.mutate(p)}
                    />
                  </Td>
                  <Td className="text-[12px] whitespace-nowrap text-muted-foreground">
                    {formatTime(p.updatedAt)}
                  </Td>
                  <Td className="pr-6">
                    <Menu>
                      <MenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`${p.name} 操作`}>
                          <MoreHorizontal />
                        </Button>
                      </MenuTrigger>
                      <MenuContent>
                        <MenuItem onSelect={() => setEditing(p)}>
                          <Pencil />
                          编辑
                        </MenuItem>
                        <MenuItem
                          onSelect={() =>
                            void client.providers
                              .test({ id: p.id, baseUrl: p.baseUrl })
                              .then((r) => (r.ok ? toast.success(r.message) : toast.error(r.message)))
                              .catch((e) => toast.error(errorText(e)))
                          }
                        >
                          <PlugZap />
                          测试连接
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem destructive onSelect={() => setDeleting(p)}>
                          <Trash2 />
                          删除
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </PageBody>
      <Dialog open={editing !== undefined} onOpenChange={(o) => !o && setEditing(undefined)}>
        {editing !== undefined && <ProviderEditor provider={editing} onDone={() => setEditing(undefined)} />}
      </Dialog>
      <Confirm
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`删除提供商「${deleting?.name}」？`}
        description="使用该提供商模型的 Agent 将显示为模型不可用，需要重新选择。"
        onConfirm={() => remove.mutateAsync(deleting!)}
      />
    </Page>
  );
}

function ProviderEditor({ provider, onDone }: { provider: Provider | null; onDone: () => void }) {
  const { client } = useStudio();
  const form = useForm<ProviderInput>({
    resolver: zodResolver(providerInputSchema),
    defaultValues: provider ? { ...provider, apiKey: '' } : blank,
  });
  const models = useFieldArray({ control: form.control, name: 'models' });
  const [remote, setRemote] = React.useState<string[]>();
  const [testing, setTesting] = React.useState(false);
  const save = useAction(
    (v: ProviderInput) => (provider ? client.providers.update(provider.id, v) : client.providers.create(v)),
    { invalidate: [keys.providers, keys.agents], success: provider ? '已保存' : '已添加提供商' },
  );
  const errors = form.formState.errors;
  const test = async () => {
    setTesting(true);
    try {
      const r = await client.providers.test({
        id: provider?.id,
        baseUrl: form.getValues('baseUrl'),
        apiKey: form.getValues('apiKey'),
      });
      if (r.ok) {
        toast.success(r.message);
        setRemote(r.models);
      } else toast.error(r.message);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setTesting(false);
    }
  };
  const existing = new Set(form.watch('models').map((m) => m.id));
  return (
    <SheetContent
      title={provider ? `编辑 ${provider.name}` : '添加模型提供商'}
      description="支持任何 OpenAI 兼容的 /chat/completions 接口。"
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
      <form className="flex flex-col gap-5" onSubmit={(e) => e.preventDefault()}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="名称" htmlFor="p-name" required error={errors.name?.message}>
            <Input id="p-name" placeholder="例如 OpenAI、DeepSeek" {...form.register('name')} />
          </Field>
          <Field label="启用" htmlFor="p-enabled">
            <Controller
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <Switch
                  id="p-enabled"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  className="mt-2"
                />
              )}
            />
          </Field>
        </div>
        <Field
          label="API 地址"
          htmlFor="p-url"
          required
          error={errors.baseUrl?.message}
          hint="通常以 /v1 结尾"
        >
          <Input id="p-url" className="font-mono" {...form.register('baseUrl')} />
        </Field>
        <Field
          label={
            <>
              <KeyRound className="size-3.5" />
              API Key
            </>
          }
          htmlFor="p-key"
          hint={
            provider?.hasKey
              ? `已保存 ${provider.apiKeyMasked}，留空保持不变`
              : '加密保存在服务端，不会回传到浏览器'
          }
        >
          <div className="flex gap-2">
            <Input
              id="p-key"
              type="password"
              autoComplete="off"
              placeholder="sk-…"
              {...form.register('apiKey')}
            />
            <Button variant="outline" loading={testing} onClick={test}>
              <PlugZap />
              测试并获取模型
            </Button>
          </div>
        </Field>
        {remote && remote.length > 0 && (
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span>远端返回 {remote.length} 个模型，点击添加</span>
              <Button
                variant="link"
                size="xs"
                onClick={() =>
                  remote
                    .filter((m) => !existing.has(m))
                    .forEach((m) =>
                      models.append({
                        id: m,
                        label: '',
                        type: 'llm',
                        vision: false,
                        contextWindow: null,
                        inputPricePer1k: null,
                        outputPricePer1k: null,
                      }),
                    )
                }
              >
                全部添加
              </Button>
            </div>
            <div className="flex max-h-40 flex-wrap gap-1.5 overflow-auto">
              {remote.map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={existing.has(m)}
                  onClick={() =>
                    models.append({
                      id: m,
                      label: '',
                      type: 'llm',
                      vision: false,
                      contextWindow: null,
                      inputPricePer1k: null,
                      outputPricePer1k: null,
                    })
                  }
                  className="cursor-pointer rounded-md border bg-card px-2 py-0.5 font-mono text-xs hover:border-primary disabled:cursor-default disabled:opacity-40"
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">模型列表</h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                models.append({
                  id: '',
                  label: '',
                  type: 'llm',
                  vision: false,
                  contextWindow: null,
                  inputPricePer1k: null,
                  outputPricePer1k: null,
                })
              }
            >
              <Plus />
              添加模型
            </Button>
          </div>
          {models.fields.length === 0 ? (
            <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
              添加至少一个模型，Agent 才能选择它
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_6rem_3.5rem_5rem_5rem_2rem] gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                <span>模型 ID</span>
                <span>显示名</span>
                <span>类型</span>
                <span>视觉</span>
                <span title="每千 token，用于成本分析">输入价/千</span>
                <span title="每千 token，用于成本分析">输出价/千</span>
                <span />
              </div>
              {models.fields.map((f, i) => (
                <div
                  key={f.id}
                  className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_6rem_3.5rem_5rem_5rem_2rem] items-center gap-2 border-b px-3 py-1.5 last:border-0"
                >
                  <Input
                    aria-label={`模型 ${i + 1} ID`}
                    className="h-8 font-mono text-[12px]"
                    placeholder="gpt-4o-mini"
                    aria-invalid={!!errors.models?.[i]?.id}
                    {...form.register(`models.${i}.id`)}
                  />
                  <Input
                    aria-label={`模型 ${i + 1} 显示名`}
                    className="h-8"
                    placeholder="可选"
                    {...form.register(`models.${i}.label`)}
                  />
                  <NativeSelect
                    className="h-8 text-[12px]"
                    aria-label={`模型 ${i + 1} 类型`}
                    {...form.register(`models.${i}.type`)}
                  >
                    <option value="llm">对话</option>
                    <option value="embedding">向量</option>
                  </NativeSelect>
                  <Controller
                    control={form.control}
                    name={`models.${i}.vision`}
                    render={({ field }) => (
                      <Checkbox
                        aria-label={`模型 ${i + 1} 支持视觉`}
                        checked={field.value}
                        onCheckedChange={(v) => field.onChange(v === true)}
                      />
                    )}
                  />
                  <Input
                    aria-label={`模型 ${i + 1} 输入价`}
                    className="h-8 text-[12px]"
                    type="number"
                    min={0}
                    step="any"
                    placeholder="—"
                    {...form.register(`models.${i}.inputPricePer1k`, {
                      setValueAs: (v) => (v === '' || v === null ? null : Number(v)),
                    })}
                  />
                  <Input
                    aria-label={`模型 ${i + 1} 输出价`}
                    className="h-8 text-[12px]"
                    type="number"
                    min={0}
                    step="any"
                    placeholder="—"
                    {...form.register(`models.${i}.outputPricePer1k`, {
                      setValueAs: (v) => (v === '' || v === null ? null : Number(v)),
                    })}
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`删除模型 ${i + 1}`}
                    onClick={() => models.remove(i)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </form>
    </SheetContent>
  );
}
