import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { MoreHorizontal, Pencil, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import { useStudio } from '../provider';
import { skillInputSchema, type Skill, type SkillInput } from './schema';
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  Switch,
  TagInput,
  Textarea,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
} from '../ui/primitives';
import {
  Confirm,
  Dialog,
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
import { Markdown } from '../markdown';

const blank: SkillInput = {
  name: '',
  description: '',
  whenToUse: '',
  triggerKeywords: [],
  instructions: '',
  enabled: true,
};
const toInput = ({ id: _i, createdAt: _c, updatedAt: _u, ...rest }: Skill): SkillInput => rest;

export function SkillManager() {
  const { client } = useStudio();
  const q = useQuery({ queryKey: keys.skills, queryFn: ({ signal }) => client.skills.list(signal) });
  const [keyword, setKeyword] = React.useState('');
  const [editing, setEditing] = React.useState<Skill | null | undefined>();
  const [deleting, setDeleting] = React.useState<Skill>();
  const file = React.useRef<HTMLInputElement>(null);
  const importer = useAction((f: File) => client.skills.import(f), {
    invalidate: [keys.skills],
    success: (s) => `已导入技能「${s.name}」`,
  });
  const toggle = useAction((s: Skill) => client.skills.update(s.id, { ...toInput(s), enabled: !s.enabled }), {
    invalidate: [keys.skills, keys.agents],
  });
  const remove = useAction((s: Skill) => client.skills.remove(s.id), {
    invalidate: [keys.skills, keys.agents],
    success: '已删除',
  });
  const rows = (q.data ?? []).filter((s) => matches(keyword, s.name, s.description, ...s.triggerKeywords));
  return (
    <Page>
      <PageHeader
        title="Skills"
        description="可复用的技能说明（SKILL.md）。绑定到 Agent 后，模型按需加载并遵循其中的指令。"
        actions={
          <>
            <input
              ref={file}
              type="file"
              accept=".md,.zip,text/markdown,application/zip"
              className="hidden"
              aria-label="导入技能文件"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importer.mutate(f);
                e.target.value = '';
              }}
            />
            <Button variant="outline" loading={importer.isPending} onClick={() => file.current?.click()}>
              <Upload />
              导入 SKILL.md / zip
            </Button>
            <Button onClick={() => setEditing(null)}>
              <Plus />
              新建技能
            </Button>
          </>
        }
      >
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索名称、描述或触发词" />
      </PageHeader>
      <PageBody>
        <LoadState loading={q.isLoading} error={q.error} />
        {q.data && rows.length === 0 && (
          <Empty icon={<Sparkles />} title={q.data.length ? '没有匹配的技能' : '还没有技能'}>
            {!q.data.length && '新建技能，或导入一个 SKILL.md（YAML frontmatter + 指令正文）。'}
          </Empty>
        )}
        {rows.length > 0 && (
          <Table>
            <THead>
              <Tr>
                <Th className="pl-6">名称</Th>
                <Th>适用场景</Th>
                <Th>触发词</Th>
                <Th>启用</Th>
                <Th>更新时间</Th>
                <Th className="w-12 pr-6" />
              </Tr>
            </THead>
            <TBody>
              {rows.map((s) => (
                <Tr key={s.id}>
                  <Td className="max-w-xs pl-6">
                    <button type="button" className="cursor-pointer text-left" onClick={() => setEditing(s)}>
                      <span className="block font-medium hover:underline">{s.name}</span>
                      <span className="block truncate text-[12px] text-muted-foreground">
                        {s.description || '—'}
                      </span>
                    </button>
                  </Td>
                  <Td className="max-w-xs truncate text-[12px] text-muted-foreground">
                    {s.whenToUse || '—'}
                  </Td>
                  <Td>
                    <div className="flex max-w-64 flex-wrap gap-1">
                      {s.triggerKeywords.slice(0, 5).map((k) => (
                        <Badge key={k} variant="secondary" className="font-normal">
                          {k}
                        </Badge>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <Switch
                      checked={s.enabled}
                      aria-label={`启用 ${s.name}`}
                      onCheckedChange={() => toggle.mutate(s)}
                    />
                  </Td>
                  <Td className="text-[12px] whitespace-nowrap text-muted-foreground">
                    {formatTime(s.updatedAt)}
                  </Td>
                  <Td className="pr-6">
                    <Menu>
                      <MenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`${s.name} 操作`}>
                          <MoreHorizontal />
                        </Button>
                      </MenuTrigger>
                      <MenuContent>
                        <MenuItem onSelect={() => setEditing(s)}>
                          <Pencil />
                          编辑
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem destructive onSelect={() => setDeleting(s)}>
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
        {editing !== undefined && <SkillEditor skill={editing} onDone={() => setEditing(undefined)} />}
      </Dialog>
      <Confirm
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`删除技能「${deleting?.name}」？`}
        description="已绑定该技能的 Agent 会自动解除绑定。"
        onConfirm={() => remove.mutateAsync(deleting!)}
      />
    </Page>
  );
}

function SkillEditor({ skill, onDone }: { skill: Skill | null; onDone: () => void }) {
  const { client } = useStudio();
  const form = useForm<SkillInput>({
    resolver: zodResolver(skillInputSchema),
    defaultValues: skill ? toInput(skill) : blank,
  });
  const save = useAction(
    (v: SkillInput) => (skill ? client.skills.update(skill.id, v) : client.skills.create(v)),
    {
      invalidate: [keys.skills, keys.agents],
      success: skill ? '已保存' : '已创建技能',
    },
  );
  const errors = form.formState.errors;
  const [tab, setTab] = React.useState('edit');
  return (
    <SheetContent
      width="max-w-3xl"
      title={skill ? `编辑 ${skill.name}` : '新建技能'}
      description="保存为 SKILL.md，与引擎技能插件的目录格式一致。"
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
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Field
            label="名称"
            htmlFor="s-name"
            required
            error={errors.name?.message}
            hint="作为目录名，建议英文短横线命名"
          >
            <Input id="s-name" placeholder="weekly-report" {...form.register('name')} />
          </Field>
          <Field label="启用" htmlFor="s-enabled">
            <Controller
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <Switch
                  id="s-enabled"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  className="mt-2"
                />
              )}
            />
          </Field>
        </div>
        <Field label="描述" htmlFor="s-desc" hint="模型据此判断是否加载该技能">
          <Input id="s-desc" {...form.register('description')} />
        </Field>
        <Field label="适用场景" htmlFor="s-when">
          <Input id="s-when" placeholder="当用户要求整理周报时" {...form.register('whenToUse')} />
        </Field>
        <Field label="触发词" htmlFor="s-kw" hint="回车或逗号分隔">
          <Controller
            control={form.control}
            name="triggerKeywords"
            render={({ field }) => (
              <TagInput id="s-kw" value={field.value} onChange={field.onChange} placeholder="周报、总结" />
            )}
          />
        </Field>
        <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium">
              指令 <span className="text-destructive">*</span>
            </span>
            <TabsList>
              <TabsTrigger value="edit">编辑</TabsTrigger>
              <TabsTrigger value="preview">预览</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="edit">
            <Textarea
              aria-label="指令"
              rows={16}
              className="font-mono text-[12px]"
              aria-invalid={!!errors.instructions}
              placeholder={'# 步骤\n1. …'}
              {...form.register('instructions')}
            />
            {errors.instructions && (
              <p className="mt-1 text-xs text-destructive">{errors.instructions.message}</p>
            )}
          </TabsContent>
          <TabsContent value="preview" className="min-h-60 rounded-lg border p-4">
            <Markdown text={form.watch('instructions') || '（空）'} />
          </TabsContent>
        </Tabs>
      </form>
    </SheetContent>
  );
}
