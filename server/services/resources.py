"""Single-user local host: resources, commands, durable state, engine execution. / 本地单用户宿主。

``HostService`` owns the engine, the database and every management service; conversations and
simulations follow the resource + snapshot + SSE event protocol in ``src/core.ts``.
"""
import asyncio
import base64
from copy import deepcopy
import json
from pathlib import Path
from axc_agent_engine import Engine
from axc_agent_engine.core.dispatcher import AgentMessageDispatcher
from axc_agent_engine.storage.in_memory import InMemoryMessageBus
from axc_agent_engine.sidecar.multi_agent import MultiAgentSession, SessionMode
from axc_agent_engine.sidecar.simulation import SIMULATION_MODE_ADAPTERS, AgentPolicyAdapter, AgentProfile
from ..crypto import SecretBox
from ..db import Checkpoints, Database, Messages
from ..models import LocalScope, configured_model
from .agents import AgentService, build_registry, plugin_catalog
from .common import NotFound, now, safe_filename, suffix, uid
from .evals import EvalService
from .graphs import GraphServiceHost
from .knowledge import KnowledgeService
from .providers import ProviderService
from .seed import seed as seed_demo
from .skills import SkillService

CAPS = 'send insert enqueue priority cancelRequest stop resume delete archive upload fork start pause interview report edit'.split()
MAX_ATTACHMENT = 20 * 1024 * 1024
MAX_ATTACHMENT_TEXT = 100_000
TEXT_TYPES = ('application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/toml',
              'application/javascript')
TEXT_EXTENSIONS = {'.txt', '.md', '.markdown', '.rst', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml',
                   '.xml', '.html', '.htm', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c',
                   '.h', '.cpp', '.sh', '.sql', '.log', '.ini', '.cfg'}
IMAGE_TYPES = ('image/png', 'image/jpeg', 'image/gif', 'image/webp')


def scoped(scope):
    parsed = LocalScope.model_validate(scope)
    if parsed.shortcut:
        return f"topic:{parsed.shortcut.context.topic_id}"
    if parsed.key != 'local':
        raise ValueError('独立宿主只支持 local 或已登记专题')
    return 'local'


