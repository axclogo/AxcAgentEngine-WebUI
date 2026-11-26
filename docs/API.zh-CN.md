# 宿主 HTTP 协议（0.2）

SDK 默认的 `createHttpClient(base = '/api')` 按本协议访问宿主；自定义宿主可以实现同名的 `StudioClient` 接口，不必走 HTTP。

- 类型的权威定义：会话/推演在 `src/core.ts`，管理端在 `src/studio/schema.ts`（zod）。JSON 字段全部 camelCase。
- 错误：非 2xx，body 为 `{"error": "中文说明"}`（422 校验错误可为 FastAPI 默认格式，SDK 会尽量提取 `detail[].msg`）。
- 时间：ISO 8601 UTC 字符串。
- ID：服务端生成的不透明字符串。

## 模型提供商 `/api/providers`

| 方法   | 路径                  | 说明                                                                                                                                                                                       |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/providers`      | `Provider[]`                                                                                                                                                                               |
| POST   | `/api/providers`      | body `ProviderInput`，返回 `Provider`                                                                                                                                                      |
| PUT    | `/api/providers/{id}` | body `ProviderInput`；`apiKey` 为空字符串时保留原密钥                                                                                                                                      |
| DELETE | `/api/providers/{id}` | 204；被 Agent 引用时仍允许删除，Agent 的 `modelStatus` 变为 `missing`                                                                                                                      |
| POST   | `/api/providers/test` | body `{id?: string, baseUrl: string, apiKey?: string}`，请求 `{baseUrl}/models`，返回 `ProviderTest`（`models` 为远端模型 ID 列表，便于一键导入）。`apiKey` 为空且给了 `id` 时用已存密钥。 |

密钥：服务端用 `AXC_SECRET_KEY`（Fernet）加密落库；任何响应只给 `apiKeyMasked`（如 `sk-••••abcd`）与 `hasKey`。

`ModelRef = "{providerId}:{modelId}"`。Agent 的 `models.main/utility/vision/image` 存 ModelRef。前端按提供商 → 模型级联选择：main/utility 选 `type=llm`，vision 选 `type=llm && vision`，image 选 `type=image`。

## 插件目录 `/api/plugins`

GET 返回 `PluginInfo[]`，来自引擎 `PluginRegistry` 与各插件 `config_schema`。`managed=true` 的插件（skill、knowledge、graph）由资源绑定自动启用和配置，Agent 表单不直接编辑它们的路径类字段。`kind=strategy` 为 react/por。

## Agent `/api/agents`

| 方法           | 路径                      | 说明                                                                               |
| -------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| GET            | `/api/agents`             | `Agent[]`                                                                          |
| POST           | `/api/agents`             | body `AgentInput` → `Agent`                                                        |
| GET/PUT/DELETE | `/api/agents/{id}`        | 详情 / 更新 / 删除（204）                                                          |
| POST           | `/api/agents/validate`    | body `AgentInput` → `Validation`：渲染 agent.yaml 并用引擎加载校验，返回 YAML 预览 |
| GET            | `/api/agents/{id}/export` | `text/yaml` 附件                                                                   |

Agent 名称唯一。宿主以 Agent ID 作为引擎内名称，定义变更后卸载旧实例。运行时：

- `models.main` → `AgentModels.default`，`models.utility` → `AgentModels.utility`；vision 在消息含图片时替代 main；image 暂仅保存。
- `bindings.skills` → 启用 skill 插件，`paths` 指向该 Agent 专属目录（软链接所选技能）。
- `bindings.knowledge` → 启用 knowledge 插件，`sources` 为所选知识库目录。
- `bindings.graph` → 启用 graph 插件并挂载该图谱的持久化存储。
- `AXC_MODEL_MODE=fixture` 时全部使用确定性夹具模型，忽略模型配置（用于测试与演示）。

## Skills `/api/skills`

| 方法           | 路径                 | 说明                                                                                        |
| -------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| GET/POST       | `/api/skills`        | `Skill[]` / 新建（body `SkillInput`）                                                       |
| GET/PUT/DELETE | `/api/skills/{id}`   |                                                                                             |
| POST           | `/api/skills/import` | multipart `file`：`SKILL.md`（YAML frontmatter + 正文）或含 `SKILL.md` 的 zip；返回 `Skill` |

磁盘布局 `{data}/skills/{id}/SKILL.md`，frontmatter 字段 `name/description/when_to_use/trigger_keywords`，与引擎 skill 插件一致。

## 知识库 `/api/knowledge`

| 方法           | 路径                                    | 说明                                                                         |
| -------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| GET/POST       | `/api/knowledge`                        | `KnowledgeBase[]` / 新建                                                     |
| GET/PUT/DELETE | `/api/knowledge/{id}`                   |                                                                              |
| GET            | `/api/knowledge/{id}/documents`         | `KnowledgeDocument[]`                                                        |
| POST           | `/api/knowledge/{id}/documents`         | multipart `file`（md/txt/pdf/json/yaml…）或 JSON `{title, content}` 文本文档 |
| GET            | `/api/knowledge/{id}/documents/{docId}` | 原文件下载                                                                   |
| DELETE         | `/api/knowledge/{id}/documents/{docId}` | 204                                                                          |

## 图谱 `/api/graphs`

| 方法           | 路径                                      | 说明                                                                                                 |
| -------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| GET/POST       | `/api/graphs`                             | `Graph[]` / 新建                                                                                     |
| GET/PUT/DELETE | `/api/graphs/{id}`                        |                                                                                                      |
| GET            | `/api/graphs/{id}/data`                   | `GraphData`（实体与关系）                                                                            |
| POST           | `/api/graphs/{id}/entities`               | `EntityInput`，同名实体合并 → `GraphEntity`                                                          |
| DELETE         | `/api/graphs/{id}/entities/{entityId}`    | 同时删除相连关系                                                                                     |
| POST           | `/api/graphs/{id}/relations`              | `RelationInput` → `GraphRelation`                                                                    |
| DELETE         | `/api/graphs/{id}/relations/{relationId}` |                                                                                                      |
| POST           | `/api/graphs/{id}/import`                 | multipart `file`：JSONL（引擎格式，每行实体或关系）或 JSON `{entities, relations}`；返回 `GraphData` |

存储与 Agent 共用：Agent 运行中通过图谱工具写入的实体也会出现在管理页。

## 评估 `/api/evals`

| 方法           | 路径                             | 说明                                            |
| -------------- | -------------------------------- | ----------------------------------------------- |
| GET/POST       | `/api/evals`                     | `EvalTask[]` / 新建                             |
| GET/PUT/DELETE | `/api/evals/{id}`                |                                                 |
| GET/POST       | `/api/evals/{id}/cases`          | `EvalCase[]` / 新增 `EvalCaseInput`             |
| DELETE         | `/api/evals/{id}/cases/{caseId}` |                                                 |
| POST           | `/api/evals/{id}/run`            | 异步执行，立即返回 `EvalTask`（status=running） |
| GET            | `/api/evals/{id}/results`        | `EvalResult[]`（最近一次运行）                  |

使用引擎 `EvalRunner`；裁判模型为该 Agent 的 utility 模型（未配置时用 main），通过线为 6 分（0–10）。

## 会话与推演

保持资源 + 快照 + SSE 事件协议（见 `src/core.ts`）：

| 方法 | 路径                                             | 说明                                                                                      |
| ---- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| GET  | `/api/catalog?scope=`                            | `{agents:[{id,name,avatar}], defaultAgentId, create, createSimulation}`，只含启用的 Agent |
| GET  | `/api/{conversation\|simulation}?scope=&filter=` | `Meta[]`                                                                                  |
| POST | `/api/conversation`                              | `{scope, agentId}` → `Meta`                                                               |
| POST | `/api/simulation`                                | `{scope, definition, id?}` → `Meta`；`definition.agents` 为 Agent ID                      |
| GET  | `/api/{kind}/{id}?scope=[&events=1]`             | 快照或 SSE                                                                                |
| POST | `/api/{kind}/{id}?scope=`                        | 命令                                                                                      |
| POST | `/api/conversation/{id}/attachments?scope=`      | multipart `file` → `Attachment`                                                           |
| GET  | `/api/attachments/{attachmentId}`                | 附件内容                                                                                  |

0.2 新增字段：

- `Meta.parentId: string | null`：分叉来源会话；侧栏据此渲染不限深度的分支树。`Meta.createdAt`。
- `Meta.checkpoints[].messageId?: string`：该切点时最后一条消息 ID，UI 在对应消息下提供「从这里分叉」。
- `Message.attachments?: Attachment[]`：用户消息携带的附件。图片以多模态 `image_base64` 传给引擎；文本类文件抽取为文本片段；其他文件以 `file_ref` 传递。
- `Meta.archived`、`Meta.archivedAt`；命令 `archive` / `unarchive` 连同全部分叉后代一起归档或恢复。会话的 `capabilities.delete` 仅在已归档时为 true，未归档会话的 `delete` 命令返回 400。
- `Meta.capabilities.archive`：任何未运行的可见会话都可归档。
- `fork` 命令：`checkpointId` 必须来自该会话的 `meta.checkpoints`；可以是任意一次运行的切点。引擎（3.3.0）把切点的完整历史（含工具调用与结果）写入分支会话；分支 meta 记录 `forkCheckpointId`，并继承父会话的 `provenance`。
- `Message.parts`：宿主把 `thinking_*`、`tool_call/tool_result`、`sub_agent_*` 事件归并到助手消息的分段中（kind=thinking/tool/agent），工具结果为 JSON 时原样放在 text。

## 人工交互（审批与提问）

Agent 运行参数 `runtime.humanInTheLoop=true` 时，宿主为该 Agent 启用引擎 `human_in_the_loop` 插件（含 `ask_human` 工具），并在每次运行时提供审批通道（`run_options.approval_queue/response_queue`）。该插件由此开关托管，不出现在插件列表。

- 快照新增 `prompts: Prompt[]`，事件新增 `kind: 'prompt'`（同 id upsert）。
  - `approval`：工具风险达到阈值时触发，带 `toolName/arguments/riskLevel`。
  - `question`：模型调用 `ask_human`，带 `question/options`。
- 命令 `{type:'respond', promptId, approved?, answer?}`：approval 用 `approved`，question 用 `answer`。只能回答 `pending` 的提示，回答后 `status='answered'`、`answer` 为回答值。能力位 `capabilities.respond` 在存在待处理提示时为 true。
- 运行结束（完成 / 停止 / 失败）或宿主重启时，未回答的提示变为 `expired`。

## 编辑重发
- `Message.runId`：消息所属的运行；`Message.startsRun`：该用户消息开启了这一轮；`Message.rewindable`：引擎能回退到这一轮之前（运行结束后由宿主按 `Agent.can_rewind` 标记）。三者都为真、且 `capabilities.editMessage` 为真时，前端在这条用户消息上显示「编辑」。
- `capabilities.editMessage`：会话未归档、未运行、不是来源页受限的会话。
- 命令 `{type:'editPreview', messageId}` → `{preview:{messages, branches, sessions}}`：删除的消息数、要归档的分支数（含后代）、要归档的派生会话数（含其分支），不做修改。
- 命令 `{type:'editMessage', messageId, requestId, text, attachments}`：
  1. 停止被删轮次里 `session_create` 出的、仍在运行的会话，且不给本会话发通知；
  2. 调用引擎 `rewind_session(session_id, before_run_id)`，失败时报错、快照不变；
  3. 归档从被删部分分叉出的分支、被删轮次派生的会话（`archivedReason='edited'`、`editedFrom={conversationId, messageId}`）；
  4. 撤销被删轮次产生的派发与订阅；删除被编辑消息及之后的消息、执行进度、队列、提示和作废切点；`autoWakeups` 清零；
  5. 以新文本开启新一轮。返回新用户消息事件。
- 事件 `kind:'remove'`，`value: {messages?, activities?, queue?, prompts?: string[]}`：按 id 移除条目。
- 旧数据（没有 `runId`，或产生于 3.3.0 之前的运行）不可编辑。

## 会话操作（sessions 插件）
Agent 运行参数 `runtime.sessionOperations=true` 时，宿主启用引擎 `sessions` 插件（`max_wakeups` 取 `runtime.maxWakeups`；`max_active`、`max_depth`、`allow_create`、`allow_operate`、`cross_agent` 取 Agent 的 `plugins.sessions.config`，未设置时用引擎默认值；Agent 编辑页「运行参数」在打开开关后可设置），授予 `session_read`、`session_operate` 能力，并把 `SessionsService`（`server/services/sessions.py`）挂载为 `sessions.service`。该插件由此开关托管，不出现在插件列表。
- `runtime.maxWakeups`：0–100000，默认 100，0 为不限制。通知新开一轮（start）或送入当前这一轮（inject）都计一次；到达上限后，运行中和空闲时都只写入积压通知（hold）。
- `runtime.maxRounds`：1–100000，默认 500（与引擎 3.3.1 一致）。
- `runtime.sessionGrants: [{target, level}]`：预先授权，用于无人值守的长任务。`target` 为 `'*'`（全部会话）或 Agent ID（该 Agent 的全部会话），`level` 为 `read` 或 `operate`（含读取）。命中时不弹授权提示、不写会话级记录；用户对某个会话的明确拒绝仍然优先；`cross_agent=false` 时仍拒绝其他 Agent 的会话。`target` 指向不存在的 Agent 时保存报错。
- 列表接口返回的会话 meta 用于工具卡片与通知卡片显示目标会话的标题和实时状态（其中有运行中的会话时每 5 秒刷新）。
- 授权提示 `Prompt.kind='session_access'`，字段 `level`（`read`/`operate`）、`targetSessionId`、`targetTitle`、`targetAgentId`、`targetAgentName`、`targetScope`。回答命令 `{type:'respond', promptId, choice}`，`choice` 为 `session`（仅这个会话）、`agent`（该 Agent 的全部会话）或 `deny`。120 秒内未回答视为拒绝；运行结束或重启时仍未回答，返回 `unavailable` 且不记录。
- 授权命令（`capabilities.grants`）：`{type:'listGrants'}` → `{grants:[{id, targetType, targetId, targetTitle, level, decision, reason, createdAt}]}`；`{type:'revokeGrant', grantId}` 删除一条记录，下一次运行生效。
- 完成通知消息：`kind='notice'`、`role='user'`、`actor='后台会话通知'`、`id='notice:{目标会话}:{目标运行}'`（同一运行停止后恢复再结束，第 N 次结束为 `notice:{目标会话}:{目标运行}.N`）、`sourceSessionId`。
- `capabilities.resume`：运行最新检查点里有结果未知的写操作（工具被中途打断）时为 false，引擎拒绝恢复这类运行；用户发新消息继续。达到唤醒上限时 `held=true`，`capabilities.wake` 为真；命令 `{type:'wake'}` 以全部积压通知开启新一轮并清零计数。
- 派发来的用户消息带 `originSessionId`，`actor` 为「会话「发起方标题」」。
- `Meta.provenance {depth, chain, parentSessionId, parentRunId, rootSessionId}`、`Meta.autoWakeups`、`Meta.maxWakeups`（派生字段，取 Agent 配置）、`Meta.forkCheckpointId`、`Meta.archivedReason`、`Meta.editedFrom`。

## Token 用量

- 助手消息 `Message.usage = {inputTokens, outputTokens}`：生成该回复的那次运行的累计用量（引擎 `cost_update` 事件）。
- `Agent.usage = {inputTokens, outputTokens, runs}`：该 Agent 全部对话运行的累计值。
- 宿主对 OpenAI 兼容服务的流式请求带 `stream_options.include_usage=true`。

## 向量检索

- 知识库 `embeddingModel: ModelRef | null`（`type=embedding` 的模型）。Agent 绑定的知识库若配置了向量模型，宿主把该模型挂载为引擎 `knowledge.embedding`，检索变为向量 + BM25 混合；未配置则仅 BM25。
- 同一个 Agent 绑定的知识库必须使用同一个向量模型（或都不使用），否则 Agent 校验与保存返回错误。
- 模型类型只剩 `llm`、`embedding`；Agent 模型槽位只剩 `main/utility/vision`。

## MCP 服务 `/api/mcp`

| 方法           | 路径                 | 说明                                                                     |
| -------------- | -------------------- | ------------------------------------------------------------------------ |
| GET/POST       | `/api/mcp`           | `McpServer[]` / 新建（body `McpInput`）                                  |
| GET/PUT/DELETE | `/api/mcp/{id}`      | 更新时 `env`、`headers` 中值为空字符串的键保留原值；不在 body 中的键删除 |
| POST           | `/api/mcp/{id}/test` | 连接并列出工具 → `McpTest`                                               |

`env`、`headers` 的值加密保存，响应只返回键名。Agent `bindings.mcp` 绑定 MCP 服务后，宿主启用引擎 `mcp` 插件并写入这些服务；`mcp` 插件由绑定托管，不出现在插件列表。

## 记忆 `/api/memories`

宿主为引擎提供持久化 KV 存储，引擎 `memory` 插件写入的记忆可在这里查看和删除。

| 方法   | 路径                     | 说明                        |
| ------ | ------------------------ | --------------------------- |
| GET    | `/api/memories?agentId=` | `Memory[]`，可按 Agent 过滤 |
| DELETE | `/api/memories/{id}`     | 删除一条记忆                |

## 分析 `/api/analytics`

数据来自宿主记录的每次对话运行（Agent、任务文本、工具调用及成败、错误、token、耗时、模型），由引擎旁路模块生成报告。查询参数 `agentId`（可选）、`days`（默认 30）。

| 方法 | 路径                      | 说明                                                                                |
| ---- | ------------------------- | ----------------------------------------------------------------------------------- |
| GET  | `/api/analytics/failures` | `FailureReport`（`failure_miner`）                                                  |
| GET  | `/api/analytics/distill`  | `DistillReport`（`distiller`）                                                      |
| GET  | `/api/analytics/cost`     | `CostReport`（`cost_optimizer`，价格来自模型的 `inputPricePer1k/outputPricePer1k`） |

## 评估：人工标注与报告

- `EvalResult` 新增 `inputTokens/outputTokens/manualPassed/note`。任务的通过率按 `manualPassed ?? passed` 计算。
- `PUT /api/evals/{id}/results/{caseId}`，body `EvalReview` → `EvalResult`。
- `GET /api/evals/{id}/report` → `text/markdown` 附件：汇总（引擎 `generate_report`）、逐条结果、人工标注。
