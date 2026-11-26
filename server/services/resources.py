"""Single-user local host: resources, commands, durable state, engine execution. / 本地单用户宿主。

``HostService`` owns the engine, the database and every management service; conversations and
simulations follow the resource + snapshot + SSE event protocol in ``src/core.ts``.
"""
import asyncio
import base64
from contextlib import AsyncExitStack
from copy import deepcopy
import json
import logging
from pathlib import Path
import time
from axc_agent_engine import Engine
from axc_agent_engine.core.dispatcher import AgentMessageDispatcher
from axc_agent_engine.storage.in_memory import InMemoryMessageBus
from axc_agent_engine.sidecar.multi_agent import MultiAgentSession, SessionMode
from axc_agent_engine.sidecar.simulation import SIMULATION_MODE_ADAPTERS, AgentPolicyAdapter, AgentProfile
from ..crypto import SecretBox
from ..db import Checkpoints, Database, KVStore, Messages
from ..models import LocalScope, configured_model
from .agents import AgentService, build_registry, plugin_catalog
from .analytics import AnalyticsService
from .common import NotFound, now, safe_filename, suffix, uid
from .evals import EvalService
from .graphs import GraphServiceHost
from .interaction import PromptChannel, expire_pending
from .knowledge import KnowledgeService
from .mcp import McpService
from .memories import MemoryService
from .migrations import migrate
from .providers import ProviderService
from .runs import RunLog, ToolFailures
from .sessions import SessionsService, new_conversation_fields
from .turns import Turn
from .seed import seed as seed_demo
from .skills import SkillService

CAPS = ('send insert enqueue priority cancelRequest stop resume delete archive upload fork start pause interview '
        'report edit respond editMessage wake grants').split()
MAX_ATTACHMENT = 20 * 1024 * 1024
MAX_ATTACHMENT_TEXT = 100_000
TEXT_TYPES = ('application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/toml',
              'application/javascript')
TEXT_EXTENSIONS = {'.txt', '.md', '.markdown', '.rst', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml',
                   '.xml', '.html', '.htm', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c',
                   '.h', '.cpp', '.sh', '.sql', '.log', '.ini', '.cfg'}
