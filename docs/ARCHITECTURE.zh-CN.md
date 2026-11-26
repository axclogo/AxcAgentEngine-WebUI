# 架构

## 分层

```
宿主页面 ─┬─ AgentStudio（完整工坊）
          └─ StudioProvider + 单个界面（Workbench / SimulationDetail / *Manager）
                 │
            StudioClient（唯一接缝）── createHttpClient ── server/（示例宿主）── AxcAgentEngine
```

- **SDK 不执行工具、不保存凭据、不启动引擎。** 所有数据经 `StudioClient` 读写；宿主负责鉴权、存储与引擎调用。
- **`core.ts`**：会话 / 推演的快照 + 事件协议。快照覆盖到自身水位，之后的事件按 `seq` 重放，旧快照不回退。不依赖 React。
- **`state.ts`**：单个资源的订阅生命周期与命令提交锁。
- **管理分区**用 TanStack Query 缓存列表与详情，变更后按 key 失效；表单用 react-hook-form + zod（`studio/schema.ts` 同时是 HTTP 协议的类型定义）。
- **`provider.tsx`**：根节点 `.axc-root` 承担样式作用域、深浅主题、Radix 浮层容器（弹窗渲染在根节点内，作用域样式继续生效）、QueryClient 与通知。

## 样式

Tailwind v4 编译 `src/styles.css`，`postcss.config.mjs` 再做两件事：

1. 所有选择器加 `.axc-root` 前缀（`:root` / `.dark` 映射到根节点本身），SDK 不改动宿主页面。
2. 去掉 cascade layer，避免宿主页面的非分层样式总是压过 SDK。

整体尺寸按 Tailwind 默认的 90%（`--spacing`、`--text-*`、`--container-*`），宿主可在 `.axc-root` 上覆盖。Streamdown 自带的 Tailwind 类与 SDK 共用同一套 shadcn 变量，所以表格、代码块随主题变化。

## 对话

- assistant-ui 的 `ExternalStoreRuntime` 负责消息列表、滚动跟随、输入框、IME 与附件；消息与运行状态始终来自宿主。`isRunning` 固定为 false，避免 assistant-ui 在运行中自建第二条本地队列；插话 / 排队直接作为命令提交给宿主。
- 发送失败抛 `MessageNotSentError` 恢复草稿；同内容同附件重试复用 `requestId`，宿主按回执幂等。
- 附件适配器从首帧起存在，上传能力到达前的粘贴会被拒绝而不是丢失。
- 分支：每条完成的助手回复都绑定一个引擎切点（`checkpoints[].messageId`）。开分支用该切点所属的那次运行调用 `fork_run`，子会话记录 `parentId`，侧栏和归档页据此建树。

## 示例宿主（server/）

- `routers/` 只做 HTTP 解析与校验，`services/` 承担业务；`resources.py` 是会话与推演，其余各管一个分区。
- SQLite 是权威状态；引擎的会话消息与检查点也存在同一数据库。
- Agent 定义渲染成 agent.yaml 交给 `Engine.load_agent_template`；定义或其绑定资源变化后，下次使用时重建实例。
- 技能按 Agent 软链到专属目录作为 skill 插件的 `paths`；知识库目录作为 knowledge 插件的 `sources`；图谱用持久化的 `GraphStore` 挂载为 `graph.store`，管理页与 Agent 共用同一份数据。
- 运行时只为绑定资源授予对应能力（`skill_read`、`knowledge_read`、`graph_*`），不授予 `shell`。
- `models.py` 的 `CompatibleClient` 修正两处引擎请求与 OpenAI 兼容服务（如 DeepSeek）的不一致：`thinking` 字段取值、回放 `tool_calls` 缺少 `type`。
- 分叉：引擎 3.3.0 的 `fork_run` 同时写入分支会话的历史（含工具调用与结果）；宿主只负责分支树、`forkCheckpointId` 和来源链。
- 编辑重发：每条消息记录 `runId`。编辑时按 run 计算影响范围，用引擎 `rewind_session(before_run_id)` 回退会话历史；宿主删除对应消息与切点，归档受影响的分支和派生会话，再重新发送。

