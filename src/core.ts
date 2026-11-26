import { z } from 'zod';

export const modes = {
  group_chat: 2,
  supervisor: 2,
  debate: 2,
  redblue: 2,
  discussion: 1,
  interview: 1,
  social: 1,
  retrospective: 1,
  backcast: 1,
  sandbox: 1,
} as const;
export type Mode = keyof typeof modes;
const id = z.string().min(1);
export const definitionSchema = z
  .object({
    name: z.string().trim().min(1),
    mode: z.enum(Object.keys(modes) as [Mode, ...Mode[]]),
    objective: z.string().trim().min(1),
    topic: z.string().trim().min(1),
    background: z.string(),
    persona: z.string(),
    agents: z.array(id),
    maxRounds: z.number().int().min(1).max(200),
    maxSteps: z.number().int().min(1).max(200),
    redObjective: z.string(),
    blueObjective: z.string(),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.agents).size !== v.agents.length)
      ctx.addIssue({ code: 'custom', path: ['agents'], message: '参与者不得重复' });
    if (v.agents.length < modes[v.mode])
      ctx.addIssue({ code: 'custom', path: ['agents'], message: `至少需要 ${modes[v.mode]} 名 Agent` });
    if (v.mode === 'redblue')
      for (const field of ['redObjective', 'blueObjective'] as const) {
        if (!v[field].trim()) ctx.addIssue({ code: 'custom', path: [field], message: '红蓝目标不能为空' });
      }
  });
export type SimulationDefinition = z.infer<typeof definitionSchema>;
export const partSchema = z.object({
  id,
  kind: z.enum(['text', 'thinking', 'tool', 'artifact', 'agent']),
  text: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
});
export type MessagePart = z.infer<typeof partSchema>;
export const attachmentSchema = z.object({
  id,
  name: z.string(),
  url: z.string(),
  contentType: z.string(),
  size: z.number().int().optional(),
});
export const messageSchema = z.object({
  id,
  order: z.number(),
  role: z.enum(['user', 'assistant', 'system']),
  actor: z.string(),
  text: z.string(),
  streaming: z.boolean().optional(),
  /** notice: completion notice of a background session (sent to the model as a user message). / 后台会话完成通知。 */
  kind: z.enum(['chat', 'phase', 'interview', 'notice']),
  target: z.string().optional(),
  question: z.string().optional(),
  createdAt: z.string(),
  parts: z.array(partSchema).optional(),
  attachments: z.array(attachmentSchema).optional(),
  /** Token usage of the run that produced this assistant reply. / 生成这条回复的那次运行的 token 用量。 */
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }).optional(),
  /** Run this message belongs to. / 所属运行。 */
  runId: z.string().optional(),
  /** This user message started its run. / 该用户消息开启了一轮。 */
  startsRun: z.boolean().optional(),
  /** The engine can rewind to before this message (editable). / 引擎可回退到这条消息之前（可编辑）。 */
  rewindable: z.boolean().optional(),
  /** notice: held because the wake-up limit was reached. / 达到唤醒上限而积压。 */
  held: z.boolean().optional(),
  /** Dispatched by another conversation. / 由其他会话派发。 */
  originSessionId: z.string().optional(),
  /** notice: the background conversation that settled. / 通知来源会话。 */
  sourceSessionId: z.string().optional(),
});
export type Message = z.infer<typeof messageSchema>;
/**
 * A pending human interaction raised by the engine during a run: a tool approval (human_in_the_loop)
 * or an ask_human question. Answered with the `respond` command.
 * 运行中引擎发起的人工交互：工具审批或 ask_human 提问，用 respond 命令回答。
 */
