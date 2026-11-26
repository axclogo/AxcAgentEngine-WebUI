"""Host side of the engine ``sessions`` plugin. / 引擎 sessions 插件的宿主实现。

``SessionsService`` implements ``SessionService`` (axc_agent_engine/plugins/builtin/sessions/protocol.py) over the
WebUI conversations, and owns the grants, watches, dispatch records, run provenance and completion notices.
Storage (one bucket each, JSON-array keys):
- ``session_grant``   [callerSessionId, targetType, targetId, level] -> {decision, reason, createdAt}
- ``session_watch``   [watcherSessionId, targetSessionId]           -> {createdByRunId, createdAt}
- ``session_dispatch``[targetRunId, callerSessionId] -> {targetSessionId, callerRunId, callerChain, kind, createdAt}
- ``run_provenance``  runId -> {sessionId, depth, chain, parentSessionId, parentRunId, rootSessionId,
  quiet: [sessionId] (no notice to these), settled: terminal status | None, notified: bool}
规则见 WEBUI_PLAN.md 的 W3。
"""
from __future__ import annotations
import asyncio
import json
from axc_agent_engine.plugins.builtin.sessions import SessionInfo, SessionMessage, decide, format_notice, notice_id

from .common import now, uid
from .turns import Turn


ACCESS_TIMEOUT = 120  # Shorter than the plugin tool timeout (150 s). / 短于插件工具超时。
LIVE_INPUT_TIMEOUT = 60  # Seconds a run marked running may take to accept input. / 运行接收输入前的最长等待秒数。
ROOT = {'depth': 0, 'chain': [], 'parentSessionId': None, 'parentRunId': None, 'rootSessionId': None}
NOTICE_ACTOR = '后台会话通知'
ARCHIVED_REASON = '目标会话已归档，不能发送'


def default_provenance() -> dict:
    return {**ROOT, 'chain': []}


def new_conversation_fields() -> dict:
    """Session-operation fields of a new conversation (v3 migration writes the same). / 新会话的会话操作字段。"""
    return dict(provenance=default_provenance(), autoWakeups=0, forkCheckpointId=None, archivedReason=None,
                editedFrom=None)


def child_provenance(parent: dict, caller_session: str, caller_run: str) -> dict:
    """W3.3: provenance of a run dispatched by ``caller_session`` in ``caller_run``. / 派发得到的子来源链。"""
    return {'depth': parent['depth'] + 1, 'chain': [*parent['chain'], caller_session],
            'parentSessionId': caller_session, 'parentRunId': caller_run,
            'rootSessionId': parent['rootSessionId'] or caller_session}


