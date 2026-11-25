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
- `fork` 命令：`checkpointId` 必须来自该会话的 `meta.checkpoints`；可以是任意一次运行的切点。分支会话写入截至该切点的对话历史。
- `Message.parts`：宿主把 `thinking_*`、`tool_call/tool_result`、`sub_agent_*` 事件归并到助手消息的分段中（kind=thinking/tool/agent），工具结果为 JSON 时原样放在 text。