IMAGE_TYPES = ('image/png', 'image/jpeg', 'image/gif', 'image/webp')
HALT_TIMEOUT = 10  # Seconds to wait for a cancelled run to settle during edit. / 编辑时等待被停止运行结束的秒数。
logger = logging.getLogger(__name__)




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
        migrate(self.db)
        self.checkpoints = Checkpoints(self.db)
        self.registry = build_registry()
        self.kv = KVStore(self.db)
        self.tool_failures = ToolFailures()
        self.engine = Engine(plugin_registry=self.registry, checkpoint_store=self.checkpoints,
                             message_persistence=Messages(self.db), kv_store=self.kv, audit_sink=self.tool_failures)
        # Shared model override (tests / fixture mode); None resolves each agent's providers.
        # 共享模型覆盖（测试或 fixture 模式）；None 表示按 Agent 解析提供商。
        self.model = model if model is not None else configured_model()
        secrets = SecretBox(self.data)
        self.providers = ProviderService(self.db, secrets)
        self.skills = SkillService(self.db, self.data)
        self.knowledge = KnowledgeService(self.db, self.data, self.providers)
        self.graphs = GraphServiceHost(self.db)
        self.mcp = McpService(self.db, secrets)
        self.runs = RunLog(self.db)
        self.sessions = SessionsService(self)
        self.agents_svc = AgentService(self.db, self.data, self.registry, self.providers, self.skills,
                                       self.knowledge, self.graphs, self.mcp, self.runs)
        self.agents_svc.sessions = self.sessions
        self.evals = EvalService(self.db, self.agents_svc)
        self.analytics = AnalyticsService(self.runs, self.providers)
        self.memories = MemoryService(self.kv)
        self.bus = InMemoryMessageBus()
        self.dispatcher = AgentMessageDispatcher(message_bus=self.bus)
        self.tasks = {}
        self.running: set[asyncio.Task] = set()  # Every run task, including displaced ones. / 含被顶替的运行任务。
        self.channels: dict[str, PromptChannel] = {}
        self.closing = False
        self.gates = {}
        self.listeners = {}
        self.locks = {}
        self.agent_lock = asyncio.Lock()
        for key, row in self.db.items('resource'):
            if row['snapshot']['meta']['status'] in ('running', 'paused'):
                row['snapshot']['meta']['status'] = 'interrupted' if row['kind'] == 'conversation' else 'failed'
                row['snapshot']['seq'] += 1
                self.db.put('resource', key, row)
            self.clear_streaming(key)
            expire_pending(self, key)
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

    async def forget(self, memory_id):
        """Delete a memory. The memory plugin caches records per scope, so an idle owning agent is unloaded to
        reload from storage; a busy one keeps its cache until its next rebuild.
        删除记忆；memory 插件按作用域缓存，空闲的所属 Agent 会被卸载以便重新加载。"""
        agent_id = await self.memories.delete(memory_id)
        if agent_id and not self.busy(agent_id):
            await self.unload_agent(agent_id)

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
        resumable = bool(m['runId']) and self.resumable(m['runId'])
        values = dict(send=chat and not running and not source_block, insert=chat and running and not source_block,
            stop=status in ('running', 'paused'), resume=(chat and resumable and not source_block and status in ('cancelled', 'interrupted')) or status == 'paused',
            # Conversations are archived first and only archived ones can be deleted. / 会话须先归档才能删除。
            delete=status not in ('running', 'paused') and (not chat or bool(m.get('archived'))),
            # Archiving is list management, allowed for any visible conversation that is not running.
            # 归档属于列表管理，任何可见且未运行的会话都可以归档。
            archive=chat and status not in ('running', 'paused'), fork=chat and not source_block and bool(m['checkpoints']),
            upload=chat and not source_block,
            start=not chat and status == 'idle', pause=not chat and running,
            interview=not chat, report=not chat, edit=not chat and status == 'idle',
            respond=any(p['status'] == 'pending' for p in row['snapshot']['prompts']),
            editMessage=chat and not source_block and not m.get('archived') and status not in ('running', 'paused'),
            wake=chat and not source_block and not running and any(x.get('held') for x in row['snapshot']['messages']),
            grants=chat)
        return {k: values.get(k, False) for k in CAPS}

    def resumable(self, run):
        """The run has a checkpoint and no write whose outcome is unknown; the engine refuses to resume those
        (a tool was cut off mid-write), so the user continues with a new message instead.
        有检查点且没有结果未知的写操作；引擎拒绝恢复这类运行（写操作被中途打断），用户改为发新消息继续。"""
        cps = [cp for _, cp in self.db.items('checkpoint') if cp['run_id'] == run]
        return bool(cps) and not max(cps, key=lambda cp: cp['sequence'])['state'].get('unsettled_writes')

    def snapshot(self, kind, ident, scope):
        row = self.get(kind, ident, scope)
        s = deepcopy(row['snapshot'])
        s['meta']['capabilities'] = self.capabilities(row, scope)
        self.decorate(row, s['meta'])
        return s

    def decorate(self, row, meta):
        """Derived, unstored meta fields. / 派生（不存储）的 meta 字段。"""
        if row['kind'] == 'conversation':
            agent = self.agents_svc.items.find(meta['agentId'])
            meta['maxWakeups'] = agent['runtime']['maxWakeups'] if agent else None

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
        meta.update(new_conversation_fields() if kind == 'conversation' else {})
        if definition:
            meta['definition'] = definition
        row = dict(kind=kind, scope=owner, scopeObject=scope, snapshot=dict(seq=0, meta=meta, messages=[], activities=[], queue=[], prompts=[], report=None))
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
        if kind in ('message', 'activity', 'queue', 'prompt'):
            field = {'message': 'messages', 'activity': 'activities', 'queue': 'queue', 'prompt': 'prompts'}[kind]
            s[field] = sorted([v for v in s[field] if v['id'] != value['id']] + [value], key=lambda v: v['order'])
        elif kind == 'remove':
            # value: {messages|activities|queue|prompts: [ids]} / 按 id 移除条目（编辑重发）。
            for field, ids in value.items():
                s[field] = [v for v in s[field] if v['id'] not in set(ids)]
        else:
            s[kind] = value
        if kind == 'meta':
            s['meta']['capabilities'] = self.capabilities(row, row['scopeObject'])
            value = deepcopy(s['meta'])
            self.decorate(row, value)
        self.db.put('resource', key, row)
        event = dict(seq=s['seq'], kind=kind, value=deepcopy(value))
        for queue in self.listeners.get(key, set()):
            queue.put_nowait(event)
        if kind == 'prompt':
            # capabilities.respond depends on pending prompts; publish the new value. / respond 能力随待处理提示变化，需同步 meta。
            self.emit(key, 'meta', s['meta'])
        return event

    def edit_scope(self, key, message_id):
        """W1.3: everything an edit of ``message_id`` deletes or archives. / 编辑的影响范围。"""
        s = self.db.get('resource', key)['snapshot']
        m = s['meta']
        target = next((x for x in s['messages'] if x['id'] == message_id), None)
        if target is None or target['role'] != 'user' or target['kind'] != 'chat' or not target.get('startsRun') \
                or not target.get('runId'):
            raise ValueError('这条消息不能编辑')
        deleted = [x for x in s['messages'] if x['order'] >= target['order']]
        deleted_ids = {x['id'] for x in deleted}
        runs = {target['runId']} | {x['runId'] for x in deleted if x.get('runId')}
        voided = {cp['id'] for cp in m['checkpoints']
                  if (saved := self.db.get('checkpoint', cp['id'])) and saved['run_id'] in runs}
        branches, sessions = [], []
        for k, r in self.db.items('resource'):
            if r['kind'] != 'conversation':
                continue
            cm = r['snapshot']['meta']
            if cm.get('parentId') == m['id']:
                fork = cm.get('forkCheckpointId')
                legacy = not fork and any(x['id'] in deleted_ids for x in r['snapshot']['messages'])
                if (fork and fork in voided) or legacy:
                    branches += [k, *[d for d in self.descendants(k) if d not in branches]]
            p = cm['provenance']
            if p['parentSessionId'] == m['id'] and p['parentRunId'] in runs:
                sessions += [k, *self.descendants(k)]
        sessions += self.created_by(sessions)
        later = {field: [v['id'] for v in s[field] if v['order'] >= target['order']]
                 for field in ('activities', 'queue', 'prompts')}
        return dict(target=target, messages=[x['id'] for x in deleted], runs=runs, checkpoints=voided,
                    branches=list(dict.fromkeys(branches)), sessions=list(dict.fromkeys(sessions)), later=later)

    def created_by(self, keys):
        """Sessions created by the given ones, at any depth, with their branches. / 这些会话新建出的会话（任意层）。"""
        rows = [(k, r['snapshot']['meta']) for k, r in self.db.items('resource') if r['kind'] == 'conversation']
        out, frontier = [], [k.split(':', 1)[1] for k in keys]
        while frontier:
            parent = frontier.pop()
            for k, cm in rows:
                if cm['provenance']['parentSessionId'] == parent and k not in out and k not in keys:
                    found = [k, *[d for d in self.descendants(k) if d not in out]]
                    out += found
                    frontier += [d.split(':', 1)[1] for d in found]
        return out

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
            cap = {'generateReport': 'report', 'unarchive': 'archive', 'editPreview': 'editMessage',
                   'listGrants': 'grants', 'revokeGrant': 'grants'}.get(action, action)
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
                self.emit(key, 'queue', dict(id=c['requestId'], order=row['snapshot']['seq'] + 1, text=text,
                                             status='accepted', runId=m['runId']))
                if m.get('autoWakeups'):
                    self.meta(key, autoWakeups=0)
                return {'events': [self.message(key, text, '你', 'user', ident=c['requestId'], runId=m['runId'])]}
            turn = Turn(personal=True, attachments=tuple(attachments), message=dict(ident=c['requestId']))
            return {'events': [(await self.start_turn(key, text, turn))['event']]}
        if action in ('wake', 'editPreview', 'editMessage', 'listGrants', 'revokeGrant'):
            return await self.session_command(key, m, c)
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
                self.spawn(key, self.run_chat(key, None, m['runId']))
            else:
                self.gates[key].set()
                self.meta(key, status='running')
            return {}
        if action == 'fork':
            return await self.fork(row, c['checkpointId'])
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
            self.spawn(key, self.run_simulation(key))
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
        if action == 'respond':
            prompt = next((p for p in row['snapshot']['prompts'] if p['id'] == c['promptId']), None)
            channel = self.channels.get(key)
            if prompt is None or prompt['status'] != 'pending' or channel is None:
                raise ValueError('该提示不存在或已处理')
            return {'events': [await channel.respond(prompt, c.get('approved'), c.get('answer'), c.get('choice'))]}
        if action == 'generateReport':
            content = render_report(m, row['snapshot']['messages'], self.display)
            return {'events': [self.emit(key, 'report', content)]}
        raise ValueError('未知命令')

    @staticmethod
    def engine_provenance(provenance):
        """The plugin reads only depth and chain. / 插件只识别 depth 与 chain。"""
        return {'depth': provenance['depth'], 'chain': list(provenance['chain'])}

    def grant_title(self, grant):
        if grant['targetType'] == 'agent':
            return self.display(grant['targetId'])
        row = self.db.get('resource', self.key('conversation', grant['targetId']))
        return row['snapshot']['meta']['title'] if row else grant['targetId']

    async def start_turn(self, key, text, turn):
        """Start a new run on an idle conversation; the caller holds the conversation lock.
        在空闲会话上开启新一轮；调用方持有会话锁。"""
        row = self.db.get('resource', key)
        s, m = row['snapshot'], row['snapshot']['meta']
        await self.agent(m['agentId'])
        run = uid()
        held = [x for x in s['messages'] if x.get('held')] if turn.personal else []
        parts = [x['text'] for x in held] + ([text] if text else [])
        if not parts:
            raise ValueError('消息不能为空')
        self.sessions.record_run(run, m['id'], turn.provenance or m['provenance'])
        changes = dict(status='running', runId=run)
        if turn.personal:
            changes['autoWakeups'] = 0
        if not s['messages'] and text and not turn.keep_title:
            changes['title'] = text[:40]
        self.meta(key, **changes)
        for x in held:
            self.emit(key, 'message', {**{k: v for k, v in x.items() if k != 'held'}, 'runId': run})
        event = None
        if text is not None:
            fields = {'ident': None, 'actor': '你', 'kind': 'chat', 'startsRun': True, **(turn.message or {})}
            event = self.message(key, text, fields.pop('actor'), 'user', fields.pop('kind'), ident=fields.pop('ident'),
                                 attachments=list(turn.attachments) or None, runId=run, **fields)
        origin = 'notice' if turn.origin == 'notice' else 'user'
        self.spawn(key, self.run_chat(key, '\n\n'.join(parts), run, turn.attachments, origin))
        return {'run': run, 'event': event}

    async def halt(self, key, quiet_for):
        """Stop a running conversation for edit without notifying ``quiet_for``; wait until it settles.
        为编辑停止运行中的会话，不通知 quiet_for，并等待它结束。"""
        m = self.db.get('resource', key)['snapshot']['meta']
        if m['status'] != 'running':
            return
        self.sessions.suppress(m['runId'], quiet_for)
        for _ in range(int(HALT_TIMEOUT / 0.05)):
            if self.db.get('resource', key)['snapshot']['meta']['status'] != 'running':
                return
            self.engine.cancel_run(m['runId'])
            await asyncio.sleep(0.05)
        raise RuntimeError(f'会话未能在 {HALT_TIMEOUT} 秒内停止：{m["title"]}')

    async def fork(self, row, checkpoint_id):
        """Branch a conversation at one stored cut. / 在一个切点开分支。"""
        m = row['snapshot']['meta']
        # Every send is its own run; fork from the run that owns the chosen checkpoint, not only the latest.
        # 每次发送都是一次独立运行；按切点所属的运行分叉，而不只是最近一次。
        saved = self.db.get('checkpoint', checkpoint_id)
        if saved is None or checkpoint_id not in {cp['id'] for cp in m['checkpoints']}:
            raise ValueError('分叉点不存在')
        # The engine writes the branch session history from the cut (3.3.0); provenance is the host's.
        # 引擎按切点写入分支会话历史；来源链由宿主注入。
        provenance = deepcopy(m['provenance'])
        child = await (await self.agent(m['agentId'])).fork_run(
            saved['run_id'], checkpoint_id, metadata={'session_provenance': self.engine_provenance(provenance)})
        self.create('conversation', row['scopeObject'], m['agentId'], ident=child.session_id, parent_id=m['id'])
        child_key = self.key('conversation', child.session_id)
        cut = self.db.get('cut', checkpoint_id)
        if cut:
            child_row = self.db.get('resource', child_key)
            child_row['snapshot']['messages'] = cut['messages']
            self.db.put('resource', child_key, child_row)
        self.sessions.record_run(child.run_id, child.session_id, provenance)
        self.meta(child_key, status='cancelled', runId=child.run_id, title=m['title']+' · 分支',
                  provenance=provenance, forkCheckpointId=checkpoint_id)
        return {'resource': {'kind': 'conversation', 'scope': row['scopeObject'], 'id': child.session_id}}

    async def session_command(self, key, m, c):
        """Edit-and-resend, wake-up and grant commands. / 编辑重发、继续与授权命令。"""
        action = c['type']
        if action == 'wake':
            await self.start_turn(key, None, Turn(personal=True))
            return {}
        if action == 'editPreview':
            scope = self.edit_scope(key, c['messageId'])
            return {'preview': {k: len(scope[k]) for k in ('messages', 'branches', 'sessions')}}
        if action == 'editMessage':
            return await self.edit_message(key, c)
        if action == 'listGrants':
            return {'grants': [{**g, 'targetTitle': self.grant_title(g)} for g in self.sessions.grants(m['id'])]}
        self.sessions.revoke_grant(m['id'], c['grantId'])
        return {}

    async def edit_message(self, key, c):
        """W1.4: delete the edited message and everything after it, archive affected branches and created
        sessions, rewind the engine session, then resend. / 编辑重发。"""
        m = self.db.get('resource', key)['snapshot']['meta']
        text = (c.get('text') or '').strip()
        if not text:
            raise ValueError('消息不能为空')
        attachments = self.owned_attachments(key, c.get('attachments') or [])
        scope = self.edit_scope(key, c['messageId'])
        agent = await self.agent(m['agentId'])
        if not await agent.can_rewind(m['id'], scope['target']['runId']):
            raise ValueError('这条消息产生于旧版本引擎，无法编辑')
        targets = [*scope['branches'], *scope['sessions']]
        edited = {'conversationId': m['id'], 'messageId': scope['target']['id']}
        # Hold every affected conversation's lock so nothing is sent to it between stop and archive; stop running
        # branches and created sessions without notifying this conversation (M3).
        # 持有所有受影响会话的锁，停止与归档之间不会被派发；停止运行中的分支与派生会话且不通知本会话。
        async with AsyncExitStack() as stack:
            for child_key in sorted(targets):
                await stack.enter_async_context(self.locks.setdefault(child_key, asyncio.Lock()))
            for child_key in targets:
                await self.halt(child_key, m['id'])
            await agent.rewind_session(m['id'], before_run_id=scope['target']['runId'])
            for child_key in targets:
                if not self.db.get('resource', child_key)['snapshot']['meta']['archived']:
                    self.meta(child_key, archived=True, archivedAt=now(), archivedReason='edited', editedFrom=edited)
        self.sessions.forget_runs(m['id'], scope['runs'])
        for cp in scope['checkpoints']:
            self.db.remove('cut', cp)
        self.emit(key, 'remove', {'messages': scope['messages'], **scope['later']})
        kept = [cp for cp in m['checkpoints'] if cp['id'] not in scope['checkpoints']]
        self.meta(key, checkpoints=kept, autoWakeups=0)
        turn = Turn(personal=True, attachments=tuple(attachments), message=dict(ident=c.get('requestId')))
        return {'events': [(await self.start_turn(key, text, turn))['event']]}

    async def run_chat(self, key, text, run, attachments=(), origin='user'):
        row = self.db.get('resource', key)
        m = row['snapshot']['meta']
        agent_row = self.agent_row(m['agentId'])
        actor = self.display(m['agentId'])
        reply = _Reply(self, key, actor, run)
        # runtime.humanInTheLoop hands the engine approval queues; runtime.sessionOperations only needs host prompts.
        # 人工交互开关决定是否把审批队列交给引擎；会话操作开关只需要宿主提示通道。
        hitl = agent_row['runtime']['humanInTheLoop']
        sessions_on = agent_row['runtime']['sessionOperations']
        channel = self.channels[key] = PromptChannel(self, key, run) if hitl or sessions_on else None
        options = channel.run_options() if channel and hitl else None
        metadata = self.run_metadata(m, run, origin)
        settled_status = None  # Terminal status once the run settled. / 运行结束后的终态。
        task = text if text is not None else next(
            (x['text'] for x in reversed(row['snapshot']['messages']) if x['role'] == 'user'), '')
        record = dict(id=run, agentId=m['agentId'], conversationId=m['id'], task=task, success=False, error='',
                      toolCalls=[], inputTokens=0, outputTokens=0, durationMs=0, model=agent_row['models']['main'] or '',
                      createdAt=now())
        started = time.monotonic()
        try:
            agent = await self.agent(m['agentId'])
            if text is None:
                stream = agent.resume_stream(run, run_options=options, metadata=metadata)
            elif attachments:
                stream = agent.stream_with_messages([{'role': 'user', 'content': self.content_parts(text, attachments)}],
                                                    session_id=m['id'], metadata=metadata, run_options=options)
            else:
                stream = agent.stream(text, session_id=m['id'], metadata=metadata, run_options=options)
            async for event in stream:
                typ = event.type.value
                tool_error = None
                if typ == 'cost_update':
                    # Cumulative for the run (core/llm_caller.py). / 本次运行的累计值。
                    record['inputTokens'] = event.metadata['input_tokens']
                    record['outputTokens'] = event.metadata['output_tokens']
                    reply.usage = {'inputTokens': record['inputTokens'], 'outputTokens': record['outputTokens']}
                elif typ == 'tool_result':
                    tool_error = self.tool_failures.pop(m['id'], event.tool_call_id)
                    record['toolCalls'].append(dict(name=event.tool_name, success=tool_error is None, error=tool_error or ''))
                if reply.handle(event, typ, tool_error):
                    pass
                elif typ in ('done', 'cancelled', 'error'):
                    settled_status = self.terminal(reply, record, event, typ)
                elif typ in ('plan_created', 'step_start', 'step_completed', 'state_change'):
                    kind = 'step' if typ.startswith('step_') else 'plan' if typ == 'plan_created' else 'round'
                    stable = f'{run}:step:{event.step_id}' if event.step_id else f'{run}:{typ}'
                    reply.activity(event, kind, stable, 'completed' if typ == 'step_completed' else typ)
                self.ack_queue(key, event)
                if typ not in ('stream_delta', 'thinking_delta', 'tool_args_preview'):
                    await self.sync_checkpoints(key, run)
            if settled_status:
                await self.mark_rewindable(key, run)
            await self.sync_checkpoints(key, run, final=True)
        except asyncio.CancelledError:
            if settled_status:
                # Cancelled during the tail: the run already finished; keep it and let startup notify.
                # 收尾阶段被取消：运行已结束，保留终态，由启动时补发通知。
                self.sessions.settle(run, settled_status)
            elif self.owns(key, run):
                self.meta(key, status='interrupted')
            raise
        except Exception as exc:
            settled_status = self.failed(reply, record, exc, settled_status)
        finally:
            if channel is not None:
                await channel.close()
                # A newer run may own the key by now. / 新运行此时可能已占用该键。
                if self.channels.get(key) is channel:
                    self.channels.pop(key, None)
            record['durationMs'] = int((time.monotonic() - started) * 1000)
            self.runs.record(record)
        if settled_status:
            await self.sessions.settled(m['id'], run, settled_status, self.closing)

    def run_metadata(self, m, run, origin):
        """Run metadata the sessions plugin reads (W3.4). / sessions 插件读取的运行 metadata。"""
        provenance = self.sessions.run_provenance(run)
        if not provenance:
            # A run started before 3.3.0 (resumed now) takes the conversation's provenance.
            # 3.3.0 之前开始、现在恢复的运行，取会话的来源链。
            provenance = m['provenance']
            self.sessions.record_run(run, m['id'], provenance)
        return {'run_id': run, 'session_title': m['title'], 'turn_origin': origin,
                'session_provenance': self.engine_provenance(provenance)}

    def terminal(self, reply, record, event, typ):
        """Apply a terminal engine event; return the settled status, or None when shutdown interrupted the run.
        处理终止事件；返回终态，关闭服务导致的中断返回 None。"""
        reply.flush()
        if self.closing and typ == 'cancelled':
            # Shutdown stops a run at the event boundary: interrupted, no notice. / 关闭服务时记为已中断，不通知。
            self.meta(reply.key, status='interrupted')
            record['error'] = '宿主关闭'
            return None
        self.meta(reply.key, status={'done': 'completed', 'cancelled': 'cancelled', 'error': 'failed'}[typ])
        record['success'] = typ == 'done'
        if typ == 'error':
            record['error'] = str(event.content)
            reply.activity(event, 'error', uid(), 'failed')
        return typ

    def failed(self, reply, record, exc, settled_status):
        """A host-side failure. After the run settled it keeps its terminal status, and a newer run's status is
        never overwritten (N2). 宿主侧失败：运行已结束时保留原终态，且不覆盖新一轮的状态。"""
        reply.flush()
        self.message(reply.key, str(exc), '运行错误', 'system', 'phase', runId=reply.run)
        record['error'] = str(exc)
        if settled_status is not None:
            return settled_status
        record['success'] = False
        if self.owns(reply.key, reply.run):
            self.meta(reply.key, status='failed')
        return 'error'

    def ack_queue(self, key, event):
        """Mark live inputs the engine consumed. / 标记引擎已处理的插话。"""
        for request in event.metadata.get('processed_message_ids', []):
            current = self.db.get('resource', key)['snapshot']
            queued = next((q for q in current['queue'] if q['id'] == request), None)
            if queued:
                self.emit(key, 'queue', {**queued, 'status': 'done'})

    async def mark_rewindable(self, key, run):
        """Flag the user message that started ``run`` as editable when the engine can rewind it.
        引擎能回退该轮时，把开启它的用户消息标记为可编辑。"""
        row = self.db.get('resource', key)
        if row is None:
            return
        starter = next((x for x in row['snapshot']['messages'] if x.get('runId') == run and x.get('startsRun')), None)
        if starter is None or starter.get('rewindable'):
            return
        agent = await self.agent(row['snapshot']['meta']['agentId'])
        if await agent.can_rewind(row['snapshot']['meta']['id'], run):
            self.emit(key, 'message', {**starter, 'rewindable': True})

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
                messages = self.run_view(self.db.get('resource', key)['snapshot'], run)
                replies = [msg for msg in messages if msg['role'] == 'assistant' and msg.get('kind') == 'chat']
                if replies:
                    cut = {'messages': messages, 'messageId': replies[-1]['id']}
                    self.db.put('cut', cp.id, cut)
            if cut is None:
                messages = self.run_view(self.db.get('resource', key)['snapshot'], run)
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

    @staticmethod
    def run_view(snapshot, run):
        """Committed messages up to and including ``run``; a newer run's messages are excluded (N1).
        截至本轮（含）的已提交消息，排除之后新一轮的消息。"""
        own = [x['order'] for x in snapshot['messages'] if x.get('runId') == run]
        start = min(own) if own else None
        return [x for x in snapshot['messages'] if not x.get('streaming')
                and (start is None or x['order'] < start or x.get('runId') == run)]

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

    async def recover(self):
        """Startup: deliver notices of runs that settled but were not notified (N5). / 启动时补发未投递的完成通知。"""
        await self.sessions.replay()

    def clear_streaming(self, key):
        """Nothing streams at startup: close stale streaming replies (N6). / 启动时关闭残留的流式回复。"""
        for m in self.db.get('resource', key)['snapshot']['messages']:
            if m.get('streaming'):
                parts = [{**p, 'status': 'interrupted'} if p.get('status') == 'running' else p
                         for p in m.get('parts', [])]
                self.emit(key, 'message', {**m, 'streaming': False, 'parts': parts} if 'parts' in m else
                          {**m, 'streaming': False})

    def spawn(self, key, coro):
        """Start and track a run task; a displaced task stays tracked until it ends (N3). / 启动并跟踪运行任务。"""
        task = asyncio.create_task(coro)
        self.tasks[key] = task
        self.running.add(task)
        task.add_done_callback(self._finished)
        return task

    def _finished(self, task):
        self.running.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.error('run task failed', exc_info=task.exception())

    def owns(self, key, run):
        """Whether ``run`` is still the conversation's current run. / run 是否仍是会话当前运行。"""
        row = self.db.get('resource', key)
        return row is not None and row['snapshot']['meta']['runId'] == run

    async def close(self):
        self.closing = True
        # Repeat until no run is left: a notice being delivered can still start one. / 直到没有运行任务为止。
        while tasks := [t for t in [*self.running, *self.evals.tasks.values()] if not t.done()]:
            for task in tasks:
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

    def __init__(self, host, key, actor, run=None):
        self.host, self.key, self.actor, self.run = host, key, actor, run
        self.id = uid()
        self.parts = []
        self.counter = 0
        self.text_part = None
        self.thinking_part = None
        self.agent_parts = {}
        self.usage = None

    def _part(self, kind, text='', **extra):
        self.counter += 1
        part = dict(id=f'{self.id}:{kind}:{self.counter}', kind=kind, text=text, **extra)
        self.parts.append(part)
        return part

    def handle(self, event, typ, tool_error=None):
        """``tool_error``: failure message of a ``tool_result`` (from the audit sink). / 工具失败信息。"""
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
            part['status'] = 'failed' if tool_error is not None else 'completed'
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

    def activity(self, event, kind, ident, status):
        """Upsert one progress item of this run. / 更新本轮的一条执行进度。"""
        s = self.host.db.get('resource', self.key)['snapshot']
        old = next((a for a in s['activities'] if a['id'] == ident), None)
        detail = {'content': event.content, 'steps': event.steps, 'arguments': event.arguments,
                  'metadata': event.metadata}
        self.host.emit(self.key, 'activity', dict(
            id=ident, order=old['order'] if old else s['seq'] + 1, kind=kind, runId=self.run,
            title=event.tool_name or event.content[:80] or event.type.value, status=status,
            detail=json.dumps(detail, ensure_ascii=False, default=str)))

    def emit(self, streaming):
        if not self.parts:
            return
        text = '\n\n'.join(p['text'] for p in self.parts if p['kind'] == 'text' and p['text'])
        self.host.message(self.key, text, self.actor, ident=self.id, streaming=streaming, parts=deepcopy(self.parts),
                          usage=self.usage, runId=self.run)

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