class SessionsService:
    def __init__(self, host):
        self.host = host
        self.db = host.db
        self.dispatch_lock = asyncio.Lock()

    # ---------- storage helpers ----------
    def row(self, session_id: str) -> dict | None:
        row = self.db.get('resource', f'conversation:{session_id}')
        return row if row and row['kind'] == 'conversation' else None

    def run_provenance(self, run_id: str) -> dict:
        return self.db.get('run_provenance', run_id) or {}

    def record_run(self, run_id: str, session_id: str, provenance: dict) -> None:
        """Persist the provenance a run was started with (kept on resume). / 记录运行的来源链。"""
        old = self.db.get('run_provenance', run_id)
        if old is None:
            self.db.put('run_provenance', run_id, {**provenance, 'sessionId': session_id, 'quiet': [],
                                                   'settled': None, 'notified': False})

    def _update_run(self, run_id: str, **changes) -> None:
        value = self.db.get('run_provenance', run_id)
        if value is None:
            raise ValueError(f'运行缺少来源链记录：{run_id}')
        self.db.put('run_provenance', run_id, {**value, **changes})

    def suppress(self, run_id: str, session_id: str) -> None:
        """Never notify ``session_id`` about ``run_id`` (edit stopped it). / 不就该运行通知该会话。"""
        self._update_run(run_id, quiet=[*self.run_provenance(run_id)['quiet'], session_id])

    def settle(self, run_id: str, status: str) -> None:
        """Persist a run's terminal status before notices are delivered; a resumed run settles again and gets
        a new notice. 投递通知前持久化运行终态；恢复后再次结束的运行会得到新的通知。"""
        record = self.run_provenance(run_id)
        self._update_run(run_id, settled=status, notified=False, settlements=record.get('settlements', 0) + 1)

    def notice_ident(self, session_id: str, run_id: str) -> str:
        """Notice id of the run's latest settlement (stop, then resume, then finish = two notices).
        本次结束对应的通知 id（停止后恢复再结束会产生第二条通知）。"""
        count = self.run_provenance(run_id)['settlements']
        return notice_id(session_id, run_id if count == 1 else f'{run_id}.{count}')

    def dispatches(self, *, target_run: str | None = None, caller: str | None = None) -> list[tuple[list, dict]]:
        out = []
        for key, value in self.db.items('session_dispatch'):
            target_run_id, caller_id = json.loads(key)
            if (target_run is None or target_run_id == target_run) and (caller is None or caller_id == caller):
                out.append(([target_run_id, caller_id], value))
        return out

    def watchers(self, target: str) -> list[str]:
        return [json.loads(k)[0] for k, _ in self.db.items('session_watch') if json.loads(k)[1] == target]

    def grants(self, caller: str) -> list[dict]:
        out = []
        for key, value in self.db.items('session_grant'):
            caller_id, target_type, target_id, level = json.loads(key)
            if caller_id == caller:
                out.append({'id': key, 'targetType': target_type, 'targetId': target_id, 'level': level, **value})
        return sorted(out, key=lambda g: g['createdAt'])

    def put_grant(self, caller: str, target: tuple[str, str], level: str, decision: str, reason: str) -> None:
        """``target``: ('session', id) or ('agent', id). / 授权目标。"""
        self.db.put('session_grant', json.dumps([caller, *target, level]),
                    {'decision': decision, 'reason': reason, 'createdAt': now()})

    def revoke_grant(self, caller: str, grant_id: str) -> None:
        try:
            parsed = json.loads(grant_id)
        except json.JSONDecodeError:
            parsed = None
        owned = isinstance(parsed, list) and len(parsed) == 4 and parsed[0] == caller
        if not owned or self.db.get('session_grant', grant_id) is None:
            raise ValueError('授权记录不存在')
        self.db.remove('session_grant', grant_id)

    def forget_runs(self, session_id: str, runs: set[str]) -> None:
        """Drop dispatches and watches created by voided runs (edit). / 撤销作废轮次产生的派发与订阅。"""
        for key, value in self.dispatches(caller=session_id):
            if value['callerRunId'] in runs:
                self.db.remove('session_dispatch', json.dumps(key))
        for key, value in self.db.items('session_watch'):
            if json.loads(key)[0] == session_id and value['createdByRunId'] in runs:
                self.db.remove('session_watch', key)

    # ---------- checks ----------
    def _caller(self, caller: dict) -> tuple[dict, dict]:
        row = self.row(caller['session_id'])
        if row is None:
            raise ValueError('调用方会话不存在')
        m = row['snapshot']['meta']
        if not caller['run_id'] or m['runId'] != caller['run_id']:
            raise ValueError('调用方运行已结束')
        provenance = self.run_provenance(caller['run_id'])
        if not provenance:
            raise ValueError('调用方运行缺少来源链记录')
        return row, provenance

    def ancestors(self, caller: dict) -> set[str]:
        """Chain of this run plus every session that dispatched into it and their chains. / 本轮的全部上级。"""
        out = set(self.run_provenance(caller['run_id'])['chain'])
        out.update(caller['provenance']['chain'])
        for (_, caller_id), value in self.dispatches(target_run=caller['run_id']):
            out.add(caller_id)
            out.update(value['callerChain'])
        return out

    def _target(self, caller: dict, session_id: str) -> dict:
        self._caller(caller)
        if session_id == caller['session_id']:
            raise ValueError('不能操作当前会话自身')
        if session_id in self.ancestors(caller):
            raise ValueError('不能访问派自己干活的上级会话')
        row = self.row(session_id)
        if row is None:
            raise ValueError('目标会话不存在')
        return row

    def records(self, caller: str, m: dict) -> list[dict]:
        """Grant records of ``caller`` that cover conversation ``m``, plus the caller agent's pre-authorizations
        (as granted records). 覆盖目标会话的授权记录，加上调用方 Agent 的预先授权（视为已允许）。"""
        targets = {('session', m['id']), ('agent', m['agentId'])}
        out = [g for g in self.grants(caller) if (g['targetType'], g['targetId']) in targets]
        caller_row = self.row(caller)
        agent = self.host.agents_svc.items.find(caller_row['snapshot']['meta']['agentId']) if caller_row else None
        for g in agent['runtime']['sessionGrants'] if agent else []:
            if g['target'] in ('*', m['agentId']):
                out.append({'level': g['level'], 'decision': 'granted', 'reason': 'preset'})
        return out

    def access(self, caller: str, row: dict) -> str:
        """Access level shown in session_list, from the same lookup as authorize. / 与授权判断一致的权限。"""
        m = row['snapshot']['meta']
        for level in ('operate', 'read'):
            if self._decided(caller, m, level) == 'granted':
                return level
        return 'none'

    def _active(self, caller: str) -> set[str]:
        """Target sessions dispatched by ``caller`` whose dispatched run is still running. / 正在运行的派发会话。"""
        out = set()
        for (target_run, _), value in self.dispatches(caller=caller):
            row = self.row(value['targetSessionId'])
            m = row['snapshot']['meta'] if row else None
            if m and m['runId'] == target_run and m['status'] == 'running':
                out.add(value['targetSessionId'])
        return out

    def _dispatch(self, caller: dict, target: str, target_run: str, kind: str) -> None:
        chain = self.run_provenance(caller['run_id'])['chain']
        self.db.put('session_dispatch', json.dumps([target_run, caller['session_id']]),
                    {'targetSessionId': target, 'callerRunId': caller['run_id'], 'callerChain': chain, 'kind': kind,
                     'createdAt': now()})

    # ---------- SessionService ----------
    async def list_sessions(self, caller: dict, filters: dict) -> list[SessionInfo]:
        self._caller(caller)
        hidden = self.ancestors(caller) | {caller['session_id']}
        rows = []
        for _, row in self.db.items('resource'):
            if row['kind'] != 'conversation':
                continue
            m = row['snapshot']['meta']
            if m['id'] in hidden:
                continue
            if filters.get('agent_name') and m['agentId'] != filters['agent_name']:
                continue
            if filters.get('status') and m['status'] != filters['status']:
                continue
            if filters.get('title') and filters['title'].lower() not in m['title'].lower():
                continue
            messages = [x for x in row['snapshot']['messages'] if not x.get('streaming')]
            updated = messages[-1]['createdAt'] if messages else m['createdAt']
            if filters.get('updated_after') and updated <= filters['updated_after']:
                continue
            rows.append(SessionInfo(session_id=m['id'], agent_name=m['agentId'], title=m['title'], status=m['status'],
                                    updated_at=updated, access=self.access(caller['session_id'], row),
                                    last_message_id=messages[-1]['id'] if messages else '', scope=row['scope']))
        rows.sort(key=lambda r: r.updated_at, reverse=True)
        return rows[:filters.get('limit', 20)]

    async def read(self, caller: dict, session_id: str, since: str | None, limit: int) -> list[SessionMessage]:
        row = self._target(caller, session_id)
        messages = [x for x in row['snapshot']['messages'] if x['kind'] == 'chat' and x['role'] in ('user', 'assistant')
                    and not x.get('streaming') and x.get('text', '').strip()]
        if since:
            index = next((i for i, x in enumerate(messages) if x['id'] == since), None)
            if index is None:
                raise ValueError(f'消息不存在：{since}')
            messages = messages[index + 1:]
        return [SessionMessage(message_id=x['id'], role=x['role'], text=x['text'], created_at=x['createdAt'],
                               origin_session_id=x.get('originSessionId') or '') for x in messages[-limit:]]

    async def send(self, caller: dict, session_id: str, text: str, max_active: int) -> dict:
        row = self._target(caller, session_id)
        if row['snapshot']['meta']['archived']:
            return {'accepted': False, 'message_id': '', 'reason': ARCHIVED_REASON}
        caller_row, parent = self._caller(caller)
        key = f'conversation:{session_id}'
        async with self.dispatch_lock:
            active = self._active(caller['session_id'])
            if session_id not in active and len(active) + 1 > max_active:
                return {'accepted': False, 'message_id': '', 'reason': f'同时运行的派发会话已达上限 {max_active}'}
            async with self.host.locks.setdefault(key, asyncio.Lock()):
                m = self.db.get('resource', key)['snapshot']['meta']
                # Archive holds the same lock; re-check inside. / 归档持同一会话锁，锁内复核。
                if m['archived']:
                    return {'accepted': False, 'message_id': '', 'reason': ARCHIVED_REASON}
                message_id = uid()
                actor = f"会话「{caller_row['snapshot']['meta']['title']}」"
                if m['status'] == 'running':
                    receipt = await self.live_input(key, text, message_id)
                    if receipt == 'starting':
                        return {'accepted': False, 'message_id': '', 'reason': '目标会话正在启动，请稍后重试'}
                    if receipt != 'closed':
                        self.host.message(key, text, actor, 'user', ident=message_id, runId=m['runId'],
                                          originSessionId=caller['session_id'])
                        self._dispatch(caller, session_id, m['runId'], 'send')
                        return {'accepted': True, 'message_id': message_id, 'reason': ''}
                turn = Turn(provenance=child_provenance(parent, caller['session_id'], caller['run_id']),
                            message=dict(ident=message_id, actor=actor, originSessionId=caller['session_id']))
                run = (await self.host.start_turn(key, text, turn))['run']
                self._dispatch(caller, session_id, run, 'send')
        return {'accepted': True, 'message_id': message_id, 'reason': ''}

    async def create(self, caller: dict, agent_name: str, text: str, title: str, max_active: int) -> dict:
        caller_row, parent = self._caller(caller)
        agent = self.host.agents_svc.items.find(agent_name)
        if agent is None or not agent['enabled']:
            return {'accepted': False, 'session_id': '', 'reason': f'Agent 不存在或已停用：{agent_name}'}
        async with self.dispatch_lock:
            if len(self._active(caller['session_id'])) + 1 > max_active:
                return {'accepted': False, 'session_id': '', 'reason': f'同时运行的派发会话已达上限 {max_active}'}
            provenance = child_provenance(parent, caller['session_id'], caller['run_id'])
            meta = self.host.create('conversation', caller_row['scopeObject'], agent_name)
            key = f"conversation:{meta['id']}"
            self.host.meta(key, provenance=provenance, title=title or text.split('\n', 1)[-1][:40] or '派生会话')
            self.put_grant(caller['session_id'], ('session', meta['id']), 'operate', 'granted', 'create')
            actor = f"会话「{caller_row['snapshot']['meta']['title']}」"
            turn = Turn(provenance=provenance, keep_title=True,
                        message=dict(actor=actor, originSessionId=caller['session_id']))
            async with self.host.locks.setdefault(key, asyncio.Lock()):
                run = (await self.host.start_turn(key, text, turn))['run']
            self._dispatch(caller, meta['id'], run, 'create')
        return {'accepted': True, 'session_id': meta['id'], 'reason': ''}

    async def stop(self, caller: dict, session_id: str) -> dict:
        row = self._target(caller, session_id)
        m = row['snapshot']['meta']
        if m['status'] != 'running':
            return {'stopped': True, 'status': m['status']}
        if not self.host.engine.cancel_run(m['runId']):
            return {'stopped': False, 'status': m['status']}
        return {'stopped': True, 'status': 'cancelled'}

    async def watch(self, caller: dict, session_id: str, enabled: bool) -> None:
        self._target(caller, session_id)
        key = json.dumps([caller['session_id'], session_id])
        if enabled:
            self.db.put('session_watch', key, {'createdByRunId': caller['run_id'], 'createdAt': now()})
        else:
            self.db.remove('session_watch', key)

    async def authorize(self, caller: dict, session_id: str, level: str, cross_agent: bool) -> str:
        if level not in ('read', 'operate'):
            raise ValueError('level 必须是 read 或 operate')
        row = self._target(caller, session_id)
        m = row['snapshot']['meta']
        caller_meta = self.row(caller['session_id'])['snapshot']['meta']
        if not cross_agent and m['agentId'] != caller_meta['agentId']:
            return 'denied'
        decided = self._decided(caller['session_id'], m, level)
        if decided:
            return decided
        channel = self.host.channels.get(f"conversation:{caller['session_id']}")
        if channel is None:
            return 'unavailable'
        prompt, future = channel.ask(dict(kind='session_access', level=level, targetSessionId=m['id'],
                                          targetTitle=m['title'], targetAgentId=m['agentId'],
                                          targetAgentName=self.host.display(m['agentId']), targetScope=row['scope']))
        try:
            choice = await asyncio.wait_for(asyncio.shield(future), ACCESS_TIMEOUT)
        except asyncio.TimeoutError:
            channel.expire(prompt['id'])
            self.put_grant(caller['session_id'], ('session', m['id']), level, 'denied', 'timeout')
            return 'denied'
        if choice == 'unavailable':
            return 'unavailable'
        if choice == 'deny':
            self.put_grant(caller['session_id'], ('session', m['id']), level, 'denied', 'user')
            return 'denied'
        target = ('agent', m['agentId']) if choice == 'agent' else ('session', m['id'])
        self.put_grant(caller['session_id'], target, level, 'granted', 'user')
        return 'granted'

    def _decided(self, caller: str, m: dict, level: str) -> str | None:
        """W3.7 lookup order 2–4; a user's explicit denial beats a pre-authorization. / 用户明确拒绝优先于预先授权。"""
        records = [g for g in self.records(caller, m) if g['level'] in ('read', level) or g['decision'] == 'granted']
        denied = [g for g in records if g['decision'] == 'denied']
        if any(g['reason'] != 'timeout' for g in denied):
            return 'denied'
        levels = ('read', 'operate') if level == 'read' else ('operate',)
        if any(g['level'] in levels and g['decision'] == 'granted' for g in records):
            return 'granted'
        # An unanswered prompt counts as a denial, but yields to any grant. / 超时未答视为拒绝，但让位于任何允许。
        return 'denied' if denied else None

    async def live_input(self, key: str, text: str, message_id: str) -> str:
        """Deliver into the running run. ``closed`` means the run has ended (the status left running);
        ``starting`` means it is still marked running but never accepted input.
        送入运行中的一轮；closed 表示已结束，starting 表示仍标记运行但一直未就绪。"""
        for _ in range(int(LIVE_INPUT_TIMEOUT / 0.05)):
            m = self.db.get('resource', key)['snapshot']['meta']
            agent = await self.host.agent(m['agentId'])
            receipt = await agent.send_message(m['runId'], text, session_id=m['id'], message_id=message_id)
            if receipt != 'closed':
                return receipt
            if self.db.get('resource', key)['snapshot']['meta']['status'] != 'running':
                return 'closed'
            await asyncio.sleep(0.05)
        return 'starting'

    # ---------- completion notices ----------
    async def run_ended(self, session_id: str, run_id: str, status: str) -> None:
        """W3.9: deliver completion notices for a settled run with its terminal status; failures propagate and the
        run stays un-notified, so the next startup replays it (ids are idempotent).
        按运行终态投递完成通知；失败直接抛出且不标记已通知，下次启动补发（通知 id 幂等）。"""
        record = self.run_provenance(run_id)
        row = self.row(session_id)
        if row is not None:
            m = row['snapshot']['meta']
            recipients = [caller for (_, caller), _ in self.dispatches(target_run=run_id)]
            recipients += [w for w in self.watchers(session_id) if w not in recipients]
            recipients = [r for r in recipients if r not in record['quiet']]
            replies = [x for x in row['snapshot']['messages'] if x['role'] == 'assistant' and x['kind'] == 'chat'
                       and x.get('runId') == run_id]
            text = format_notice(title=m['title'], agent_name=self.host.display(m['agentId']), status=status,
                                 last_reply=replies[-1]['text'] if replies else '')
            for caller in recipients:
                await self.deliver(caller, self.notice_ident(session_id, run_id), text, session_id)
        self._update_run(run_id, notified=True)

    async def settled(self, session_id: str, run_id: str, status: str, closing: bool) -> None:
        """Persist the terminal status, then notify unless shutting down; startup replays the rest (N5).
        先持久化终态，非关闭期间立即通知；其余在启动时补发。"""
        self.settle(run_id, status)
        if not closing:
            await self.run_ended(session_id, run_id, status)

    async def replay(self) -> None:
        """Deliver notices of settled runs that were never notified (shutdown or crash). / 补发未投递的通知。"""
        for run_id, record in self.db.items('run_provenance'):
            if record['settled'] and not record['notified']:
                await self.run_ended(record['sessionId'], run_id, record['settled'])

    async def deliver(self, caller: str, ident: str, text: str, source: str) -> str:
        key = f'conversation:{caller}'
        async with self.host.locks.setdefault(key, asyncio.Lock()):
            row = self.row(caller)
            if row is None:
                return 'drop'
            if any(x['id'] == ident for x in row['snapshot']['messages']):
                return 'skip'
            m = row['snapshot']['meta']
            fields = dict(sourceSessionId=source)
            agent = self.host.agents_svc.items.find(m['agentId'])
            if agent is None:
                # The caller's agent was deleted: keep the notice visible, nothing can run. / Agent 已删除：保留通知。
                self.host.message(key, text, NOTICE_ACTOR, 'user', 'notice', ident=ident, held=True, **fields)
                return 'hold'
            state = 'archived' if m['archived'] else 'running' if m['status'] == 'running' else 'idle'
            limit = agent['runtime']['maxWakeups']
            action = decide(caller_state=state, auto_wakeups=m['autoWakeups'], max_wakeups=limit)
            if action == 'inject':
                receipt = await self.live_input(key, text, ident)
                if receipt == 'starting':
                    # Not notified: startup replays it. / 不标记已通知，启动时补发。
                    raise RuntimeError(f'会话 {caller} 的运行 {LIVE_INPUT_TIMEOUT} 秒内未能接收通知')
                if receipt != 'closed':
                    # Every extra step a notice causes counts, injected or not (engine 3.3.1).
                    # 通知每让发起方多执行一步就计数，送入当前运行也算。
                    self.host.message(key, text, NOTICE_ACTOR, 'user', 'notice', ident=ident, runId=m['runId'],
                                      **fields)
                    self.host.meta(key, autoWakeups=m['autoWakeups'] + 1)
                    return action
                else:
                    action = decide(caller_state='idle', auto_wakeups=m['autoWakeups'], max_wakeups=limit)
            if action == 'start':
                message = dict(ident=ident, actor=NOTICE_ACTOR, kind='notice', startsRun=None, **fields)
                await self.host.start_turn(key, text, Turn(origin='notice', message=message))
                self.host.meta(key, autoWakeups=m['autoWakeups'] + 1)
            elif action == 'hold':
                self.host.message(key, text, NOTICE_ACTOR, 'user', 'notice', ident=ident, held=True, **fields)
            return action
