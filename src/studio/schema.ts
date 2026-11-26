// Management contract shared by the SDK and any host. JSON field names are camelCase.
// 管理端协议：SDK 与宿主共用，JSON 字段统一 camelCase。
import { z } from 'zod';

const id = z.string().min(1);
const timestamps = { createdAt: z.string(), updatedAt: z.string() };

// ---------- Model providers / 模型提供商 ----------
export const modelTypes = ['llm', 'embedding'] as const;
export const modelEntrySchema = z.object({
  id: z.string().trim().min(1, '模型 ID 不能为空'),
  label: z.string(),
  type: z.enum(modelTypes),
  vision: z.boolean(),
  contextWindow: z.number().int().positive().nullable(),
  /** Price per 1k tokens, used by cost analysis; null = unknown. / 每千 token 价格，用于成本分析。 */
  inputPricePer1k: z.number().nonnegative().nullable(),
  outputPricePer1k: z.number().nonnegative().nullable(),
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
    /** MCP server ids; enables the engine mcp plugin. / 绑定的 MCP 服务。 */
    mcp: z.array(z.string()),
  }),
});
export type AgentInput = z.infer<typeof agentInputSchema>;
export const agentSchema = agentInputSchema.extend({
  id,
  /** ok: main model resolvable; unset: no main model; missing: provider/model removed or disabled. */
  modelStatus: z.enum(['ok', 'unset', 'missing']),
  /** Cumulative token usage over all conversation runs. / 全部对话运行的累计 token。 */
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), runs: z.number().int() }),
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
  /** Embedding ModelRef; null = keyword (BM25) search only. / 向量模型；为空时仅关键词检索。 */
  embeddingModel: z.string().nullable(),
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
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  /** Human verdict overriding `passed`; null = not reviewed. / 人工判定，覆盖自动结果。 */
  manualPassed: z.boolean().nullable(),
  note: z.string(),
});
export type EvalResult = z.infer<typeof evalResultSchema>;
export const evalReviewSchema = z.object({ manualPassed: z.boolean().nullable(), note: z.string() });
export type EvalReview = z.infer<typeof evalReviewSchema>;

// ---------- MCP servers ----------
export const mcpInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, '名称不能为空')
      .regex(/^[A-Za-z][\w-]*$/, '以字母开头，只含字母、数字、下划线、连字符'),
    description: z.string(),
    enabled: z.boolean(),
    transport: z.enum(['stdio', 'http']),
    command: z.string(),
    args: z.array(z.string()),
    /** Write-only on update: empty values keep the stored secret. / 更新时留空保持原值。 */
    env: z.record(z.string(), z.string()),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
  })
  .superRefine((v, ctx) => {
    if (v.transport === 'stdio' && !v.command.trim())
      ctx.addIssue({ code: 'custom', path: ['command'], message: 'stdio 需要启动命令' });
    if (v.transport === 'http' && !/^https?:\/\//.test(v.url))
      ctx.addIssue({ code: 'custom', path: ['url'], message: '请输入 http(s) 地址' });
  });
export type McpInput = z.infer<typeof mcpInputSchema>;
export const mcpSchema = z.object({
  id,
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'http']),
  command: z.string(),
  args: z.array(z.string()),
  /** Keys only; values never leave the server. / 只返回键名，值不出服务端。 */
  envKeys: z.array(z.string()),
  url: z.string(),
  headerKeys: z.array(z.string()),
  ...timestamps,
});
export type McpServer = z.infer<typeof mcpSchema>;
export const mcpTestSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
});
export type McpTest = z.infer<typeof mcpTestSchema>;

// ---------- Memories (engine memory plugin) ----------
export const memorySchema = z.object({
  /** Opaque storage key. / 存储键。 */
  id,
  agentId: z.string(),
  layer: z.string(),
  content: z.string(),
  factType: z.string(),
  importance: z.number(),
  source: z.string(),
  accessCount: z.number().int(),
  createdAt: z.string(),
  lastAccessedAt: z.string(),
});
export type Memory = z.infer<typeof memorySchema>;

// ---------- Analytics (engine sidecars) ----------
export const failureReportSchema = z.object({
  records: z.number().int(),
  categoryCounts: z.record(z.string(), z.number().int()),
  clusters: z.array(
    z.object({
      key: z.string(),
      category: z.string(),
      count: z.number().int(),
      severity: z.number(),
      agents: z.array(z.string()),
      suggestedAction: z.string(),
      examples: z.array(
        z.object({
          id: z.string(),
          agentId: z.string(),
          message: z.string(),
          task: z.string(),
          toolName: z.string(),
        }),
      ),
    }),
  ),
});
export type FailureReport = z.infer<typeof failureReportSchema>;
export const distillReportSchema = z.object({
  traces: z.number().int(),
  rules: z.array(z.object({ text: z.string(), confidence: z.number(), evidence: z.array(z.string()) })),
  toolPreferences: z.array(z.string()),
  antiPatterns: z.array(
    z.object({ text: z.string(), confidence: z.number(), evidence: z.array(z.string()) }),
  ),
  skillCandidates: z.array(z.string()),
});
export type DistillReport = z.infer<typeof distillReportSchema>;
export const costReportSchema = z.object({
  samples: z.number().int(),
  totalCost: z.number(),
  totalTokens: z.number().int(),
  /** Samples whose model has no price configured. / 没有配置价格的样本数。 */
  unpricedSamples: z.number().int(),
  byAgent: z.record(z.string(), z.number()),
  byModel: z.record(z.string(), z.number()),
  findings: z.array(
    z.object({
      title: z.string(),
      impact: z.number(),
      recommendation: z.string(),
      evidence: z.array(z.string()),
    }),
  ),
});
export type CostReport = z.infer<typeof costReportSchema>;
