// Management contract shared by the SDK and any host. JSON field names are camelCase.
// 管理端协议：SDK 与宿主共用，JSON 字段统一 camelCase。
import { z } from 'zod';

const id = z.string().min(1);
const timestamps = { createdAt: z.string(), updatedAt: z.string() };

// ---------- Model providers / 模型提供商 ----------
export const modelTypes = ['llm', 'embedding', 'image'] as const;
export const modelEntrySchema = z.object({
  id: z.string().trim().min(1, '模型 ID 不能为空'),
  label: z.string(),
  type: z.enum(modelTypes),
  vision: z.boolean(),
  contextWindow: z.number().int().positive().nullable(),
});
export type ModelEntry = z.infer<typeof modelEntrySchema>;
export const providerSchema = z.object({
  id,
  name: z.string(),
  baseUrl: z.string(),
  /** Masked secret such as `sk-••••abcd`; plaintext never leaves the server. / 掩码后的密钥，明文不离开服务端。 */
  apiKeyMasked: z.string(),
  hasKey: z.boolean(),
  enabled: z.boolean(),
  models: z.array(modelEntrySchema),
  ...timestamps,
});
export type Provider = z.infer<typeof providerSchema>;
export const providerInputSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空'),
  baseUrl: z.string().trim().url('请输入完整 URL，例如 https://api.openai.com/v1'),
  /** Empty string keeps the stored key on update. / 编辑时留空表示保留原密钥。 */
  apiKey: z.string(),
  enabled: z.boolean(),
  models: z.array(modelEntrySchema).max(500),
});
export type ProviderInput = z.infer<typeof providerInputSchema>;
export const providerTestSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  models: z.array(z.string()),
});
export type ProviderTest = z.infer<typeof providerTestSchema>;
/** `${providerId}:${modelId}` */
export type ModelRef = string;

// ---------- Plugins / 插件目录 ----------
export interface PluginField {
  key: string;
  label: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  default: unknown;
  required: boolean;
  enum: unknown[];
  children: PluginField[];
  itemSchema: PluginField | null;
  advanced: boolean;
}
export const pluginFieldSchema: z.ZodType<PluginField> = z.lazy(() =>
  z.object({
    key: z.string(),
    label: z.string(),
    type: z.enum(['string', 'integer', 'number', 'boolean', 'object', 'array']),
    description: z.string(),
    default: z.unknown(),
    required: z.boolean(),
    enum: z.array(z.unknown()),
    children: z.array(pluginFieldSchema),
    itemSchema: pluginFieldSchema.nullable(),
    advanced: z.boolean(),
  }),
);
export const pluginInfoSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  version: z.string(),
  /** strategy = react/por; plugin = everything else. */
  kind: z.enum(['strategy', 'plugin']),
  /** Plugins the host manages through bindings (skill/knowledge/graph). / 由资源绑定托管的插件。 */
  managed: z.boolean(),
  fields: z.array(pluginFieldSchema),
});
export type PluginInfo = z.infer<typeof pluginInfoSchema>;

// ---------- Agents ----------
export const runtimeSchema = z.object({
  maxRounds: z.number().int().min(1).max(500),
  thinking: z.enum(['auto', 'always', 'never']),
  streamIdleTimeout: z.number().positive().nullable(),
  stepTimeout: z.number().positive().nullable(),
  totalTimeout: z.number().positive().nullable(),
  parallelToolCalls: z.boolean(),
  humanInTheLoop: z.boolean(),
});
export const agentInputSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(80),
  avatar: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  systemPrompt: z.string(),
  strategy: z.enum(['react', 'por']),
  runtime: runtimeSchema,
  models: z.object({
    main: z.string().nullable(),
    utility: z.string().nullable(),
    vision: z.string().nullable(),
    image: z.string().nullable(),
  }),
  /** plugin name -> config. Only enabled plugins are written to agent.yaml. */
  plugins: z.record(
    z.string(),
    z.object({ enabled: z.boolean(), config: z.record(z.string(), z.unknown()) }),
  ),
  bindings: z.object({
    skills: z.array(z.string()),
    knowledge: z.array(z.string()),
    /** The engine graph plugin mounts one store per agent. / 引擎图谱插件每个 Agent 挂载一个存储。 */
    graph: z.string().nullable(),
  }),
});
export type AgentInput = z.infer<typeof agentInputSchema>;
export const agentSchema = agentInputSchema.extend({
  id,
  /** ok: main model resolvable; unset: no main model; missing: provider/model removed or disabled. */
  modelStatus: z.enum(['ok', 'unset', 'missing']),
  ...timestamps,
});
export type Agent = z.infer<typeof agentSchema>;
export const validationSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })),
  yaml: z.string(),
});
export type Validation = z.infer<typeof validationSchema>;

