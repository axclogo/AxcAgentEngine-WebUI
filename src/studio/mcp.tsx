import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { MoreHorizontal, Pencil, Plug, PlugZap, Plus, Trash2 } from 'lucide-react';
import { useStudio } from '../provider';
import { mcpInputSchema, type McpInput, type McpServer, type McpTest } from './schema';
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  NativeSelect,
  Switch,
  TagInput,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  Textarea,
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
import { errorText } from '../state';

const blank: McpInput = {
  name: '',
  description: '',
  enabled: true,
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  url: '',
  headers: {},
};
/** Existing secrets come back as keys only; an empty value means "keep the stored one". / 已存密钥只回键名，空值表示保留。 */
const toInput = (m: McpServer): McpInput => ({
  name: m.name,
  description: m.description,
  enabled: m.enabled,
  transport: m.transport,
  command: m.command,
  args: m.args,
  env: Object.fromEntries(m.envKeys.map((k) => [k, ''])),
  url: m.url,
  headers: Object.fromEntries(m.headerKeys.map((k) => [k, ''])),
});

export function useMcpServers() {
  const { client } = useStudio();
  return useQuery({ queryKey: keys.mcp, queryFn: ({ signal }) => client.mcp.list(signal) });
}

export function McpManager() {
  const { client } = useStudio();
  const q = useMcpServers();
  const [keyword, setKeyword] = React.useState('');
  const [editing, setEditing] = React.useState<McpServer | null | undefined>();
  const [deleting, setDeleting] = React.useState<McpServer>();
  const [tested, setTested] = React.useState<{ server: McpServer; result: McpTest }>();
  const toggle = useAction(
    (m: McpServer) => client.mcp.update(m.id, { ...toInput(m), enabled: !m.enabled }),
    {
      invalidate: [keys.mcp, keys.agents],
    },
  );
  const remove = useAction((m: McpServer) => client.mcp.remove(m.id), {
    invalidate: [keys.mcp, keys.agents],
    success: '已删除',
  });
  const test = (m: McpServer) =>
    client.mcp
      .test(m.id)
      .then((result) => setTested({ server: m, result }))
      .catch((e) => toast.error(errorText(e)));
  const rows = (q.data ?? []).filter((m) => matches(keyword, m.name, m.description, m.command, m.url));
  return (
    <Page>
      <PageHeader
        title="MCP 服务"
        description="接入外部 MCP Server 的工具。在 Agent 的「知识与技能」里绑定后，Agent 就能调用这些工具。"
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus />
            添加 MCP 服务
          </Button>
        }
      >
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索名称、命令或地址" />
      </PageHeader>
      <PageBody>
        <LoadState loading={q.isLoading} error={q.error} />
        {q.data && rows.length === 0 && (
          <Empty icon={<Plug />} title={q.data.length ? '没有匹配的服务' : '还没有 MCP 服务'}>
            {!q.data.length && '支持本地命令（stdio）和远程地址（HTTP）两种接入方式。'}
          </Empty>
        )}
        {rows.length > 0 && (
          <Table>
            <THead>
              <Tr>
                <Th className="pl-6">名称</Th>
                <Th>接入方式</Th>
                <Th>命令 / 地址</Th>
                <Th>启用</Th>
                <Th>更新时间</Th>
                <Th className="w-12 pr-6" />
              </Tr>
            </THead>
            <TBody>
              {rows.map((m) => (
                <Tr key={m.id}>
                  <Td className="max-w-xs pl-6">
                    <button type="button" className="cursor-pointer text-left" onClick={() => setEditing(m)}>
                      <span className="block font-medium hover:underline">{m.name}</span>
                      <span className="block truncate text-[12px] text-muted-foreground">
                        {m.description || '—'}
                      </span>
                    </button>
                  </Td>
                  <Td>
                    <Badge variant="outline" className="font-normal">
                      {m.transport === 'stdio' ? '本地命令' : 'HTTP'}
                    </Badge>
                  </Td>
                  <Td className="max-w-72 truncate font-mono text-[12px] text-muted-foreground">
                    {m.transport === 'stdio' ? [m.command, ...m.args].join(' ') : m.url}
                  </Td>
                  <Td>
                    <Switch
                      checked={m.enabled}
                      aria-label={`启用 ${m.name}`}
                      onCheckedChange={() => toggle.mutate(m)}
                    />
                  </Td>
                  <Td className="text-[12px] whitespace-nowrap text-muted-foreground">
                    {formatTime(m.updatedAt)}
                  </Td>
                  <Td className="pr-6">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => void test(m)}>
                        <PlugZap />
                        测试
                      </Button>
                      <Menu>
                        <MenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`${m.name} 操作`}>
                            <MoreHorizontal />
                          </Button>
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem onSelect={() => setEditing(m)}>
                            <Pencil />
                            编辑
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem destructive onSelect={() => setDeleting(m)}>
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
        {editing !== undefined && <McpEditor server={editing} onDone={() => setEditing(undefined)} />}
      </Dialog>
      <Dialog open={!!tested} onOpenChange={(o) => !o && setTested(undefined)}>
        {tested && (
          <DialogContent
            title={tested.result.ok ? `${tested.server.name} 连接成功` : `${tested.server.name} 连接失败`}
            description={tested.result.message}
          >
            {tested.result.tools.length > 0 ? (
              <ul className="flex flex-col divide-y rounded-lg border" aria-label="MCP 工具">
                {tested.result.tools.map((t) => (
                  <li key={t.name} className="px-3 py-2">
                    <code className="font-mono text-[12px]">{t.name}</code>
                    {t.description && (
                      <p className="mt-0.5 text-[12px] text-muted-foreground">{t.description}</p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {tested.result.ok ? '服务没有提供工具。' : '请检查命令、地址和环境变量。'}
              </p>
            )}
          </DialogContent>
        )}
      </Dialog>
      <Confirm
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`删除 MCP 服务「${deleting?.name}」？`}
        description="已绑定它的 Agent 会自动解除绑定。"
        onConfirm={() => remove.mutateAsync(deleting!)}
      />
    </Page>
  );
}

function McpEditor({ server, onDone }: { server: McpServer | null; onDone: () => void }) {
  const { client } = useStudio();
  const form = useForm<McpInput>({
    resolver: zodResolver(mcpInputSchema),
    defaultValues: server ? toInput(server) : blank,
  });
  const save = useAction((v: McpInput) => (server ? client.mcp.update(server.id, v) : client.mcp.create(v)), {
    invalidate: [keys.mcp, keys.agents],
    success: server ? '已保存' : '已添加 MCP 服务',
  });
  const errors = form.formState.errors;
  const transport = form.watch('transport');
  return (
    <SheetContent
      title={server ? `编辑 ${server.name}` : '添加 MCP 服务'}
      description="环境变量和请求头的值加密保存在服务端，不会回传到浏览器。"
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
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field
            label="名称"
            htmlFor="m-name"
            required
            error={errors.name?.message}
            hint="工具名会带上这个前缀"
          >
            <Input id="m-name" placeholder="filesystem" {...form.register('name')} />
          </Field>
          <Field label="接入方式" htmlFor="m-transport">
            <NativeSelect id="m-transport" {...form.register('transport')}>
              <option value="stdio">本地命令（stdio）</option>
              <option value="http">HTTP</option>
            </NativeSelect>
          </Field>
        </div>
        <Field label="描述" htmlFor="m-desc">
          <Input id="m-desc" {...form.register('description')} />
        </Field>
        {transport === 'stdio' ? (
          <>
            <Field label="启动命令" htmlFor="m-cmd" required error={errors.command?.message}>
              <Input id="m-cmd" className="font-mono" placeholder="npx" {...form.register('command')} />
            </Field>
            <Field label="参数" hint="回车添加，按顺序传给命令">
              <Controller
                control={form.control}
                name="args"
                render={({ field }) => (
                  <TagInput
                    aria-label="参数"
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                  />
                )}
              />
            </Field>
            <KeyValueField form={form} name="env" label="环境变量" secretKeys={server?.envKeys ?? []} />
          </>
        ) : (
          <>
            <Field label="地址" htmlFor="m-url" required error={errors.url?.message}>
              <Input
                id="m-url"
                className="font-mono"
                placeholder="https://example.com/mcp"
                {...form.register('url')}
              />
            </Field>
            <KeyValueField form={form} name="headers" label="请求头" secretKeys={server?.headerKeys ?? []} />
          </>
        )}
        <label className="flex items-center gap-3 text-sm">
          <Controller
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <Switch aria-label="启用" checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
          启用
        </label>
      </form>
    </SheetContent>
  );
}

/** KEY=VALUE lines; stored keys show an empty value that keeps the secret. / 每行 KEY=VALUE，已存键留空保留原值。 */
function KeyValueField({
  form,
  name,
  label,
  secretKeys,
}: {
  form: UseFormReturn<McpInput>;
  name: 'env' | 'headers';
  label: string;
  secretKeys: string[];
}) {
  const id = `m-${name}`;
  const sep = name === 'env' ? '=' : ': ';
  const [text, setText] = React.useState(() =>
    Object.entries(form.getValues(name))
      .map(([k, v]) => `${k}${sep}${v}`)
      .join('\n'),
  );
  const [error, setError] = React.useState('');
  return (
    <Field
      label={label}
      htmlFor={id}
      error={error}
      hint={
        secretKeys.length
          ? `已保存：${secretKeys.join('、')}。值留空表示保持不变，删掉整行表示删除。`
          : `每行一个，格式 ${name === 'env' ? 'KEY=VALUE' : 'Name: value'}`
      }
    >
      <Textarea
        id={id}
        rows={3}
        className="font-mono text-[12px]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const out: Record<string, string> = {};
          for (const line of text
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)) {
            const i = line.indexOf(sep.trim());
            if (i <= 0) {
              setError(`无法解析：${line}`);
              return;
            }
            out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
          }
          setError('');
          form.setValue(name, out, { shouldDirty: true });
        }}
      />
    </Field>
  );
}