- 人工交互：引擎 `runtime.human_in_the_loop` 字段在引擎内不生效，宿主改为由该开关启用 `human_in_the_loop` 插件，并为每次运行提供审批通道；待处理提示随快照与事件下发，回答后插件继续执行。
- 会话操作（`services/sessions.py`，契约见引擎 `docs/SESSIONS.md`）：
  - `SessionsService` 实现引擎 `SessionService` 的 7 个方法。存储：`session_grant`（授权）、`session_watch`（订阅）、`session_dispatch`（派发：哪个会话的哪一轮把任务送进了哪次运行）、`run_provenance`（每次运行开始时的来源链）。
  - 来源链：派发时子来源链为「发起方本轮的 depth+1、chain+[发起方]」。`session_create` 新建的会话把它存进会话 meta；发给已有空闲会话只影响那一轮。每次 `stream`/`resume_stream`/`fork_run` 都在 metadata 注入 `session_provenance={depth, chain}`、`session_title`、`turn_origin`；resume 取该运行记录的来源链。
  - 上级集合：本轮 chain，加上往本轮里送过 live input 的发起方及其 chain。引擎拦截 chain；宿主在每个方法里复核整个集合。
  - 授权：先查记录与调用方 Agent 的预先授权（`runtime.sessionGrants`；任何明确拒绝优先；拒绝读取会阻断操作；操作授权包含读取），没有记录时通过 `PromptChannel` 的宿主提示询问用户。宿主提示自己持有 future，不经过引擎审批队列；只开会话操作时不把审批队列交给引擎。
  - `max_active`：全局派发锁内统计发起方派发且仍在运行的会话数，达到上限直接拒绝，不排队。
  - 完成通知：运行结束（完成、停止、失败）后，给本轮的派发方和订阅方投递通知，文案、幂等 id 和投递方式由引擎 `notices` 模块决定（`start` 开新一轮、`inject` 作为 live input，两者都计一次唤醒；`hold` 只写记录、`drop` 丢弃）。`interrupted` 不通知；编辑时被停止的运行不通知被编辑的会话。终态先持久化再投递，关闭期间结束的运行在启动时补发（通知 id 幂等）。旧运行收尾时只写属于自己的状态和切点，不影响已经开始的新一轮；收尾阶段被取消的运行保留终态，由启动时补发通知。运行中的发起方 60 秒内仍不能接收通知时，投递直接报错、不标记已通知，下次启动补发。编辑的影响范围包含派生会话再新建出的会话（任意层）。用户亲自发消息、点「继续」、编辑时清零唤醒计数，并把积压通知带进新的一轮。
- 运行记录（`services/runs.py`）是 token 累计、失败分析、经验蒸馏、成本分析的唯一数据来源；工具成败取自引擎审计回调（`tool_result` 事件本身不带成败）。
- 记忆：宿主给引擎提供 SQLite 版 KV 存储，记忆插件的数据因此持久化并可在「记忆」页查看。
- MCP：服务的环境变量和请求头值加密保存；写入 agent.yaml 时显示为 `••••`，真实值只通过实例化覆盖传给引擎。

## 已知限制

- 非文本、非图片附件以文字说明（文件名、类型、大小）传给模型；引擎的 `file_ref` 会原样转发给模型，OpenAI 兼容接口不接受。
- 评估在真实模型下使用引擎 `LLMJudge`；它在无法解析裁判输出时返回 0.5 分（即 5 分，判为不及格），这一行为来自引擎。
- 推演暂停是在事件边界停止消费，当前模型调用会完成；服务重启后未结束的推演标记为失败，不可恢复。
- 引擎记忆插件默认只保留 50 字以上的事实（`min_content_length`），中文对话里提取出的事实大多更短，需要在插件配置里调小。
- 分叉出的分支状态显示为「已取消」并提供「恢复运行」，这是引擎分叉的工作方式；分支里可直接发消息继续。