export const promptSchema = z.object({
  id,
  order: z.number(),
  kind: z.enum(['approval', 'question', 'session_access']),
  status: z.enum(['pending', 'answered', 'expired']),
  toolName: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  riskLevel: z.string().optional(),
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
  /** session_access: the requested level and the target conversation. / 会话授权的级别与目标。 */
  level: z.enum(['read', 'operate']).optional(),
  targetSessionId: z.string().optional(),
  targetTitle: z.string().optional(),
  targetAgentId: z.string().optional(),
  targetAgentName: z.string().optional(),
  targetScope: z.string().optional(),
  /** approval: true/false; question: the answer text; session_access: session | agent | deny. */
  answer: z.union([z.boolean(), z.string()]).optional(),
  createdAt: z.string(),
});
export type Prompt = z.infer<typeof promptSchema>;
export const activitySchema = z.object({
  id,
  order: z.number(),
  kind: z.enum(['plan', 'step', 'round', 'tool', 'agent', 'artifact', 'error']),
  title: z.string(),
  status: z.string(),
  detail: z.string(),
  parentId: z.string().optional(),
});
export type Activity = z.infer<typeof activitySchema>;
export const queueSchema = z.object({
  id,
  order: z.number(),
  text: z.string(),
  status: z.enum(['pending', 'accepted', 'processing', 'cancel_requested', 'cancelled', 'failed', 'done']),
  error: z.string().optional(),
});
export type QueueItem = z.infer<typeof queueSchema>;
export const capabilitiesSchema = z.object({
  send: z.boolean(),
  insert: z.boolean(),
  enqueue: z.boolean(),
  priority: z.boolean(),
  cancelRequest: z.boolean(),
  stop: z.boolean(),
  resume: z.boolean(),
  delete: z.boolean(),
  /** Conversations: archive/unarchive; delete is only offered for archived ones. */
  archive: z.boolean().default(false),
  upload: z.boolean(),
  fork: z.boolean(),
  start: z.boolean(),
  pause: z.boolean(),
  interview: z.boolean(),
  report: z.boolean(),
  edit: z.boolean(),
  /** Answer pending prompts. / 回答待处理的人工交互。 */
  respond: z.boolean().default(false),
  /** Edit a user message and resend (per message: `startsRun && rewindable`). / 编辑重发。 */
  editMessage: z.boolean().default(false),
  /** Start a turn with notices held by the wake-up limit. / 用积压通知继续。 */
  wake: z.boolean().default(false),
  /** List / revoke session-access grants. / 查看与撤销会话授权。 */
  grants: z.boolean().default(false),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export const noCapabilities: Capabilities = Object.fromEntries(
  Object.keys(capabilitiesSchema.shape).map((k) => [k, false]),
) as Capabilities;
export const metaSchema = z.object({
  id,
  title: z.string(),
  status: z.string(),
  runId: z.string().nullable(),
  agentId: z.string(),
  source: z.string(),
  creator: z.string(),
  round: z.number(),
  capabilities: capabilitiesSchema,
  checkpoints: z.array(z.object({ id, label: z.string(), messageId: z.string().optional() })),
  definition: definitionSchema.optional(),
  /** Source conversation when this one is a fork. / 分叉来源会话。 */
  parentId: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  archived: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
  /** edited: archived because the source conversation was edited. / 因编辑源会话而归档。 */
  archivedReason: z.string().nullable().optional(),
  editedFrom: z.object({ conversationId: z.string(), messageId: z.string() }).nullable().optional(),
  forkCheckpointId: z.string().nullable().optional(),
  provenance: z
    .object({
      depth: z.number().int(),
      chain: z.array(z.string()),
      parentSessionId: z.string().nullable(),
      parentRunId: z.string().nullable(),
      rootSessionId: z.string().nullable(),
    })
    .optional(),
  autoWakeups: z.number().int().optional(),
  /** The agent's wake-up limit (0 = unlimited). / Agent 的自动唤醒上限。 */
  maxWakeups: z.number().int().nullable().optional(),
});
export type Meta = z.infer<typeof metaSchema>;
export const snapshotSchema = z.object({
  seq: z.number().int().nonnegative(),
  meta: metaSchema,
  messages: z.array(messageSchema),
  activities: z.array(activitySchema),
  queue: z.array(queueSchema),
  prompts: z.array(promptSchema),
  report: z.string().nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const eventSchema = z.discriminatedUnion('kind', [
  z.object({ seq: z.number().int().positive(), kind: z.literal('meta'), value: metaSchema }),
  z.object({ seq: z.number().int().positive(), kind: z.literal('message'), value: messageSchema }),
  z.object({ seq: z.number().int().positive(), kind: z.literal('activity'), value: activitySchema }),
  z.object({ seq: z.number().int().positive(), kind: z.literal('queue'), value: queueSchema }),
  z.object({ seq: z.number().int().positive(), kind: z.literal('report'), value: z.string().nullable() }),
  z.object({ seq: z.number().int().positive(), kind: z.literal('prompt'), value: promptSchema }),
  /** Remove items by id (edit and resend). / 按 id 移除条目（编辑重发）。 */
  z.object({
    seq: z.number().int().positive(),
    kind: z.literal('remove'),
    value: z.object({
      messages: z.array(z.string()).optional(),
      activities: z.array(z.string()).optional(),
      queue: z.array(z.string()).optional(),
      prompts: z.array(z.string()).optional(),
    }),
  }),
]);
export type ResourceEvent = z.infer<typeof eventSchema>;
export type Scope = { key: string; shortcut?: { shortcut_key: string; context: Record<string, unknown> } };
export type Resource = { kind: 'conversation' | 'simulation'; scope: Scope; id: string };
export const resourceKey = (r: Resource) => JSON.stringify([r.kind, r.scope.key, r.id]);
export type Command =
  | {
      type: 'send';
      requestId: string;
      text: string;
      attachments: Attachment[];
      mode: 'send' | 'insert' | 'enqueue' | 'priority';
    }
  | { type: 'cancelRequest'; requestId: string }
  | { type: 'stop' | 'resume' | 'start' | 'pause' | 'delete' | 'archive' | 'unarchive' | 'generateReport' }
  | { type: 'fork'; checkpointId: string }
  | { type: 'interview'; requestId: string; target: string; question: string }
  | { type: 'respond'; promptId: string; approved?: boolean; answer?: string; choice?: AccessChoice }
  | { type: 'editPreview'; messageId: string }
  | { type: 'editMessage'; messageId: string; requestId: string; text: string; attachments: Attachment[] }
  | { type: 'wake' | 'listGrants' }
  | { type: 'revokeGrant'; grantId: string };
export type AccessChoice = 'session' | 'agent' | 'deny';
export const grantSchema = z.object({
  id: z.string(),
  targetType: z.enum(['session', 'agent']),
  targetId: z.string(),
  targetTitle: z.string(),
  level: z.enum(['read', 'operate']),
  decision: z.enum(['granted', 'denied']),
  reason: z.string(),
  createdAt: z.string(),
});
export type Grant = z.infer<typeof grantSchema>;
export interface EditPreview {
  messages: number;
  branches: number;
  sessions: number;
}
export interface CommandResult {
  events?: ResourceEvent[];
  resource?: Resource;
  preview?: EditPreview;
  grants?: Grant[];
}
export type Attachment = z.infer<typeof attachmentSchema>;
export interface Option {
  id: string;
  name: string;
  avatar?: string;
}
export interface Catalog {
  agents: Option[];
  defaultAgentId: string;
  create: boolean;
  createSimulation: boolean;
}
export interface Filter {
  keyword: string;
  mode: Mode | '';
  status: string;
  agentId?: string;
}
export interface Host {
  catalog(scope: Scope, signal: AbortSignal): Promise<Catalog>;
  list(kind: Resource['kind'], scope: Scope, filter: Filter, signal: AbortSignal): Promise<Meta[]>;
  snapshot(resource: Resource, signal: AbortSignal): Promise<Snapshot>;
  subscribe(
    resource: Resource,
    receive: (event: ResourceEvent) => void,
    reconnect: () => void,
    error: (error: Error) => void,
  ): () => void;
  command(resource: Resource, command: Command): Promise<CommandResult>;
  create(scope: Scope, agentId: string): Promise<Meta>;
  saveSimulation(scope: Scope, definition: SimulationDefinition, id?: string): Promise<Meta>;
  upload?(resource: Resource, file: File, signal: AbortSignal): Promise<Attachment>;
}

function upsert<T extends { id: string; order: number }>(items: T[], item: T): T[] {
  return [...items.filter((x) => x.id !== item.id), item].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
}
export function applyEvent(s: Snapshot, e: ResourceEvent): Snapshot {
  const next = { ...s, seq: e.seq };
  switch (e.kind) {
    case 'meta':
      return { ...next, meta: e.value };
    case 'message':
      return { ...next, messages: upsert(s.messages, e.value) };
    case 'activity':
      return { ...next, activities: upsert(s.activities, e.value) };
    case 'queue':
      return { ...next, queue: upsert(s.queue, e.value) };
    case 'report':
      return { ...next, report: e.value };
    case 'prompt':
      return { ...next, prompts: upsert(s.prompts, e.value) };
    case 'remove': {
      const drop = <T extends { id: string }>(items: T[], ids?: string[]) =>
        ids?.length ? items.filter((x) => !ids.includes(x.id)) : items;
      return {
        ...next,
        messages: drop(s.messages, e.value.messages),
        activities: drop(s.activities, e.value.activities),
        queue: drop(s.queue, e.value.queue),
        prompts: drop(s.prompts, e.value.prompts),
      };
    }
  }
}
// Replay only events newer than the authoritative snapshot. / 仅重放晚于权威快照的事件。
export class ResourceStore {
  private base: Snapshot | null = null;
  private events = new Map<number, ResourceEvent>();
  value: Snapshot | null = null;
  snapshot(snapshot: Snapshot) {
    if (this.base && snapshot.seq < this.base.seq) return;
    this.base = snapshot;
    for (const seq of this.events.keys()) if (seq <= snapshot.seq) this.events.delete(seq);
    this.rebuild();
  }
  event(event: ResourceEvent) {
    if (event.seq <= (this.base?.seq ?? -1) || this.events.has(event.seq)) return;
    this.events.set(event.seq, event);
    this.rebuild();
  }
  private rebuild() {
    this.value =
      this.base && [...this.events.values()].sort((a, b) => a.seq - b.seq).reduce(applyEvent, this.base);
  }
}