class HostService:
    def __init__(self, data, model=None, *, db=None, seed=False):
        self.data = Path(data)
        self.data.mkdir(parents=True, exist_ok=True)
        self.db = Database(str(db or self.data / 'workbench.db'))
        self.checkpoints = Checkpoints(self.db)
        self.registry = build_registry()
        self.engine = Engine(plugin_registry=self.registry, checkpoint_store=self.checkpoints,
                             message_persistence=Messages(self.db))
        # Shared model override (tests / fixture mode); None resolves each agent's providers.
        # 共享模型覆盖（测试或 fixture 模式）；None 表示按 Agent 解析提供商。
        self.model = model if model is not None else configured_model()
        self.providers = ProviderService(self.db, SecretBox(self.data))
        self.skills = SkillService(self.db, self.data)
        self.knowledge = KnowledgeService(self.db, self.data)
        self.graphs = GraphServiceHost(self.db)
        self.agents_svc = AgentService(self.db, self.data, self.registry, self.providers, self.skills,
                                       self.knowledge, self.graphs)
        self.evals = EvalService(self.db, self.agents_svc)
        self.bus = InMemoryMessageBus()
        self.dispatcher = AgentMessageDispatcher(message_bus=self.bus)
        self.tasks = {}
        self.gates = {}
        self.listeners = {}
        self.locks = {}
        self.agent_lock = asyncio.Lock()
        for key, row in self.db.items('resource'):
            if row['snapshot']['meta']['status'] in ('running', 'paused'):
                row['snapshot']['meta']['status'] = 'interrupted' if row['kind'] == 'conversation' else 'failed'
                row['snapshot']['seq'] += 1
                self.db.put('resource', key, row)
        for row in self.evals.items.all():
            if row['status'] == 'running':
                self.evals.items.put({**row, 'status': 'failed', 'error': '宿主重启，评估已中断'})
        if seed:
            seed_demo(self)

    # ---------- agents ----------
    def agent_row(self, agent_id):
        row = self.agents_svc.items.find(agent_id)
        if row is None:
            raise ValueError('未知 Agent')
        return row

    def display(self, agent_id):
        row = self.agents_svc.items.find(agent_id)
        return row['name'] if row else agent_id

    def busy(self, agent_id):
        for key, task in self.tasks.items():
            if task.done():
                continue
            row = self.db.get('resource', key)
            m = row['snapshot']['meta'] if row else {}
            if m.get('agentId') == agent_id or agent_id in (m.get('definition') or {}).get('agents', []):
                return True
        return any(not t.done() for t in self.evals.tasks.values())

    async def agent(self, agent_id):
        """Engine agent for an agent id, rebuilt when its definition changed. / 获取（必要时重建）引擎 Agent。"""
        self.agent_row(agent_id)
        async with self.agent_lock:
            cached = self.agents_svc.cache.get(agent_id)
            instance = await self.agents_svc.instance(self.engine, agent_id, self.model, self.busy(agent_id))
            if cached is None or cached[1] is not instance:
                if cached is not None:
                    await self.dispatcher.stop_consumer(agent_id)
                self.dispatcher.run_agent_consumer(instance)
            return instance

    async def unload_agent(self, agent_id):
        async with self.agent_lock:
            if agent_id in self.agents_svc.cache:
                await self.dispatcher.stop_consumer(agent_id)
                await self.agents_svc.unload(self.engine, agent_id)

    def plugins(self):
        return plugin_catalog(self.registry)

    # ---------- resources ----------
    def key(self, kind, ident):
        return f'{kind}:{ident}'

    def get(self, kind, ident, scope):
        row = self.db.get('resource', self.key(kind, ident))
        if row is None:
            raise ValueError('任务或会话不存在')
        requested = scoped(scope)
        if row['scope'] != requested and not (kind == 'conversation' and requested == 'local'):
            raise ValueError('范围不匹配')
        return row

    def capabilities(self, row, scope):
        m = row['snapshot']['meta']
        status = m['status']
        running = status == 'running'
        chat = row['kind'] == 'conversation'
        source_block = chat and row['scope'] != scoped(scope)
        resumable = bool(m['runId']) and any(cp['run_id'] == m['runId'] for _, cp in self.db.items('checkpoint'))
        values = dict(send=chat and not running and not source_block, insert=chat and running and not source_block,
            stop=status in ('running', 'paused'), resume=(chat and resumable and not source_block and status in ('cancelled', 'interrupted')) or status == 'paused',
            # Conversations are archived first and only archived ones can be deleted. / 会话须先归档才能删除。
            delete=status not in ('running', 'paused') and (not chat or bool(m.get('archived'))),
            # Archiving is list management, allowed for any visible conversation that is not running.
            # 归档属于列表管理，任何可见且未运行的会话都可以归档。
            archive=chat and status not in ('running', 'paused'), fork=chat and not source_block and bool(m['checkpoints']),
            upload=chat and not source_block,
            start=not chat and status == 'idle', pause=not chat and running,
            interview=not chat, report=not chat, edit=not chat and status == 'idle')
        return {k: values.get(k, False) for k in CAPS}

    def snapshot(self, kind, ident, scope):
        row = self.get(kind, ident, scope)
        s = deepcopy(row['snapshot'])
        s['meta']['capabilities'] = self.capabilities(row, scope)
        return s

    def catalog(self, scope):
        scoped(scope)
        agents = [dict(id=a['id'], name=a['name'], avatar=a['avatar']) for a in self.agents_svc.items.all() if a['enabled']]
        return dict(agents=agents, defaultAgentId=agents[0]['id'] if agents else '', create=bool(agents),
                    createSimulation=bool(agents))

    def list(self, kind, scope, filters):
        owner_key = scoped(scope)
        out = []
        for _, row in self.db.items('resource'):
            if row['kind'] != kind or (row['scope'] != owner_key and not (kind == 'conversation' and owner_key == 'local')):
                continue
            m = row['snapshot']['meta']
            if filters.get('keyword', '').lower() not in m['title'].lower():
                continue
            if filters.get('mode') and filters['mode'] != (m.get('definition') or {}).get('mode'):
                continue
            if filters.get('status') and filters['status'] != m['status']:
                continue
            if kind == 'conversation' and not scope.get('shortcut') and filters.get('agentId') and filters['agentId'] != m['agentId']:
                continue
            out.append(self.snapshot(kind, m['id'], scope)['meta'])
        return sorted(out, key=lambda m: m.get('createdAt') or '', reverse=True)

    def check_agents(self, ids):
        for agent_id in ids:
            if not self.agent_row(agent_id)['enabled']:
                raise ValueError(f'Agent 已停用：{self.display(agent_id)}')

    def create(self, kind, scope, agent_id=None, definition=None, ident=None, parent_id=None):
        owner = scoped(scope)
        agent_id = definition['agents'][0] if definition else agent_id
        if not agent_id:
            raise ValueError('缺少 agentId')
        self.check_agents(definition['agents'] if definition else [agent_id])
        ident = ident or uid()
        meta = dict(id=ident, title=definition['name'] if definition else '未命名会话', status='idle', runId=None,
            agentId=agent_id, source=(scope.get('shortcut') or {}).get('shortcut_key', ''), creator='本地用户', round=0,
            capabilities={k: False for k in CAPS}, checkpoints=[], parentId=parent_id, createdAt=now(), archived=False)
        if definition:
            meta['definition'] = definition
        row = dict(kind=kind, scope=owner, scopeObject=scope, snapshot=dict(seq=0, meta=meta, messages=[], activities=[], queue=[], report=None))
        self.db.put('resource', self.key(kind, ident), row)
        return self.snapshot(kind, ident, scope)['meta']

    def update_simulation(self, ident, scope, definition):
        row = self.get('simulation', ident, scope)
        if not self.capabilities(row, scope)['edit']:
            raise ValueError('运行中的任务不可编辑')
        self.check_agents(definition['agents'])
        return self.meta(self.key('simulation', ident), title=definition['name'], definition=definition,
                         agentId=definition['agents'][0])['value']

    def emit(self, key, kind, value):
        row = self.db.get('resource', key)
        s = row['snapshot']
        s['seq'] += 1
        if kind in ('message', 'activity', 'queue'):
            field = {'message': 'messages', 'activity': 'activities', 'queue': 'queue'}[kind]
            s[field] = sorted([v for v in s[field] if v['id'] != value['id']] + [value], key=lambda v: v['order'])
        else:
            s[kind] = value
        if kind == 'meta':
            s['meta']['capabilities'] = self.capabilities(row, row['scopeObject'])
            value = deepcopy(s['meta'])
        self.db.put('resource', key, row)
        event = dict(seq=s['seq'], kind=kind, value=deepcopy(value))
        for queue in self.listeners.get(key, set()):
            queue.put_nowait(event)
        return event

    def seed_branch_history(self, parent_session, child_session, messages):
        """Give a branch the model-side history up to the fork point, so the next send in the branch
        continues the conversation instead of starting blank (the engine forks run state, not session history).
        给分支写入截至分叉点的模型侧历史；引擎分叉的是运行状态而非会话历史，否则分支里再发消息会“失忆”。"""
        parent = [(json.loads(k), v) for k, v in self.db.items('history') if json.loads(k)[1] == parent_session]
        if not parent:
            return
        (scope_id, _), history = parent[0]
        system = [h for h in history if h.get('role') == 'system']
        turns = [{'role': x['role'], 'content': x['text']} for x in messages
                 if x.get('kind') == 'chat' and x['role'] in ('user', 'assistant') and x.get('text')]
        self.db.put('history', json.dumps([scope_id, child_session]), system + turns)
    def descendants(self, key):
        """All fork descendants of a conversation (any depth). / 会话的所有分叉后代。"""
        rows = [(k, r) for k, r in self.db.items('resource') if r['kind'] == 'conversation']
        out, frontier = [], [key.split(':', 1)[1]]
        while frontier:
            parent = frontier.pop()
            for k, r in rows:
                if r['snapshot']['meta'].get('parentId') == parent and k not in out:
                    out.append(k)
                    frontier.append(r['snapshot']['meta']['id'])
        return out
    def meta(self, key, **changes):
        m = self.db.get('resource', key)['snapshot']['meta']
        m.update(changes)
        return self.emit(key, 'meta', m)

    def message(self, key, text, actor, role='assistant', kind='chat', ident=None, **fields):
        s = self.db.get('resource', key)['snapshot']
        message_id = ident or uid()
        old = next((m for m in s['messages'] if m['id'] == message_id), None)
        m = dict(id=message_id, order=old['order'] if old else s['seq']+1, actor=actor, role=role, kind=kind, text=text,
                 createdAt=old['createdAt'] if old else now(), **{k: v for k, v in fields.items() if v is not None})
        return self.emit(key, 'message', m)

    # ---------- attachments ----------
    def upload(self, kind, ident, scope, filename, content_type, content):
        row = self.get(kind, ident, scope)
        if not self.capabilities(row, scope)['upload']:
            raise ValueError('动作不可用: upload')
        if len(content) > MAX_ATTACHMENT:
            raise ValueError('附件不能超过 20 MB')
        name = safe_filename(filename, 'attachment')
        att_id = uid()
        folder = self.data / 'attachments'
        folder.mkdir(parents=True, exist_ok=True)
        ext = suffix(name)
        (folder / f'{att_id}{ext}').write_bytes(content)
        public = dict(id=att_id, name=name, url=f'/api/attachments/{att_id}',
                      contentType=(content_type or 'application/octet-stream').split(';')[0].strip().lower(), size=len(content))
        self.db.put('attachment', att_id, {**public, 'owner': self.key(kind, ident), 'ext': ext})
        return public

    def attachment(self, att_id):
        row = self.db.get('attachment', att_id)
        if row is None:
            raise NotFound('附件不存在')
        return row, self.data / 'attachments' / f"{att_id}{row['ext']}"

    def owned_attachments(self, key, items):
        out = []
        for item in items:
            row = self.db.get('attachment', str(item.get('id', ''))) if isinstance(item, dict) else None
            if row is None or row['owner'] != key:
                raise ValueError('附件不存在或不属于该会话')
            out.append({k: row[k] for k in ('id', 'name', 'url', 'contentType', 'size')})
        return out

    def content_parts(self, text, attachments):
        parts = [{'type': 'text', 'text': text}]
        for att in attachments:
            row, path = self.attachment(att['id'])
            data = path.read_bytes()
            ctype = row['contentType']
            if ctype in IMAGE_TYPES:
                parts.append({'type': 'image_base64', 'data': base64.b64encode(data).decode(), 'media_type': ctype})
            elif ctype.startswith('text/') or ctype in TEXT_TYPES or row['ext'] in TEXT_EXTENSIONS:
                body = data.decode('utf-8', errors='replace')
                cut = '\n…（已截断）' if len(body) > MAX_ATTACHMENT_TEXT else ''
                parts.append({'type': 'text', 'text': f"附件 {row['name']}：\n```\n{body[:MAX_ATTACHMENT_TEXT]}{cut}\n```"})
            else:
                parts.append({'type': 'text', 'text': f"[附件 {row['name']}（{ctype}，{row['size']} 字节）无法以文本读取]"})
        return parts

    # ---------- commands ----------
    async def command(self, kind, ident, scope, command):
        key = self.key(kind, ident)
        lock = self.locks.setdefault(key, asyncio.Lock())
        async with lock:
            row = self.get(kind, ident, scope)
            action = command['type']
            request_id = command.get('requestId')
            receipt_key = json.dumps([key, request_id])
            if request_id and (saved := self.db.get('receipt', receipt_key)):
                return saved
            cap = {'generateReport': 'report', 'unarchive': 'archive'}.get(action, action)
            if action == 'send':
                cap = command['mode']
            if not self.capabilities(row, scope).get(cap):
                raise ValueError(f'动作不可用: {action}')
            result = await self.execute(key, row, scope, command)
            if request_id:
                self.db.put('receipt', receipt_key, result)
            return result

    async def execute(self, key, row, scope, c):
        action = c['type']
        m = row['snapshot']['meta']
        if action == 'send':
            text = c['text'].strip()
            if not text:
                raise ValueError('消息不能为空')
            attachments = self.owned_attachments(key, c.get('attachments') or [])
            if m['status'] == 'running':
                if attachments:
                    raise ValueError('运行中插入的消息暂不支持附件')
                await (await self.agent(m['agentId'])).send_message(m['runId'], text, session_id=m['id'], message_id=c['requestId'])
                self.emit(key, 'queue', dict(id=c['requestId'], order=row['snapshot']['seq']+1, text=text, status='accepted'))
            else:
                await self.agent(m['agentId'])
                run = uid()
                changes = dict(status='running', runId=run)
                if not row['snapshot']['messages']:
                    changes['title'] = text[:40]
                self.meta(key, **changes)
                self.tasks[key] = asyncio.create_task(self.run_chat(key, text, run, attachments))
            return {'events': [self.message(key, text, '你', 'user', ident=c['requestId'], attachments=attachments or None)]}
        if action == 'stop':
            if row['kind'] == 'conversation':
                if not self.engine.cancel_run(m['runId']):
                    raise ValueError('运行尚未就绪或已结束，请刷新后重试')
            else:
                self.tasks[key].cancel()
                await asyncio.gather(self.tasks[key], return_exceptions=True)
                # Cancellation before coroutine entry cannot execute its exception handler.
                if self.db.get('resource', key)['snapshot']['meta']['status'] in ('running', 'paused'):
                    self.meta(key, status='cancelled')
            return {}
        if action == 'resume':
            if row['kind'] == 'conversation':
                await self.agent(m['agentId'])
                self.meta(key, status='running')
                self.tasks[key] = asyncio.create_task(self.run_chat(key, None, m['runId']))
            else:
                self.gates[key].set()
                self.meta(key, status='running')
            return {}
        if action == 'fork':
            # Every send is its own run; fork from the run that owns the chosen checkpoint, not only the latest.
            # 每次发送都是一次独立运行；按切点所属的运行分叉，而不只是最近一次。
            saved = self.db.get('checkpoint', c['checkpointId'])
            if saved is None or c['checkpointId'] not in {cp['id'] for cp in m['checkpoints']}:
                raise ValueError('分叉点不存在')
            child = await (await self.agent(m['agentId'])).fork_run(saved['run_id'], c['checkpointId'])
            self.create('conversation', row['scopeObject'], m['agentId'], ident=child.session_id, parent_id=m['id'])
            child_key = self.key('conversation', child.session_id)
            cut = self.db.get('cut', c['checkpointId'])
            if cut:
                child_row = self.db.get('resource', child_key)
                child_row['snapshot']['messages'] = cut['messages']
                self.db.put('resource', child_key, child_row)
            self.seed_branch_history(m['id'], child.session_id, cut['messages'] if cut else [])
            self.meta(child_key, status='cancelled', runId=child.run_id, title=m['title']+' · 分支')
            return {'resource': {'kind': 'conversation', 'scope': row['scopeObject'], 'id': child.session_id}}
        if action in ('archive', 'unarchive'):
            # Branches follow their parent so the fork tree stays intact in both views. / 分支随父会话一起归档或恢复。
            flag = action == 'archive'
            own = self.meta(key, archived=flag, archivedAt=now() if flag else None)
            for child_key in self.descendants(key):
                child = self.db.get('resource', child_key)['snapshot']['meta']
                if bool(child.get('archived')) != flag and child['status'] not in ('running', 'paused'):
                    self.meta(child_key, archived=flag, archivedAt=now() if flag else None)
            return {'events': [own]}
        if action == 'delete':
            self.db.remove('resource', key)
            for att_key, att in self.db.items('attachment'):
                if att['owner'] == key:
                    self.db.remove('attachment', att_key)
                    (self.data / 'attachments' / f"{att_key}{att['ext']}").unlink(missing_ok=True)
            return {}
        if action == 'start':
            for agent_id in m['definition']['agents']:
                await self.agent(agent_id)
            self.gates[key] = asyncio.Event()
            self.gates[key].set()
            self.meta(key, status='running', runId=uid())
            self.tasks[key] = asyncio.create_task(self.run_simulation(key))
            return {}
        if action == 'pause':
            self.gates[key].clear()
            return {'events': [self.meta(key, status='paused')]}
        if action == 'interview':
            d = m['definition']
            if c['target'] != 'all' and c['target'] not in d['agents']:
                raise ValueError('采访对象不属于任务')
            if not c['question'].strip():
                raise ValueError('采访问题不能为空')
            targets = d['agents'] if c['target'] == 'all' else [c['target']]
            answers = []
            for target in targets:
                agent = await self.agent(target)
                answer = await agent.chat(f"任务目标：{d['objective']}\n采访问题：{c['question']}", session_id=f"interview:{m['id']}:{target}")
                answers.append(f'{self.display(target)}: {answer}')
            event = self.message(key, '\n\n'.join(answers), '采访', kind='interview', ident=c['requestId'], target=c['target'], question=c['question'])
            return {'events': [event]}
        if action == 'generateReport':
            content = render_report(m, row['snapshot']['messages'], self.display)
            return {'events': [self.emit(key, 'report', content)]}
        raise ValueError('未知命令')

    async def run_chat(self, key, text, run, attachments=()):
        row = self.db.get('resource', key)
        m = row['snapshot']['meta']
        actor = self.display(m['agentId'])
        reply = _Reply(self, key, actor)
        try:
            agent = await self.agent(m['agentId'])
            if text is None:
                stream = agent.resume_stream(run)
            elif attachments:
                stream = agent.stream_with_messages([{'role': 'user', 'content': self.content_parts(text, attachments)}],
                                                    session_id=m['id'], metadata={'run_id': run})
            else:
                stream = agent.stream(text, session_id=m['id'], metadata={'run_id': run})
            async for event in stream:
                typ = event.type.value
                if reply.handle(event, typ):
                    pass
                elif typ in ('done', 'cancelled', 'error'):
                    reply.flush()
                    self.meta(key, status={'done': 'completed', 'cancelled': 'cancelled', 'error': 'failed'}[typ])
                    if typ == 'error':
                        self.activity(key, event, 'error', uid(), 'failed')
                elif typ in ('plan_created', 'step_start', 'step_completed', 'state_change'):
                    kind = 'step' if typ.startswith('step_') else 'plan' if typ == 'plan_created' else 'round'
                    stable = f'{run}:step:{event.step_id}' if event.step_id else f'{run}:{typ}'
                    self.activity(key, event, kind, stable, 'completed' if typ == 'step_completed' else typ)
                for request in event.metadata.get('processed_message_ids', []):
                    current = self.db.get('resource', key)['snapshot']
                    queued = next((q for q in current['queue'] if q['id'] == request), None)
                    if queued:
                        self.emit(key, 'queue', {**queued, 'status': 'done'})
                if typ not in ('stream_delta', 'thinking_delta', 'tool_args_preview'):
                    await self.sync_checkpoints(key, run)
            await self.sync_checkpoints(key, run, final=True)
        except asyncio.CancelledError:
            self.meta(key, status='interrupted')
            raise
        except Exception as exc:
            reply.flush()
            self.meta(key, status='failed')
            self.message(key, str(exc), '运行错误', 'system', 'phase')

    async def sync_checkpoints(self, key, run, final=False):
        """Record forkable cuts with the transcript and the reply they end on.
        Mid-run cuts are seen before the reply finishes, so at the end of a run the latest cut is re-anchored
        to the finished assistant reply: every reply then offers 「从这里分叉」.
        记录切点及其对应的回复；运行结束时把最后一个切点绑定到刚完成的助手回复，使每条回复都能分叉。"""
        cuts = [cp for cp in await self.checkpoints.list(run) if cp.forkable]
        listed = []
        for i, cp in enumerate(cuts):
            cut = self.db.get('cut', cp.id)
            if final and i == len(cuts) - 1:
                snapshot = self.db.get('resource', key)['snapshot']
                messages = [msg for msg in snapshot['messages'] if not msg.get('streaming')]
                replies = [msg for msg in messages if msg['role'] == 'assistant' and msg.get('kind') == 'chat']
                if replies:
                    cut = {'messages': messages, 'messageId': replies[-1]['id']}
                    self.db.put('cut', cp.id, cut)
            if cut is None:
                snapshot = self.db.get('resource', key)['snapshot']
                messages = [msg for msg in snapshot['messages'] if not msg.get('streaming')]
                cut = {'messages': messages, 'messageId': messages[-1]['id'] if messages else None}
                self.db.put('cut', cp.id, cut)
            item = dict(id=cp.id, label=f'{cp.sequence} · {cp.kind}')
            if cut.get('messageId'):
                item['messageId'] = cut['messageId']
            listed.append(item)
        meta = self.db.get('resource', key)['snapshot']['meta']
        previous = [c for c in meta['checkpoints'] if c['id'] not in {i['id'] for i in listed}]
        if previous + listed != meta['checkpoints']:
            self.meta(key, checkpoints=previous + listed)

    def activity(self, key, event, kind, ident, status):
        s = self.db.get('resource', key)['snapshot']
        old = next((a for a in s['activities'] if a['id'] == ident), None)
        self.emit(key, 'activity', dict(id=ident, order=old['order'] if old else s['seq']+1, kind=kind,
            title=event.tool_name or event.content[:80] or event.type.value, status=status,
            detail=json.dumps({'content': event.content, 'steps': event.steps, 'arguments': event.arguments, 'metadata': event.metadata}, ensure_ascii=False, default=str)))

    async def run_simulation(self, key):
        row = self.db.get('resource', key)
        m, d = row['snapshot']['meta'], row['snapshot']['meta']['definition']
        try:
            agents = [await self.agent(agent_id) for agent_id in d['agents']]
            if d['mode'] in ('group_chat', 'supervisor'):
                session = MultiAgentSession(agents=agents[1:] if d['mode'] == 'supervisor' else agents, dispatcher=self.dispatcher,
                    mode=SessionMode(d['mode']), topic=f"{d['topic']}\n目标：{d['objective']}\n{d['background']}\n{d['persona']}",
                    max_rounds=d['maxRounds'], supervisor=agents[0] if d['mode'] == 'supervisor' else None)
                async for event in session.stream():
                    await self.gates[key].wait()
                    typ = str(event.type)
                    self.meta(key, round=event.round_num)
                    if typ == 'message':
                        self.message(key, event.content, self.display(event.agent_name))
                    elif typ in ('round_start', 'round_end', 'system'):
                        self.message(key, event.content or typ, '系统阶段', 'system', 'phase')
                    elif typ == 'error':
                        raise RuntimeError(event.content)
                    elif typ == 'done':
                        self.meta(key, status='completed')
            else:
                adapter = SIMULATION_MODE_ADAPTERS[d['mode']]
                profiles = [AgentProfile(name=a.name, role=d['persona'] or adapter.default_agents[i % len(adapter.default_agents)].role) for i, a in enumerate(agents)]
                background = d['background'] + (f"\n红方目标：{d['redObjective']}\n蓝方目标：{d['blueObjective']}" if d['mode'] == 'redblue' else '')
                scenario = adapter.build_scenario(d['topic'], d['objective'], id=m['id'], max_steps=d['maxSteps'], background=background, agents=profiles)
                runner = adapter.build_runner({a.name: AgentPolicyAdapter(a, session_id=f"simulation:{m['id']}:{a.name}") for a in agents})
                async for event in runner.stream(scenario):
                    await self.gates[key].wait()
                    typ = str(event.type)
                    if typ == 'error':
                        raise RuntimeError(event.content)
                    if event.step is not None:
                        self.meta(key, round=event.step.step_id)
                        if typ == 'step_completed':
                            self.message(key, event.step.action.intent, self.display(event.step.actor))
                    else:
                        self.message(key, event.content or typ, '系统阶段', 'system', 'phase')
                    if typ == 'done':
                        self.meta(key, status='completed')
        except asyncio.CancelledError:
            self.meta(key, status='cancelled')
            raise
        except Exception as exc:
            self.meta(key, status='failed')
            self.message(key, str(exc), '运行错误', 'system', 'phase')

    async def close(self):
        tasks = [*self.tasks.values(), *self.evals.tasks.values()]
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.bus.close()
        await self.dispatcher.stop_all()
        for agent_id in list(self.agents_svc.cache):
            await self.agents_svc.unload(self.engine, agent_id)
        await self.engine.close()
        if self.model is not None:
            await self.model.close()
        self.db.close()