// ---------- Skills ----------
export const skillInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, '名称不能为空')
    .regex(/^[\w\-\u4e00-\u9fa5]+$/, '只能包含字母、数字、中文、下划线和连字符'),
  description: z.string(),
  whenToUse: z.string(),
  triggerKeywords: z.array(z.string()).max(50),
  instructions: z.string().trim().min(1, '指令内容不能为空'),
  enabled: z.boolean(),
});
export type SkillInput = z.infer<typeof skillInputSchema>;
export const skillSchema = skillInputSchema.extend({ id, ...timestamps });
export type Skill = z.infer<typeof skillSchema>;

// ---------- Knowledge bases / 知识库 ----------
export const knowledgeInputSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空'),
  description: z.string(),
  enabled: z.boolean(),
});
export type KnowledgeInput = z.infer<typeof knowledgeInputSchema>;
export const knowledgeSchema = knowledgeInputSchema.extend({
  id,
  documentCount: z.number().int(),
  totalBytes: z.number().int(),
  ...timestamps,
});
export type KnowledgeBase = z.infer<typeof knowledgeSchema>;
export const knowledgeDocumentSchema = z.object({
  id,
  title: z.string(),
  size: z.number().int(),
  contentType: z.string(),
  createdAt: z.string(),
});
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

// ---------- Graphs / 图谱 ----------
export const graphInputSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空'),
  description: z.string(),
  enabled: z.boolean(),
  entityTypes: z.array(z.string()),
  relationTypes: z.array(z.string()),
});
export type GraphInput = z.infer<typeof graphInputSchema>;
export const graphSchema = graphInputSchema.extend({
  id,
  entityCount: z.number().int(),
  relationCount: z.number().int(),
  ...timestamps,
});
export type Graph = z.infer<typeof graphSchema>;
export const entityInputSchema = z.object({
  name: z.string().trim().min(1, '实体名称不能为空'),
  type: z.string(),
  description: z.string(),
  aliases: z.array(z.string()),
});
export type EntityInput = z.infer<typeof entityInputSchema>;
export const entitySchema = entityInputSchema.extend({ id });
export type GraphEntity = z.infer<typeof entitySchema>;
export const relationInputSchema = z.object({
  /** Entity id or name. / 实体 ID 或名称。 */
  source: z.string().min(1, '请选择起点'),
  target: z.string().min(1, '请选择终点'),
  relationType: z.string().trim().min(1, '关系类型不能为空'),
  description: z.string(),
});
export type RelationInput = z.infer<typeof relationInputSchema>;
export const relationSchema = z.object({
  id,
  sourceId: z.string(),
  targetId: z.string(),
  sourceName: z.string(),
  targetName: z.string(),
  relationType: z.string(),
  description: z.string(),
});
export type GraphRelation = z.infer<typeof relationSchema>;
export const graphDataSchema = z.object({
  entities: z.array(entitySchema),
  relations: z.array(relationSchema),
});
export type GraphData = z.infer<typeof graphDataSchema>;

// ---------- Evaluation / 评估 ----------
export const evalInputSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空'),
  agentId: z.string().min(1, '请选择 Agent'),
  description: z.string(),
});
export type EvalInput = z.infer<typeof evalInputSchema>;
export const evalSchema = evalInputSchema.extend({
  id,
  status: z.enum(['idle', 'running', 'completed', 'failed']),
  caseCount: z.number().int(),
  /** 0-10, null before the first run. */
  avgScore: z.number().nullable(),
  passRate: z.number().nullable(),
  error: z.string(),
  ...timestamps,
});
export type EvalTask = z.infer<typeof evalSchema>;
export const evalCaseInputSchema = z.object({
  input: z.string().trim().min(1, '输入不能为空'),
  expectedOutput: z.string(),
  expectedTools: z.array(z.string()),
});
export type EvalCaseInput = z.infer<typeof evalCaseInputSchema>;
export const evalCaseSchema = evalCaseInputSchema.extend({ id });
export type EvalCase = z.infer<typeof evalCaseSchema>;
export const evalResultSchema = z.object({
  caseId: z.string(),
  input: z.string(),
  output: z.string(),
  tools: z.array(z.string()),
  score: z.number(),
  passed: z.boolean(),
  reason: z.string(),
  durationMs: z.number(),
  error: z.string(),
});
export type EvalResult = z.infer<typeof evalResultSchema>;
