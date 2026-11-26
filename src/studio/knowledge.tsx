import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useDropzone } from 'react-dropzone';
import {
  BookOpen,
  Download,
  FilePlus2,
  FileText,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { useStudio } from '../provider';
import { knowledgeInputSchema, type KnowledgeBase, type KnowledgeInput } from './schema';
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
  formatBytes,
  matches,
} from './page';
import { cn } from '../lib/utils';
import { modelGroups, modelLabel, useProviders } from './nav';

const toInput = (k: KnowledgeBase): KnowledgeInput => ({
  name: k.name,
  description: k.description,
  enabled: k.enabled,
  embeddingModel: k.embeddingModel,
});
const ACCEPT = {
  'text/*': ['.md', '.markdown', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml', '.py', '.js', '.ts'],
  'application/pdf': ['.pdf'],
};

export function KnowledgeManager() {
  const { client } = useStudio();
  const providers = useProviders();
  const q = useQuery({ queryKey: keys.knowledge, queryFn: ({ signal }) => client.knowledge.list(signal) });
  const [keyword, setKeyword] = React.useState('');
  const [editing, setEditing] = React.useState<KnowledgeBase | null | undefined>();
  const [open, setOpen] = React.useState<KnowledgeBase>();
  const [deleting, setDeleting] = React.useState<KnowledgeBase>();
  const toggle = useAction(
    (k: KnowledgeBase) => client.knowledge.update(k.id, { ...toInput(k), enabled: !k.enabled }),
    {
      invalidate: [keys.knowledge],
    },
  );
  const remove = useAction((k: KnowledgeBase) => client.knowledge.remove(k.id), {
    invalidate: [keys.knowledge, keys.agents],
    success: '已删除',
  });
  const rows = (q.data ?? []).filter((k) => matches(keyword, k.name, k.description));
  const current = open && q.data?.find((k) => k.id === open.id);
  return (
    <Page>
      <PageHeader
        title="知识库"
        description="上传 Markdown、文本或 PDF 文档。绑定到 Agent 后，对话中可检索并引用。"
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus />
            新建知识库
          </Button>
        }
      >
        <SearchBox value={keyword} onChange={setKeyword} />
      </PageHeader>
      <PageBody>
        <LoadState loading={q.isLoading} error={q.error} />
        {q.data && rows.length === 0 && (
          <Empty icon={<BookOpen />} title={q.data.length ? '没有匹配的知识库' : '还没有知识库'} />
        )}
        {rows.length > 0 && (
          <Table>
            <THead>
              <Tr>
                <Th className="pl-6">名称</Th>
                <Th>文档</Th>
                <Th>检索</Th>
                <Th>大小</Th>
                <Th>启用</Th>
                <Th>更新时间</Th>
                <Th className="w-12 pr-6" />
              </Tr>
            </THead>
            <TBody>
              {rows.map((k) => (
                <Tr key={k.id}>
                  <Td className="max-w-md pl-6">
                    <button type="button" className="cursor-pointer text-left" onClick={() => setOpen(k)}>
                      <span className="block font-medium hover:underline">{k.name}</span>
                      <span className="block truncate text-[12px] text-muted-foreground">
                        {k.description || '—'}
                      </span>
                    </button>
                  </Td>
                  <Td className="tabular-nums">{k.documentCount}</Td>
                  <Td>
                    <Badge variant={k.embeddingModel ? 'default' : 'secondary'} className="font-normal">
                      {k.embeddingModel
                        ? `向量 · ${modelLabel(providers.data, k.embeddingModel) ?? '模型不可用'}`
                        : '关键词'}
                    </Badge>
                  </Td>
                  <Td className="text-[12px] text-muted-foreground tabular-nums">
                    {formatBytes(k.totalBytes)}
                  </Td>
                  <Td>
                    <Switch
                      checked={k.enabled}
                      aria-label={`启用 ${k.name}`}
                      onCheckedChange={() => toggle.mutate(k)}
                    />
                  </Td>
                  <Td className="text-[12px] whitespace-nowrap text-muted-foreground">
                    {formatTime(k.updatedAt)}
                  </Td>
                  <Td className="pr-6">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setOpen(k)}>
                        <FileText />
                        文档
                      </Button>
                      <Menu>
                        <MenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`${k.name} 操作`}>
                            <MoreHorizontal />
                          </Button>
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem onSelect={() => setEditing(k)}>
                            <Pencil />
                            编辑信息
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem destructive onSelect={() => setDeleting(k)}>
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
        {editing !== undefined && <KnowledgeEditor base={editing} onDone={() => setEditing(undefined)} />}
      </Dialog>
      <Dialog open={!!current} onOpenChange={(o) => !o && setOpen(undefined)}>
        {current && <DocumentsSheet base={current} />}
      </Dialog>
      <Confirm
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`删除知识库「${deleting?.name}」？`}
        description="文档会一并删除，已绑定的 Agent 自动解除绑定。"
        onConfirm={() => remove.mutateAsync(deleting!)}
      />
    </Page>
  );
}

function KnowledgeEditor({ base, onDone }: { base: KnowledgeBase | null; onDone: () => void }) {
  const { client } = useStudio();
  const providers = useProviders();
  const form = useForm<KnowledgeInput>({
    resolver: zodResolver(knowledgeInputSchema),
    defaultValues: base ? toInput(base) : { name: '', description: '', enabled: true, embeddingModel: null },
  });
  const save = useAction(
    (v: KnowledgeInput) => (base ? client.knowledge.update(base.id, v) : client.knowledge.create(v)),
    {
      invalidate: [keys.knowledge],
      success: base ? '已保存' : '已创建知识库',
    },
  );
  return (
    <DialogContent
      size="sm"
      title={base ? '编辑知识库' : '新建知识库'}
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
        <Field label="名称" htmlFor="k-name" required error={form.formState.errors.name?.message}>
          <Input id="k-name" {...form.register('name')} />
        </Field>
        <Field label="描述" htmlFor="k-desc">
          <Textarea id="k-desc" rows={3} {...form.register('description')} />
        </Field>
        <Field
          label="向量模型"
          hint="选择后检索为语义向量 + 关键词混合；不选则只按关键词检索。同一 Agent 绑定的知识库须使用同一个向量模型。"
        >
          <Controller
            control={form.control}
            name="embeddingModel"
            render={({ field }) => (
              <Combobox
                aria-label="向量模型"
                value={field.value}
                onChange={field.onChange}
                groups={modelGroups(providers.data ?? [], 'embedding')}
                placeholder="不使用（仅关键词）"
                empty="没有向量模型，先在「模型」里把模型类型设为「向量」"
              />
            )}
          />
        </Field>
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
    </DialogContent>
  );
}

function DocumentsSheet({ base }: { base: KnowledgeBase }) {
  const { client } = useStudio();
  const docs = useQuery({
    queryKey: keys.documents(base.id),
    queryFn: ({ signal }) => client.knowledge.documents(base.id, signal),
  });
  const upload = useAction((f: File) => client.knowledge.upload(base.id, f), {
    invalidate: [keys.documents(base.id), keys.knowledge],
  });
  const remove = useAction((docId: string) => client.knowledge.removeDocument(base.id, docId), {
    invalidate: [keys.documents(base.id), keys.knowledge],
  });
  const [writing, setWriting] = React.useState(false);
  const dz = useDropzone({
    accept: ACCEPT,
    multiple: true,
    maxSize: 20 * 1024 * 1024,
    onDrop: async (files) => {
      for (const f of files) await upload.mutateAsync(f).catch(() => {});
    },
  });
  return (
    <SheetContent width="max-w-2xl" title={base.name} description={base.description || '管理知识库中的文档'}>
      <div className="flex flex-col gap-4">
        <div
          {...dz.getRootProps({
            className: cn(
              'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors hover:border-primary/60 hover:bg-muted/40',
              dz.isDragActive && 'border-primary bg-accent/40',
            ),
          })}
        >
          <input {...dz.getInputProps({ 'aria-label': '上传文档' })} />
          <UploadCloud className="size-7 text-muted-foreground" />
          <p className="text-sm font-medium">{upload.isPending ? '正在上传…' : '拖入文件，或点击选择'}</p>
          <p className="text-xs text-muted-foreground">支持 md、txt、pdf、json、yaml 等，单个不超过 20 MB</p>
        </div>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">文档（{docs.data?.length ?? 0}）</h3>
          <Button variant="outline" size="sm" onClick={() => setWriting(true)}>
            <FilePlus2 />
            粘贴文本
          </Button>
        </div>
        <LoadState loading={docs.isLoading} error={docs.error} />
        {docs.data?.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">还没有文档</p>
        )}
        <ul className="flex flex-col divide-y rounded-lg border empty:hidden">
          {docs.data?.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2">
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{d.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {formatBytes(d.size)} · {formatTime(d.createdAt)}
                </span>
              </span>
              <Button variant="ghost" size="icon-sm" asChild>
                <a href={client.knowledge.documentUrl(base.id, d.id)} download aria-label={`下载 ${d.title}`}>
                  <Download />
                </a>
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`删除 ${d.title}`}
                onClick={() => remove.mutate(d.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      </div>
      <Dialog open={writing} onOpenChange={setWriting}>
        {writing && <TextDocument baseId={base.id} onDone={() => setWriting(false)} />}
      </Dialog>
    </SheetContent>
  );
}
function TextDocument({ baseId, onDone }: { baseId: string; onDone: () => void }) {
  const { client } = useStudio();
  const [title, setTitle] = React.useState('');
  const [content, setContent] = React.useState('');
  const add = useAction(() => client.knowledge.addText(baseId, { title: title.trim(), content }), {
    invalidate: [keys.documents(baseId), keys.knowledge],
    success: '已添加文档',
  });
  return (
    <DialogContent
      size="lg"
      title="粘贴文本文档"
      footer={
        <>
          <Button variant="outline" onClick={onDone}>
            取消
          </Button>
          <Button
            disabled={!title.trim() || !content.trim()}
            loading={add.isPending}
            onClick={() => add.mutateAsync(undefined).then(onDone)}
          >
            添加
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="标题" htmlFor="d-title" required>
          <Input id="d-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="内容（Markdown）" htmlFor="d-content" required>
          <Textarea id="d-content" rows={14} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
      </div>
    </DialogContent>
  );
}
