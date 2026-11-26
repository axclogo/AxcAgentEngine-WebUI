"""Human-in-the-loop channel for one conversation run. / 单次对话运行的人工交互通道。

Engine prompts. The engine ``human_in_the_loop`` plugin (plugins/builtin/human_in_the_loop/plugin.py) uses the
run options ``approval_queue`` / ``response_queue``:
- approval: it puts ``{"type": "request", request_id, tool_name, arguments, risk_level}`` on approval_queue and its
  own listener consumes the SAME queue waiting for ``{"type": "response", request_id, approved}``; items it does
  not want are put back.
- ask_human: the tool puts ``{"type": "ask_human", question, options}`` on approval_queue (tools/runtime.py maps
  request_queue to it) and awaits the raw answer on response_queue.
So this consumer reads approval_queue, puts back ``response`` items (they belong to the plugin listener), turns
requests into prompts, and on respond writes the reply to the queue the engine waits on.
引擎插件与本消费者共用 approval_queue：response 条目放回给插件监听器，其余转为待处理提示。

Host prompts. ``session_access`` is raised by the host itself (``SessionService.authorize``), never through the
engine queues: the host holds a future, the prompt shares the snapshot, ``respond`` and expiry paths.
宿主提示（session_access）由宿主自己持有 future，不经过引擎队列，复用提示快照、respond 与过期处理。
"""
from __future__ import annotations
import asyncio
import logging
from .common import now, uid

logger = logging.getLogger(__name__)

ACCESS_CHOICES = ('session', 'agent', 'deny')


class PromptChannel:
    def __init__(self, host, key: str, run_id: str = ''):
        self.host, self.key, self.run_id = host, key, run_id
        self.approval: asyncio.Queue = asyncio.Queue()
        self.response: asyncio.Queue = asyncio.Queue()
        self.waiting: dict[str, asyncio.Future] = {}
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

    def _emit(self, prompt: dict) -> dict:
        seq = self.host.db.get('resource', self.key)['snapshot']['seq']
        value = {**prompt, 'order': seq + 1, 'status': 'pending', 'createdAt': now()}
        if self.run_id:
            value['runId'] = self.run_id
        self.host.emit(self.key, 'prompt', value)
        return value

    def ask(self, prompt: dict) -> tuple[dict, asyncio.Future]:
        """Raise a host prompt; the future resolves to a choice or ``unavailable``. / 发出宿主提示。"""
        value = self._emit({**prompt, 'id': uid()})
        future = asyncio.get_running_loop().create_future()
        self.waiting[value['id']] = future
        return value, future

    def expire(self, prompt_id: str) -> None:
        """Expire one host prompt that timed out. / 将超时的宿主提示置为过期。"""
        self.waiting.pop(prompt_id, None)
        row = self.host.db.get('resource', self.key)
        prompt = next((p for p in row['snapshot']['prompts'] if p['id'] == prompt_id), None) if row else None
        if prompt and prompt['status'] == 'pending':
            self.host.emit(self.key, 'prompt', {**prompt, 'status': 'expired'})

    async def respond(self, prompt: dict, approved: bool | None, answer: str | None, choice: str | None = None) -> dict:
        if prompt['kind'] == 'session_access':
            if choice not in ACCESS_CHOICES:
                raise ValueError('会话授权需要 choice：session、agent 或 deny')
            future = self.waiting.pop(prompt['id'], None)
            if future is None or future.done():
                raise ValueError('该提示不存在或已处理')
            future.set_result(choice)
            value = choice
        elif prompt['kind'] == 'approval':
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
        for future in self.waiting.values():
            if not future.done():
                future.set_result('unavailable')
        self.waiting.clear()
        expire_pending(self.host, self.key, self.run_id or None)


def expire_pending(host, key: str, run_id: str | None = None) -> None:
    """Mark unanswered prompts expired; ``run_id`` narrows it to one run.
    未回答的提示置为过期；给了 run_id 时只处理该次运行的提示。"""
    row = host.db.get('resource', key)
    for prompt in row['snapshot']['prompts'] if row else []:
        if prompt['status'] == 'pending' and (run_id is None or prompt.get('runId') == run_id):
            host.emit(key, 'prompt', {**prompt, 'status': 'expired'})
