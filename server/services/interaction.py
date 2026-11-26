"""Human-in-the-loop channel for one conversation run. / 单次对话运行的人工交互通道。

The engine ``human_in_the_loop`` plugin (plugins/builtin/human_in_the_loop/plugin.py) uses the run options
``approval_queue`` / ``response_queue``:
- approval: it puts ``{"type": "request", request_id, tool_name, arguments, risk_level}`` on approval_queue and its
  own listener consumes the SAME queue waiting for ``{"type": "response", request_id, approved}``; items it does
  not want are put back.
- ask_human: the tool puts ``{"type": "ask_human", question, options}`` on approval_queue (tools/runtime.py maps
  request_queue to it) and awaits the raw answer on response_queue.
So this consumer reads approval_queue, puts back ``response`` items (they belong to the plugin listener), turns
requests into prompts, and on respond writes the reply to the queue the engine waits on.
引擎插件与本消费者共用 approval_queue：response 条目放回给插件监听器，其余转为待处理提示。
"""
from __future__ import annotations
import asyncio
import logging
from .common import now, uid

logger = logging.getLogger(__name__)


class PromptChannel:
    def __init__(self, host, key: str):
        self.host, self.key = host, key
        self.approval: asyncio.Queue = asyncio.Queue()
        self.response: asyncio.Queue = asyncio.Queue()
        self.task = asyncio.create_task(self._consume())

    def run_options(self) -> dict:
        return {'approval_queue': self.approval, 'response_queue': self.response}

    async def _consume(self) -> None:
        while True:
            item = await self.approval.get()
            kind = item.get('type')
            if kind == 'response':
                await self.approval.put(item)
                await asyncio.sleep(0.01)  # Let the plugin listener take it. / 让插件监听器取走。
            elif kind == 'request':
                self._emit(dict(id=item['request_id'], kind='approval', toolName=item['tool_name'],
                                arguments=dict(item['arguments']), riskLevel=str(item['risk_level'])))
            elif kind == 'ask_human':
                self._emit(dict(id=uid(), kind='question', question=item['question'], options=list(item['options'])))
            else:
                logger.error('unknown human interaction request from engine: %r', item)

    def _emit(self, prompt: dict) -> None:
        seq = self.host.db.get('resource', self.key)['snapshot']['seq']
        self.host.emit(self.key, 'prompt', {**prompt, 'order': seq + 1, 'status': 'pending', 'createdAt': now()})

    async def respond(self, prompt: dict, approved: bool | None, answer: str | None) -> dict:
        if prompt['kind'] == 'approval':
            if approved is None:
                raise ValueError('审批需要 approved')
            await self.approval.put({'type': 'response', 'request_id': prompt['id'], 'approved': approved})
            value = approved
        else:
            if answer is None or not answer.strip():
                raise ValueError('回答不能为空')
            await self.response.put(answer)
            value = answer
        return self.host.emit(self.key, 'prompt', {**prompt, 'status': 'answered', 'answer': value})

    async def close(self) -> None:
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)
        expire_pending(self.host, self.key)


def expire_pending(host, key: str) -> None:
    """Mark unanswered prompts expired (run ended or host restarted). / 未回答的提示置为过期。"""
    row = host.db.get('resource', key)
    for prompt in row['snapshot']['prompts'] if row else []:
        if prompt['status'] == 'pending':
            host.emit(key, 'prompt', {**prompt, 'status': 'expired'})
