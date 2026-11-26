"""One record per conversation run: the single source for token usage and analytics.
每次对话运行一条记录：token 用量与分析报告的唯一数据源。

Record fields: id (= runId), agentId, conversationId, task, success, error, toolCalls [{name, success, error}],
inputTokens, outputTokens, durationMs, model (ModelRef of the main model, '' when unset), createdAt.
"""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from axc_agent_engine.observability.audit import AuditEventType
from .common import Collection


class RunLog:
    def __init__(self, db):
        self.items = Collection(db, 'run', '运行记录')

    def record(self, row: dict) -> None:
        self.items.put(row)

    def query(self, agent_id: str | None = None, days: int | None = None) -> list[dict]:
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat() if days is not None else ''
        return [r for r in self.items.all() if (not agent_id or r['agentId'] == agent_id) and r['createdAt'] >= since]

    def usage(self, agent_id: str) -> dict:
        rows = self.query(agent_id)
        return {'inputTokens': sum(r['inputTokens'] for r in rows), 'outputTokens': sum(r['outputTokens'] for r in rows),
                'runs': len(rows)}


class ToolFailures:
    """Engine ``AuditSink`` collecting failed and rejected tool calls by (session id, tool call id).
    ``tool_result`` events carry no success flag (core/react_loop.py builds them from display content only), while
    the orchestrator audits every failure before that event is emitted; the run loop pops the entry per result.
    tool_result 事件不带成败标记，失败与拒绝由审计事件提供，运行循环按结果逐条取出。"""

    FAILED = frozenset({AuditEventType.TOOL_CALL_FAILED, AuditEventType.TOOL_CALL_REJECTED})

    def __init__(self):
        self.errors: dict[tuple[str, str], str] = {}

    async def record(self, event) -> None:
        if event.type in self.FAILED:
            self.errors[(event.session_id, event.tool_call_id)] = str(event.error.get('message') or event.type)

    def pop(self, session_id: str, tool_call_id: str) -> str | None:
        """Error message of a failed call, None when it succeeded. / 失败调用的错误信息。"""
        return self.errors.pop((session_id, tool_call_id), None)