class _Reply:
    """Folds one run's stream events into a single assistant message with parts. / 把一次运行归并为一条助手消息。"""

    def __init__(self, host, key, actor):
        self.host, self.key, self.actor = host, key, actor
        self.id = uid()
        self.parts = []
        self.counter = 0
        self.text_part = None
        self.thinking_part = None
        self.agent_parts = {}

    def _part(self, kind, text='', **extra):
        self.counter += 1
        part = dict(id=f'{self.id}:{kind}:{self.counter}', kind=kind, text=text, **extra)
        self.parts.append(part)
        return part

    def handle(self, event, typ):
        if typ == 'stream_start':
            self.text_part = None
        elif typ == 'stream_delta':
            if self.text_part is None:
                self.text_part = self._part('text')
            self.text_part['text'] += event.content
            self.emit(True)
        elif typ == 'stream_end':
            self.text_part = None
            self.emit(True)
        elif typ == 'thinking_start':
            self.thinking_part = self._part('thinking', status='running')
            self.emit(True)
        elif typ == 'thinking_delta':
            if self.thinking_part is None:
                self.thinking_part = self._part('thinking', status='running')
            self.thinking_part['text'] += event.content
            self.emit(True)
        elif typ == 'thinking_end':
            if self.thinking_part is not None:
                self.thinking_part['status'] = 'completed'
                self.thinking_part = None
            self.emit(True)
        elif typ == 'tool_call':
            part = self._part('tool', json.dumps(event.arguments, ensure_ascii=False, default=str),
                              title=event.tool_name, status='running')
            if event.tool_call_id:
                part['id'] = f'{self.id}:tool:{event.tool_call_id}'
            self.text_part = None
            self.emit(True)
        elif typ == 'tool_result':
            ident = f'{self.id}:tool:{event.tool_call_id}'
            part = next((p for p in self.parts if p['id'] == ident), None) or self._part('tool', title=event.tool_name)
            part['text'] = event.content if isinstance(event.content, str) else json.dumps(event.content, ensure_ascii=False, default=str)
            part['status'] = 'failed' if event.metadata.get('is_error') or event.metadata.get('error') else 'completed'
            self.emit(True)
        elif typ == 'sub_agent_start':
            name = str(event.metadata.get('agent_name') or event.tool_name or '子 Agent')
            self.agent_parts[name] = self._part('agent', event.content, title=self.host.display(name), status='running')
            self.emit(True)
        elif typ == 'sub_agent_complete':
            name = str(event.metadata.get('agent_name') or event.tool_name or '子 Agent')
            part = self.agent_parts.pop(name, None) or self._part('agent', title=self.host.display(name))
            part['text'] = event.content or part['text']
            part['status'] = 'failed' if event.metadata.get('error') else 'completed'
            self.emit(True)
        else:
            return False
        return True

    def emit(self, streaming):
        if not self.parts:
            return
        text = '\n\n'.join(p['text'] for p in self.parts if p['kind'] == 'text' and p['text'])
        self.host.message(self.key, text, self.actor, ident=self.id, streaming=streaming, parts=deepcopy(self.parts))

    def flush(self):
        for part in self.parts:
            if part.get('status') == 'running':
                part['status'] = 'completed'
        self.emit(False)


