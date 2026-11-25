// Display-only Chinese labels for protocol values. Unknown values pass through unchanged.
// 协议值的中文展示标签；未知值原样显示。
const statuses: Record<string, string> = {
  idle: '未开始',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
  interrupted: '已中断',
  pending: '等待中',
  accepted: '已接收',
  processing: '处理中',
  cancel_requested: '正在取消',
  done: '已完成',
};
export const statusLabel = (s: string | undefined) => (s ? (statuses[s] ?? s) : '');
export const modeLabels: Record<string, string> = {
  group_chat: '群聊',
  supervisor: '主持调度',
  debate: '辩论',
  redblue: '红蓝对抗',
  discussion: '讨论',
  interview: '访谈',
  social: '社会模拟',
  retrospective: '复盘',
  backcast: '逆向推演',
  sandbox: '沙盘',
};
export const modeLabel = (m: string | undefined) => (m ? (modeLabels[m] ?? m) : '');
// Engine event types the host forwards verbatim as phase text. / 宿主原样转发为阶段文本的引擎事件类型。
const phases: Record<string, string> = {
  start: '推演开始',
  round_start: '本轮开始',
  round_end: '本轮结束',
  done: '推演结束',
  system: '系统消息',
  actor_selected: '选定行动者',
  step_started: '步骤开始',
  step_completed: '步骤完成',
  speak_start: '开始发言',
  speak_end: '发言结束',
  error: '运行错误',
};
export const phaseLabel = (text: string) => phases[text.trim()];
const activities: Record<string, string> = {
  plan: '计划',
  step: '步骤',
  round: '轮次',
  tool: '工具',
  agent: '子 Agent',
  artifact: '产物',
  error: '错误',
};
export const activityLabel = (k: string) => activities[k] ?? k;
const parts: Record<string, string> = {
  thinking: '思考',
  tool: '工具调用',
  artifact: '产物',
  agent: '子 Agent',
};
export const partLabel = (k: string) => parts[k] ?? k;
