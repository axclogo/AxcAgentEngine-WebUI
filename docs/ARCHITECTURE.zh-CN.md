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
- 分叉：引擎分叉的是运行状态，不是会话历史；宿主把截至分叉点的对话写入分支会话的历史，分支里继续发消息时模型能看到之前的内容。

- 人工交互：引擎 `runtime.human_in_the_loop` 字段在引擎内不生效，宿主改为由该开关启用 `human_in_the_loop` 插件，并为每次运行提供审批通道；待处理提示随快照与事件下发，回答后插件继续执行。
- 运行记录（`services/runs.py`）是 token 累计、失败分析、经验蒸馏、成本分析的唯一数据来源；工具成败取自引擎审计回调（`tool_result` 事件本身不带成败）。
- 记忆：宿主给引擎提供 SQLite 版 KV 存储，记忆插件的数据因此持久化并可在「记忆」页查看。
- MCP：服务的环境变量和请求头值加密保存；写入 agent.yaml 时显示为 `••••`，真实值只通过实例化覆盖传给引擎。

## 已知限制

- 非文本、非图片附件以文字说明（文件名、类型、大小）传给模型；引擎的 `file_ref` 会原样转发给模型，OpenAI 兼容接口不接受。
- 评估在真实模型下使用引擎 `LLMJudge`；它在无法解析裁判输出时返回 0.5 分（即 5 分，判为不及格），这一行为来自引擎。
- 推演暂停是在事件边界停止消费，当前模型调用会完成；服务重启后未结束的推演标记为失败，不可恢复。
- 引擎记忆插件默认只保留 50 字以上的事实（`min_content_length`），中文对话里提取出的事实大多更短，需要在插件配置里调小。
- 分叉出的分支状态显示为「已取消」并提供「恢复运行」，这是引擎分叉的工作方式；分支里可直接发消息继续。