STATUS_ZH = {'idle': '未开始', 'running': '运行中', 'paused': '已暂停', 'completed': '已完成', 'cancelled': '已取消', 'failed': '失败'}


def render_report(meta, messages, display):
    """Readable Markdown report: rounds of speeches, then interviews. Engine phase markers become headings only.
    可读的 Markdown 报告：按轮次整理发言，最后附采访；引擎阶段标记只用作分节。"""
    d = meta['definition']
    names = '、'.join(display(a) for a in d['agents'])
    lines = [f"# {meta['title']}", '', f"- 目标：{d['objective']}"]
    if d.get('topic') and d['topic'] != d['objective']:
        lines.append(f"- 议题：{d['topic']}")
    lines += [f"- 参与者：{names}", f"- 状态：{STATUS_ZH.get(meta['status'], meta['status'])}，共 {meta.get('round') or 0} 轮", '']
    rounds, interviews, current = [], [], None
    for v in messages:
        if v['kind'] == 'interview':
            interviews.append(v)
        elif v['kind'] == 'phase':
            if v['text'].strip() == 'round_start':
                current = []
                rounds.append(current)
            elif v['actor'] == '运行错误':
                if current is None:
                    current = []
                    rounds.append(current)
                current.append(v)
        else:
            if current is None:
                current = []
                rounds.append(current)
            current.append(v)
    for i, items in enumerate(rounds, 1):
        if not items:
            continue
        lines += [f'## 第 {i} 轮' if len(rounds) > 1 else '## 过程', '']
        for v in items:
            lines += [f"**{v['actor']}**", '', v['text'].strip(), '']
    if interviews:
        lines += ['## 采访', '']
        for v in interviews:
            who = '全体参与者' if v.get('target') == 'all' else display(v.get('target') or '')
            lines += [f"### 问 {who}：{v.get('question', '')}", '', v['text'].strip(), '']
    return '\n'.join(lines).rstrip() + '\n'
