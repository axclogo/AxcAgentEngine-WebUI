import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  useNodesState,
  useEdgesState,
  MarkerType,
} from '@xyflow/react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
} from 'd3-force';
import { ArrowLeft, MoreHorizontal, Pencil, Plus, Share2, Trash2, Upload, Waypoints } from 'lucide-react';
import { useStudio } from '../provider';
import {
  graphInputSchema,
  entityInputSchema,
  relationInputSchema,
  type Graph,
  type GraphInput,
  type GraphData,
  type GraphEntity,
  type EntityInput,
  type RelationInput,
} from './schema';
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
import { cn } from '../lib/utils';

const toInput = (g: Graph): GraphInput => ({
  name: g.name,
  description: g.description,
  enabled: g.enabled,
  entityTypes: g.entityTypes,
  relationTypes: g.relationTypes,
});

export function GraphManager({ initialId }: { initialId?: string }) {
  const { client } = useStudio();
  const q = useQuery({ queryKey: keys.graphs, queryFn: ({ signal }) => client.graphs.list(signal) });
  const [keyword, setKeyword] = React.useState('');
  const [editing, setEditing] = React.useState<Graph | null | undefined>();
  const [deleting, setDeleting] = React.useState<Graph>();
  const [openId, setOpenId] = React.useState(initialId);
  const toggle = useAction((g: Graph) => client.graphs.update(g.id, { ...toInput(g), enabled: !g.enabled }), {
    invalidate: [keys.graphs],
  });
  const remove = useAction((g: Graph) => client.graphs.remove(g.id), {
    invalidate: [keys.graphs, keys.agents],
    success: '已删除',
  });
  const opened = openId && q.data?.find((g) => g.id === openId);
  if (opened) return <GraphView graph={opened} onBack={() => setOpenId(undefined)} />;
  const rows = (q.data ?? []).filter((g) => matches(keyword, g.name, g.description));
  return (
    <Page>
      <PageHeader
        title="图谱"
        description="维护实体与关系。绑定到 Agent 后，Agent 可检索图谱，并在对话中写入新的实体和关系。"
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus />
            新建图谱
          </Button>
        }
      >
        <SearchBox value={keyword} onChange={setKeyword} />
      </PageHeader>
      <PageBody>
        <LoadState loading={q.isLoading} error={q.error} />
        {q.data && rows.length === 0 && (
          <Empty icon={<Share2 />} title={q.data.length ? '没有匹配的图谱' : '还没有图谱'} />
        )}
        {rows.length > 0 && (
          <Table>
            <THead>
              <Tr>
                <Th className="pl-6">名称</Th>
                <Th>实体</Th>
                <Th>关系</Th>
                <Th>类型</Th>
                <Th>启用</Th>
                <Th>更新时间</Th>
                <Th className="w-12 pr-6" />
              </Tr>
            </THead>
            <TBody>
              {rows.map((g) => (
                <Tr key={g.id}>
                  <Td className="max-w-md pl-6">
                    <button
                      type="button"
                      className="cursor-pointer text-left"
                      onClick={() => setOpenId(g.id)}
                    >
                      <span className="block font-medium hover:underline">{g.name}</span>
                      <span className="block truncate text-[12px] text-muted-foreground">
                        {g.description || '—'}
                      </span>
                    </button>
                  </Td>
                  <Td className="tabular-nums">{g.entityCount}</Td>
                  <Td className="tabular-nums">{g.relationCount}</Td>
                  <Td>
                    <div className="flex max-w-56 flex-wrap gap-1">
                      {g.entityTypes.slice(0, 4).map((t) => (
                        <Badge key={t} variant="secondary" className="font-normal">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <Switch
                      checked={g.enabled}
                      aria-label={`启用 ${g.name}`}
                      onCheckedChange={() => toggle.mutate(g)}
                    />
                  </Td>
                  <Td className="text-[12px] whitespace-nowrap text-muted-foreground">
                    {formatTime(g.updatedAt)}
                  </Td>
                  <Td className="pr-6">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setOpenId(g.id)}>
                        <Waypoints />
                        查看
                      </Button>
                      <Menu>
                        <MenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`${g.name} 操作`}>
                            <MoreHorizontal />
                          </Button>
                        </MenuTrigger>
                        <MenuContent>
                          <MenuItem onSelect={() => setEditing(g)}>
                            <Pencil />
                            编辑信息
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem destructive onSelect={() => setDeleting(g)}>
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
        {editing !== undefined && <GraphEditor graph={editing} onDone={() => setEditing(undefined)} />}
      </Dialog>
      <Confirm
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={`删除图谱「${deleting?.name}」？`}
        description="所有实体和关系会一并删除。"
        onConfirm={() => remove.mutateAsync(deleting!)}
      />
    </Page>
  );
}

function GraphEditor({ graph, onDone }: { graph: Graph | null; onDone: () => void }) {
  const { client } = useStudio();
  const form = useForm<GraphInput>({
    resolver: zodResolver(graphInputSchema),
    defaultValues: graph
      ? toInput(graph)
      : {
          name: '',
          description: '',
          enabled: true,
          entityTypes: ['concept', 'person', 'organization'],
          relationTypes: ['RELATED_TO'],
        },
  });
  const save = useAction(
    (v: GraphInput) => (graph ? client.graphs.update(graph.id, v) : client.graphs.create(v)),
    {
      invalidate: [keys.graphs],
      success: graph ? '已保存' : '已创建图谱',
    },
  );
  return (
    <DialogContent
      title={graph ? '编辑图谱' : '新建图谱'}
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
        <Field label="名称" htmlFor="g-name" required error={form.formState.errors.name?.message}>
          <Input id="g-name" {...form.register('name')} />
        </Field>
        <Field label="描述" htmlFor="g-desc">
          <Textarea id="g-desc" rows={2} {...form.register('description')} />
        </Field>
        <Field label="实体类型" hint="新增实体时的可选类型">
          <Controller
            control={form.control}
            name="entityTypes"
            render={({ field }) => (
              <TagInput aria-label="实体类型" value={field.value} onChange={field.onChange} />
            )}
          />
        </Field>
        <Field label="关系类型">
          <Controller
            control={form.control}
            name="relationTypes"
            render={({ field }) => (
              <TagInput aria-label="关系类型" value={field.value} onChange={field.onChange} />
            )}
          />
        </Field>
      </form>
    </DialogContent>
  );
}

// ---------- Graph canvas ----------
const PALETTE = ['#2f7d6d', '#5a6fb0', '#b0702c', '#8a5aa6', '#2f8396', '#a2506a', '#6b7f2a'];
type EntityNodeData = { entity: GraphEntity; color: string; dim: boolean };
function EntityNode({ data, selected }: NodeProps<Node<EntityNodeData>>) {
  return (
    <div
      className={cn(
        'max-w-44 rounded-lg border bg-card px-2.5 py-1.5 text-center shadow-sm transition-opacity',
        selected && 'ring-2 ring-primary',
        data.dim && 'opacity-25',
      )}
      style={{ borderColor: data.color }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!top-1/2 !size-px !border-0 !bg-transparent !opacity-0"
      />
      <div className="truncate text-[12px] font-medium">{data.entity.name}</div>
      <div className="text-[10px]" style={{ color: data.color }}>
        {data.entity.type}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bottom-1/2 !size-px !border-0 !bg-transparent !opacity-0"
      />
    </div>
  );
}
const nodeTypes = { entity: EntityNode };

function layout(data: GraphData) {
  type N = SimulationNodeDatum & { id: string };
  const nodes: N[] = data.entities.map((e, i) => ({ id: e.id, x: Math.cos(i) * 200, y: Math.sin(i) * 200 }));
  const links = data.relations
    .filter((r) => nodes.some((n) => n.id === r.sourceId) && nodes.some((n) => n.id === r.targetId))
    .map((r) => ({ source: r.sourceId, target: r.targetId }));
  const sim = forceSimulation(nodes)
    .force(
      'link',
      forceLink(links)
        .id((d) => (d as N).id)
        .distance(150),
    )
    .force('charge', forceManyBody().strength(-500))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide(70))
    .stop();
  for (let i = 0; i < 300; i++) sim.tick();
  return new Map(nodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
}

function GraphView({ graph, onBack }: { graph: Graph; onBack: () => void }) {
  const { client } = useStudio();
  const data = useQuery({
    queryKey: keys.graphData(graph.id),
    queryFn: ({ signal }) => client.graphs.data(graph.id, signal),
  });
  const [selected, setSelected] = React.useState<string>();
  const [keyword, setKeyword] = React.useState('');
  const [dialog, setDialog] = React.useState<'entity' | 'relation' | undefined>();
  const [entityDraft, setEntityDraft] = React.useState<GraphEntity>();
  const file = React.useRef<HTMLInputElement>(null);
  const invalidate = [keys.graphData(graph.id), keys.graphs];
  const importer = useAction((f: File) => client.graphs.import(graph.id, f), {
    invalidate,
    success: '导入完成',
  });
  const removeEntity = useAction((id: string) => client.graphs.removeEntity(graph.id, id), { invalidate });
  const removeRelation = useAction((id: string) => client.graphs.removeRelation(graph.id, id), {
    invalidate,
  });
  const types = React.useMemo(
    () => [...new Set([...graph.entityTypes, ...(data.data?.entities.map((e) => e.type) ?? [])])],
    [graph.entityTypes, data.data],
  );
  const color = React.useCallback(
    (t: string) => PALETTE[Math.max(0, types.indexOf(t)) % PALETTE.length],
    [types],
  );
  const positions = React.useMemo(() => (data.data ? layout(data.data) : new Map()), [data.data]);
  const hit = React.useCallback(
    (e: GraphEntity) => !keyword.trim() || matches(keyword, e.name, e.type, e.description, ...e.aliases),
    [keyword],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<EntityNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  React.useEffect(() => {
    if (!data.data) return;
    setNodes((prev) =>
      data.data.entities.map((e) => ({
        id: e.id,
        type: 'entity',
        position: prev.find((p) => p.id === e.id)?.position ?? positions.get(e.id) ?? { x: 0, y: 0 },
        data: { entity: e, color: color(e.type), dim: !hit(e) },
        selected: e.id === selected,
      })),
    );
    setEdges(
      data.data.relations.map((r) => ({
        id: r.id,
        source: r.sourceId,
        target: r.targetId,
        label: r.relationType,
        labelStyle: { fontSize: 11, fill: 'var(--muted-foreground)' },
        labelBgStyle: { fill: 'var(--background)' },
        style: { stroke: 'var(--muted-foreground)', strokeOpacity: 0.5 },
        type: 'straight',
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        animated: r.sourceId === selected || r.targetId === selected,
      })),
    );
  }, [data.data, positions, selected, color, hit, setNodes, setEdges]);
  const entity = data.data?.entities.find((e) => e.id === selected);
  const links = data.data?.relations.filter((r) => r.sourceId === selected || r.targetId === selected) ?? [];
  const list = data.data?.entities.filter(hit) ?? [];
  return (
    <Page>
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft />
          图谱
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{graph.name}</h1>
          <p className="text-xs text-muted-foreground">
            {data.data?.entities.length ?? graph.entityCount} 个实体 ·{' '}
            {data.data?.relations.length ?? graph.relationCount} 条关系
          </p>
        </div>
        <SearchBox value={keyword} onChange={setKeyword} placeholder="高亮实体" className="w-52" />
        <input
          ref={file}
          type="file"
          accept=".jsonl,.json,application/json"
          className="hidden"
          aria-label="导入图谱文件"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importer.mutate(f);
            e.target.value = '';
          }}
        />
        <Button
          variant="outline"
          size="sm"
          loading={importer.isPending}
          onClick={() => file.current?.click()}
        >
          <Upload />
          导入 JSONL / JSON
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDialog('relation')}
          disabled={(data.data?.entities.length ?? 0) < 2}
        >
          <Waypoints />
          添加关系
        </Button>
        <Button size="sm" onClick={() => (setEntityDraft(undefined), setDialog('entity'))}>
          <Plus />
          添加实体
        </Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 @3xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="relative min-h-80 bg-muted/30">
          <LoadState loading={data.isLoading} error={data.error} />
          {data.data && data.data.entities.length === 0 && (
            <Empty className="absolute inset-0" icon={<Share2 />} title="图谱还是空的">
              添加实体，或导入 JSONL：每行一个实体 {'{"id","name","type"}'} 或关系{' '}
              {'{"source","target","relation_type"}'}。
            </Empty>
          )}
          {data.data && data.data.entities.length > 0 && (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={(_, n) => setSelected(n.id)}
              onPaneClick={() => setSelected(undefined)}
              fitView
              fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
              minZoom={0.1}
              proOptions={{ hideAttribution: true }}
              nodesConnectable={false}
            >
              <Background gap={20} size={1} />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(n) => (n.data as EntityNodeData).color}
                className="!bg-card"
              />
            </ReactFlow>
          )}
        </div>
        <aside className="flex min-h-0 flex-col border-t bg-card @3xl:border-t-0 @3xl:border-l">
          {entity ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-semibold break-words">{entity.name}</h2>
                  <Badge
                    variant="outline"
                    style={{ color: color(entity.type), borderColor: color(entity.type) }}
                  >
                    {entity.type}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="编辑实体"
                  onClick={() => (setEntityDraft(entity), setDialog('entity'))}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="删除实体"
                  onClick={() => removeEntity.mutateAsync(entity.id).then(() => setSelected(undefined))}
                >
                  <Trash2 />
                </Button>
              </div>
              {entity.description && <p className="text-sm leading-relaxed">{entity.description}</p>}
              {entity.aliases.length > 0 && (
                <p className="text-sm text-muted-foreground">别名：{entity.aliases.join('、')}</p>
              )}
              <h3 className="mt-2 text-xs font-medium text-muted-foreground">关系（{links.length}）</h3>
              <ul className="flex flex-col gap-1">
                {links.map((r) => (
                  <li
                    key={r.id}
                    className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 cursor-pointer truncate text-left"
                      onClick={() => setSelected(r.sourceId === entity.id ? r.targetId : r.sourceId)}
                    >
                      {r.sourceId === entity.id ? (
                        <>
                          <span className="text-muted-foreground">{r.relationType} →</span> {r.targetName}
                        </>
                      ) : (
                        <>
                          {r.sourceName} <span className="text-muted-foreground">→ {r.relationType}</span>
                        </>
                      )}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`删除关系 ${r.sourceName} ${r.relationType} ${r.targetName}`}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => removeRelation.mutate(r.id)}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button variant="link" size="xs" className="self-start" onClick={() => setSelected(undefined)}>
                返回实体列表
              </Button>
            </div>
          ) : (
            <Tabs defaultValue="entities" className="flex min-h-0 flex-1 flex-col">
              <div className="px-4 pt-3">
                <TabsList>
                  <TabsTrigger value="entities">实体 {list.length}</TabsTrigger>
                  <TabsTrigger value="relations">关系 {data.data?.relations.length ?? 0}</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="entities" className="min-h-0 flex-1 overflow-auto p-2">
                {list.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => setSelected(e.id)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                  >
                    <span className="size-2 shrink-0 rounded-full" style={{ background: color(e.type) }} />
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    <span className="text-xs text-muted-foreground">{e.type}</span>
                  </button>
                ))}
              </TabsContent>
              <TabsContent value="relations" className="min-h-0 flex-1 overflow-auto p-2">
                {data.data?.relations.map((r) => (
                  <div
                    key={r.id}
                    className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {r.sourceName} <span className="text-muted-foreground">—{r.relationType}→</span>{' '}
                      {r.targetName}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`删除关系 ${r.sourceName} ${r.relationType} ${r.targetName}`}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => removeRelation.mutate(r.id)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </TabsContent>
            </Tabs>
          )}
        </aside>
      </div>
      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(undefined)}>
        {dialog === 'entity' && (
          <EntityDialog
            graph={graph}
            types={types}
            entity={entityDraft}
            onDone={(id) => (setDialog(undefined), id && setSelected(id))}
          />
        )}
        {dialog === 'relation' && data.data && (
          <RelationDialog
            graph={graph}
            data={data.data}
            from={selected}
            onDone={() => setDialog(undefined)}
          />
        )}
      </Dialog>
    </Page>
  );
}

function EntityDialog({
  graph,
  types,
  entity,
  onDone,
}: {
  graph: Graph;
  types: string[];
  entity?: GraphEntity;
  onDone: (id?: string) => void;
}) {
  const { client } = useStudio();
  const form = useForm<EntityInput>({
    resolver: zodResolver(entityInputSchema),
    defaultValues: entity ?? { name: '', type: types[0] ?? 'concept', description: '', aliases: [] },
  });
  const save = useAction((v: EntityInput) => client.graphs.upsertEntity(graph.id, v), {
    invalidate: [keys.graphData(graph.id), keys.graphs],
  });
  return (
    <DialogContent
      title={entity ? '编辑实体' : '添加实体'}
      description="同名实体会合并更新。"
      footer={
        <>
          <Button variant="outline" onClick={() => onDone()}>
            取消
          </Button>
          <Button
            loading={save.isPending}
            onClick={form.handleSubmit((v) => save.mutateAsync(v).then((e) => onDone(e.id)))}
          >
            保存
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="名称" htmlFor="e-name" required error={form.formState.errors.name?.message}>
            <Input id="e-name" readOnly={!!entity} {...form.register('name')} />
          </Field>
          <Field label="类型" htmlFor="e-type">
            <Input id="e-type" list="axc-entity-types" {...form.register('type')} />
            <datalist id="axc-entity-types">
              {types.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
        </div>
        <Field label="描述" htmlFor="e-desc">
          <Textarea id="e-desc" rows={3} {...form.register('description')} />
        </Field>
        <Field label="别名">
          <Controller
            control={form.control}
            name="aliases"
            render={({ field }) => (
              <TagInput aria-label="别名" value={field.value} onChange={field.onChange} />
            )}
          />
        </Field>
      </form>
    </DialogContent>
  );
}

function RelationDialog({
  graph,
  data,
  from,
  onDone,
}: {
  graph: Graph;
  data: GraphData;
  from?: string;
  onDone: () => void;
}) {
  const { client } = useStudio();
  const form = useForm<RelationInput>({
    resolver: zodResolver(relationInputSchema),
    defaultValues: {
      source: from ?? '',
      target: '',
      relationType: graph.relationTypes[0] ?? 'RELATED_TO',
      description: '',
    },
  });
  const save = useAction((v: RelationInput) => client.graphs.addRelation(graph.id, v), {
    invalidate: [keys.graphData(graph.id), keys.graphs],
  });
  const errors = form.formState.errors;
  const options = data.entities.map((e) => (
    <option key={e.id} value={e.id}>
      {e.name}（{e.type}）
    </option>
  ));
  return (
    <DialogContent
      title="添加关系"
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
        <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-start">
          <Field label="起点" htmlFor="r-src" required error={errors.source?.message}>
            <NativeSelect id="r-src" {...form.register('source')}>
              <option value="">选择实体</option>
              {options}
            </NativeSelect>
          </Field>
          <Field label="关系" htmlFor="r-type" required error={errors.relationType?.message}>
            <Input
              id="r-type"
              list="axc-relation-types"
              className="sm:w-40"
              {...form.register('relationType')}
            />
            <datalist id="axc-relation-types">
              {graph.relationTypes.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
          <Field label="终点" htmlFor="r-dst" required error={errors.target?.message}>
            <NativeSelect id="r-dst" {...form.register('target')}>
              <option value="">选择实体</option>
              {options}
            </NativeSelect>
          </Field>
        </div>
        <Field label="描述" htmlFor="r-desc">
          <Input id="r-desc" {...form.register('description')} />
        </Field>
      </form>
    </DialogContent>
  );
}
