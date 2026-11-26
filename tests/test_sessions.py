"""sessions plugin host (W3), edit-and-resend (W1) and branch provenance (W2) on the real engine with a scripted
model. / 会话操作宿主、编辑重发与分支来源链（真实引擎 + 脚本模型）。

Script model: a user turn containing ``#call <tool> <json>`` calls that tool once and then answers
``TOOL:<result>``; ``#hold`` keeps the turn streaming until ``release()``; anything else answers ``echo:<text>``.
"""
import asyncio
import json
import re
from axc_agent_engine import LLMStreamChunk
from axc_agent_engine.core.schema import LLMUsage
import pytest
import pytest_asyncio
from server.models import FixtureModel
from server.schemas import AgentInput
from server.services import sessions as sessions_mod
from server.services.resources import HostService
from server.services.interaction import PromptChannel, expire_pending
from server.services.sessions import NOTICE_ACTOR

pytestmark = pytest.mark.asyncio
SCOPE = {'key': 'local'}
TOPIC = {'key': 'topic:7', 'shortcut': {'shortcut_key': 'example.topic', 'context': {'topic_id': 7}}}


class Script(FixtureModel):
    def __init__(self):
        self.gate = asyncio.Event()
        self.calls = 0

    def release(self):
        self.gate.set()

    async def stream(self, messages, tools=None, **options):
        self.calls += 1
        last = next(m for m in reversed(messages) if m['role'] == 'user')
        text = last['content'] if isinstance(last['content'], str) else json.dumps(last['content'], ensure_ascii=False)
        after_tool = messages[-1]['role'] == 'tool'
        call = re.search(r'#call (\w+) (\{.*\})', text)
        if call and not after_tool:
            yield LLMStreamChunk(tool_call_delta={'index': 0, 'id': f'call_{self.calls}', 'type': 'function',
                                 'function': {'name': call.group(1), 'arguments': call.group(2)}},
                                 finish_reason='tool_calls')
            return
        if '#hold' in text and not after_tool:
            await self.gate.wait()
        reply = f"TOOL:{messages[-1]['content']}" if after_tool else f'echo:{text[-200:]}'
        yield LLMStreamChunk(content_delta=reply)
        yield LLMStreamChunk(usage=LLMUsage(input_tokens=1, output_tokens=1))


def agent(host, name, sessions=True, max_wakeups=10, **extra):
    """``extra``: grants (pre-authorizations), plugins (plugin settings). / 预先授权与插件设置。"""
    runtime = {'sessionOperations': sessions, 'maxWakeups': max_wakeups,
               'sessionGrants': list(extra.get('grants', ()))}
    plugins = extra.get('plugins', {})
    body = AgentInput.model_validate({'name': name, 'strategy': 'react', 'models': {}, 'plugins': plugins,
                                      'bindings': {'skills': [], 'knowledge': [], 'graph': None}, 'runtime': runtime})
    return host.agents_svc.save(body)['id']


@pytest_asyncio.fixture
async def host(tmp_path):
    h = HostService(tmp_path, Script(), db=str(tmp_path / 'host.db'))
    h.test_path = tmp_path
    yield h
    h.model.release()
    await h.close()


def snap(host, conv):
    return host.db.get('resource', f'conversation:{conv}')['snapshot']


async def until(fn, timeout=10):
    for _ in range(int(timeout / 0.02)):
        value = fn()
        if value:
            return value
        await asyncio.sleep(0.02)
    raise AssertionError('timeout')


async def settle(host, conv):
    await until(lambda: snap(host, conv)['meta']['status'] not in ('running', 'idle'))
    task = host.tasks.get(f'conversation:{conv}')
    if task:
        await asyncio.wait_for(asyncio.shield(task), 10)
    await asyncio.sleep(0.05)


async def say(host, conv, text, request=None, scope=SCOPE):
    body = dict(type='send', mode='send', requestId=request or f'r{text[:20]}{id(text)}', text=text, attachments=[])
    return await host.command('conversation', conv, scope, body)


def new(host, agent_id, scope=SCOPE):
    return host.create('conversation', scope, agent_id)['id']


def caller_of(host, conv):
    """Trusted caller dict for a conversation that is currently in a run. / 构造运行中会话的调用方。"""
    m = snap(host, conv)['meta']
    p = host.sessions.run_provenance(m['runId'])
    return {'session_id': conv, 'agent_name': m['agentId'], 'run_id': m['runId'], 'title': m['title'],
            'user_id': '', 'tenant_id': '', 'provenance': {'depth': p['depth'], 'chain': p['chain']},
            'turn_origin': 'user'}


async def running(host, conv, text='#hold 等待'):
    await say(host, conv, text)
    await until(lambda: snap(host, conv)['meta']['status'] == 'running')
    return caller_of(host, conv)


def pending(host, conv):
    return next((p for p in snap(host, conv)['prompts'] if p['status'] == 'pending'), None)


async def respond(host, conv, choice):
    prompt = await until(lambda: pending(host, conv))
    await host.command('conversation', conv, SCOPE, dict(type='respond', promptId=prompt['id'], choice=choice))
    return prompt


def tool_text(host, conv):
    replies = [x for x in snap(host, conv)['messages'] if x['role'] == 'assistant']
    return replies[-1]['text'] if replies else ''


# ---------- configuration ----------
async def test_render_mounts_plugin_and_capabilities(host):
    a = agent(host, '写周报')
    row = host.agents_svc.items.get(a)
    config = host.agents_svc.render(row, a, host.test_path)
    assert config['plugins']['sessions'] == {'enabled': True, 'max_wakeups': 10}
    assert {'session_read', 'session_operate'} <= set(config['runtime']['allowed_capabilities'])
    off = host.agents_svc.render(host.agents_svc.items.get(agent(host, '普通', sessions=False)), 'x', host.test_path)
    assert 'sessions' not in off['plugins'] and 'allowed_capabilities' not in off['runtime']
    instance = await host.agent(a)
    assert instance.registry.has('session_read') and instance.registry.has('session_create')


async def test_wake_limit_validation():
    for bad in (-1, 100001):
        with pytest.raises(ValueError):
            AgentInput.model_validate({'name': 'x', 'models': {}, 'plugins': {}, 'bindings': {},
                                       'runtime': {'maxWakeups': bad}})
    blank = {'name': 'x', 'models': {}, 'plugins': {}, 'bindings': {}, 'runtime': {}}
    runtime = AgentInput.model_validate(blank).runtime
    assert (runtime.max_rounds, runtime.max_wakeups) == (500, 100)  # engine 3.3.1 defaults / 引擎默认值
    with pytest.raises(ValueError):
        AgentInput.model_validate({'name': 'x', 'models': {}, 'plugins': {}, 'bindings': {},
                                   'runtime': {'maxRounds': 100001}})


async def test_engine_denies_session_tools_without_capabilities(host, monkeypatch):
    from server.services import agents as agents_mod
    monkeypatch.setitem(agents_mod.MANAGED_CAPABILITIES, 'sessions', [])
    a = agent(host, 'A')
    conv = new(host, a)
    await say(host, conv, '#call session_list {}')
    await settle(host, conv)
    text = tool_text(host, conv)
    assert 'session_read' in text and '个会话' not in text, text


# ---------- list / read ----------
async def test_list_and_read_end_to_end(host):
    a, b = agent(host, '写周报'), agent(host, '情报分析助手')
    target = new(host, b)
    await say(host, target, '客户访谈纪要：第三节价格')
    await settle(host, target)
    other_topic = new(host, b, TOPIC)
    conv = new(host, a)
    caller = await running(host, conv)
    rows = await host.sessions.list_sessions(caller, {'limit': 20})
    ids = {r.session_id: r for r in rows}
    assert target in ids and other_topic in ids and conv not in ids
    assert ids[other_topic].scope == 'topic:7' and ids[target].access == 'none'
    assert [r.session_id for r in await host.sessions.list_sessions(caller, {'limit': 20, 'agent_name': a})] == []
    host.model.release()
    await settle(host, conv)
    host.model.gate.clear()
    # The model reads B through the plugin: first use prompts for consent. / 首次读取弹授权。
    await say(host, conv, f'#call session_read {{"session_id": "{target}"}}')
    prompt = await respond(host, conv, 'session')
    assert prompt['kind'] == 'session_access' and prompt['level'] == 'read' and prompt['targetTitle']
    await settle(host, conv)
    assert '客户访谈纪要' in tool_text(host, conv)
    assert host.sessions.access(conv, host.db.get('resource', f'conversation:{target}')) == 'read'


async def test_read_returns_committed_text_only(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    target = new(host, b)
    for text in ('一', '二', '三'):
        await say(host, target, text, request=f'r-{text}')
        await settle(host, target)
    host.message(f'conversation:{target}', '阶段', '系统阶段', 'system', 'phase')
    conv = new(host, a)
    caller = await running(host, conv)
    rows = await host.sessions.read(caller, target, None, 50)
    assert [r.role for r in rows] == ['user', 'assistant'] * 3
    assert all('thinking' not in r.text and r.text for r in rows)
    since = await host.sessions.read(caller, target, rows[1].message_id, 2)
    assert [r.text for r in since] == [rows[-2].text, rows[-1].text]
    with pytest.raises(ValueError, match='消息不存在'):
        await host.sessions.read(caller, target, 'missing', 5)


# ---------- authorize ----------
async def test_authorize_scopes_cache_and_restart(host, tmp_path, monkeypatch):
    a, b = agent(host, 'A'), agent(host, 'B')
    t1, t2, t3 = new(host, b), new(host, b), new(host, b)
    conv = new(host, a)
    caller = await running(host, conv)
    s = host.sessions
    task = asyncio.create_task(s.authorize(caller, t1, 'read', True))
    await respond(host, conv, 'session')
    assert await task == 'granted'
    assert await s.authorize(caller, t1, 'read', True) == 'granted'  # cached, no prompt
    task = asyncio.create_task(s.authorize(caller, t2, 'operate', True))
    await respond(host, conv, 'agent')
    assert await task == 'granted'
    assert await s.authorize(caller, t3, 'operate', True) == 'granted'  # agent scope
    assert await s.authorize(caller, t3, 'read', True) == 'granted'  # operate includes read
    assert await s.authorize(caller, t1, 'read', False) == 'denied'  # cross_agent off / 不允许跨 Agent
    assert pending(host, conv) is None
    host.model.release()
    await settle(host, conv)
    await host.close()
    again = HostService(tmp_path, Script(), db=str(tmp_path / 'host.db'))
    try:
        assert {g['targetType'] for g in again.sessions.grants(conv)} == {'session', 'agent'}
        row = again.db.get('resource', f'conversation:{conv}')
        row['snapshot']['meta']['runId'] = 'live'
        again.db.put('resource', f'conversation:{conv}', row)
        again.sessions.record_run('live', conv, sessions_mod.default_provenance())
        restored = {**caller, 'run_id': 'live'}
        assert await again.sessions.authorize(restored, t1, 'read', True) == 'granted'
        assert await again.sessions.authorize(restored, t3, 'operate', True) == 'granted'
    finally:
        again.model.release()
        await again.close()
    host.close = lambda: asyncio.sleep(0)  # already closed / 已关闭


async def test_authorize_deny_timeout_unavailable_cross_agent(host, monkeypatch):
    a, b = agent(host, 'A'), agent(host, 'B')
    same, other, slow = new(host, a), new(host, b), new(host, b)
    conv = new(host, a)
    caller = await running(host, conv)
    s = host.sessions
    assert await s.authorize(caller, other, 'read', False) == 'denied'  # cross_agent off: no prompt
    assert pending(host, conv) is None and s.grants(conv) == []
    task = asyncio.create_task(s.authorize(caller, same, 'read', False))
    await respond(host, conv, 'deny')
    assert await task == 'denied'
    assert await s.authorize(caller, same, 'operate', True) == 'denied'  # denied read blocks operate
    monkeypatch.setattr(sessions_mod, 'ACCESS_TIMEOUT', 0.2)
    assert await s.authorize(caller, slow, 'read', True) == 'denied'
    assert [g['reason'] for g in s.grants(conv) if g['targetId'] == slow] == ['timeout']
    assert all(p['status'] != 'pending' for p in snap(host, conv)['prompts'])
    channel = host.channels.pop(f'conversation:{conv}')
    assert await s.authorize(caller, new(host, b), 'read', True) == 'unavailable'
    host.channels[f'conversation:{conv}'] = channel
    # Run end resolves an open consent prompt to unavailable. / 运行结束时未答提示为 unavailable。
    task = asyncio.create_task(s.authorize(caller, new(host, b), 'read', True))
    await until(lambda: pending(host, conv))
    host.model.release()
    assert await task == 'unavailable'
    await settle(host, conv)
    assert all(p['status'] != 'pending' for p in snap(host, conv)['prompts'])


# ---------- send / create / stop ----------
async def test_send_idle_running_archived_and_max_active(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    t1, t2, archived = new(host, b), new(host, b), new(host, b)
    host.meta(f'conversation:{archived}', archived=True)
    conv = new(host, a)
    caller = await running(host, conv)
    s = host.sessions
    host.model.gate.clear()
    sent = await s.send(caller, t1, '#hold 改第三节', 1)
    assert sent['accepted'] and snap(host, t1)['meta']['status'] == 'running'
    first = next(x for x in snap(host, t1)['messages'] if x['id'] == sent['message_id'])
    assert first['originSessionId'] == conv and first['startsRun']
    refused = await s.send(caller, t2, '另一个任务', 1)
    assert refused == {'accepted': False, 'message_id': '', 'reason': '同时运行的派发会话已达上限 1'}
    assert snap(host, t2)['meta']['status'] == 'idle'
    live = await s.send(caller, t1, '补充：加一个表格', 1)  # same target is already counted / 已计入
    assert live['accepted']
    inserted = next(x for x in snap(host, t1)['messages'] if x['id'] == live['message_id'])
    assert inserted['runId'] == snap(host, t1)['meta']['runId']
    refused = {'accepted': False, 'message_id': '', 'reason': '目标会话已归档，不能发送'}
    assert (await s.send(caller, archived, 'x', 8)) == refused


async def test_create_and_stop(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv = new(host, a)
    caller = await running(host, conv)
    s = host.sessions
    assert (await s.create(caller, 'nope', 'x', '', 8))['accepted'] is False
    made = await s.create(caller, b, '#hold 长任务', '长任务', 8)
    child = made['session_id']
    m = snap(host, child)['meta']
    assert made['accepted'] and m['title'] == '长任务' and m['status'] == 'running'
    p = m['provenance']
    assert p['depth'] == 1 and p['chain'] == [conv] and p['parentRunId'] == caller['run_id']
    assert await s.authorize(caller, child, 'operate', True) == 'granted'  # creator grant / 创建者授权
    assert (await s.create(caller, b, 'x', '', 1))['accepted'] is False
    await until(lambda: host.engine.cancel_run(snap(host, child)['meta']['runId']))
    await settle(host, child)
    assert snap(host, child)['meta']['status'] == 'cancelled'
    assert await s.stop(caller, child) == {'stopped': True, 'status': 'cancelled'}


async def test_stop_running_target(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    target = new(host, b)
    conv = new(host, a)
    caller = await running(host, conv)
    host.model.gate.clear()
    await host.sessions.send(caller, target, '#hold 跑', 8)
    await until(lambda: host.engine._run_control.token(snap(host, target)['meta']['runId']))
    assert await host.sessions.stop(caller, target) == {'stopped': True, 'status': 'cancelled'}
    await settle(host, target)
    assert snap(host, target)['meta']['status'] == 'cancelled'


# ---------- provenance ----------
async def test_provenance_blocks_ancestors_end_to_end(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv = new(host, a)
    target = new(host, b)
    inner = json.dumps({'session_id': conv})
    dispatched = json.dumps({'session_id': target, 'text': f'#call session_read {inner}'})
    await say(host, conv, f'#call session_send {dispatched}')
    await respond(host, conv, 'session')
    await settle(host, conv)
    await until(lambda: any(x['role'] == 'assistant' for x in snap(host, target)['messages']))
    await settle(host, target)
    run = snap(host, target)['meta']['runId']
    assert host.sessions.run_provenance(run)['chain'] == [conv]
    assert '不能访问派自己干活的上级会话' in tool_text(host, target)
    assert pending(host, target) is None
    # B's own (user) turn uses B's session provenance: no restriction. / 用户直接对话不受限。
    assert snap(host, target)['meta']['provenance']['depth'] == 0


async def test_live_input_dispatcher_counts_as_ancestor(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    caller = await running(host, conv)
    host.model.gate.clear()
    t_caller = await running(host, target)  # B is busy with the user's own run / B 正在跑用户自己的轮次
    await until(lambda: host.engine._run_control.token(t_caller['run_id']))
    await host.sessions.send(caller, target, '补充', 8)
    with pytest.raises(ValueError, match='上级'):
        await host.sessions.read(t_caller, conv, None, 5)
    assert conv not in {r.session_id for r in await host.sessions.list_sessions(t_caller, {'limit': 50})}


async def test_resume_and_fork_keep_provenance(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv = new(host, a)
    caller = await running(host, conv)
    made = await host.sessions.create(caller, b, '整理', '派生', 8)
    child = made['session_id']
    await settle(host, child)
    cp = snap(host, child)['meta']['checkpoints'][-1]['id']
    fork = (await host.command('conversation', child, SCOPE, dict(type='fork', checkpointId=cp)))['resource']['id']
    fm = snap(host, fork)['meta']
    assert fm['provenance']['chain'] == [conv] and fm['forkCheckpointId'] == cp
    assert host.sessions.run_provenance(fm['runId'])['chain'] == [conv]
    await host.command('conversation', fork, SCOPE, dict(type='resume'))
    await settle(host, fork)
    assert host.sessions.run_provenance(snap(host, fork)['meta']['runId'])['depth'] == 1


# ---------- completion notices ----------
async def test_notice_wakes_idle_caller_and_is_idempotent(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    caller = await running(host, conv)
    host.model.release()
    await host.sessions.send(caller, target, '改第三节', 8)
    await settle(host, target)
    await until(lambda: any(x['kind'] == 'notice' for x in snap(host, conv)['messages']))
    await settle(host, conv)
    notice = next(x for x in snap(host, conv)['messages'] if x['kind'] == 'notice')
    run = snap(host, target)['meta']['runId']
    assert notice['id'] == f'notice:{target}:{run}' and notice['role'] == 'user' and notice['actor'] == NOTICE_ACTOR
    assert notice['text'].startswith('后台会话「') and '已完成' in notice['text'] and 'echo:' in notice['text']
    assert snap(host, conv)['meta']['autoWakeups'] == 1
    before = len(snap(host, conv)['messages'])
    await host.sessions.run_ended(target, run, 'done')
    assert len(snap(host, conv)['messages']) == before


async def test_notice_injected_into_running_caller(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    caller = await running(host, conv)
    await host.sessions.send(caller, target, '快速任务', 8)
    await settle(host, target)
    notice = await until(lambda: next((x for x in snap(host, conv)['messages'] if x['kind'] == 'notice'), None))
    # An injected notice counts as a wake-up too (engine 3.3.1). / 送入当前运行的通知同样计数。
    assert notice['runId'] == caller['run_id'] and snap(host, conv)['meta']['autoWakeups'] == 1
    host.model.release()
    await settle(host, conv)


async def test_running_caller_at_limit_holds_notice(host):
    a, b = agent(host, 'A', max_wakeups=1), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    caller = await running(host, conv)
    host.meta(f'conversation:{conv}', autoWakeups=1)
    await host.sessions.send(caller, target, '快速任务', 8)
    await settle(host, target)
    notice = await until(lambda: next((x for x in snap(host, conv)['messages'] if x['kind'] == 'notice'), None))
    assert notice['held'] and 'runId' not in notice and snap(host, conv)['meta']['autoWakeups'] == 1
    host.model.release()
    await settle(host, conv)
    assert host.snapshot('conversation', conv, SCOPE)['meta']['capabilities']['wake']


async def test_notice_dropped_for_archived_or_deleted_and_suppressed(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv, gone, target = new(host, a), new(host, a), new(host, b)
    caller = await running(host, conv)
    host.model.release()
    await settle(host, conv)
    host.meta(f'conversation:{conv}', archived=True)
    assert await host.sessions.deliver(conv, 'notice:x:1', '通知', target) == 'drop'
    host.db.remove('resource', f'conversation:{gone}')
    assert await host.sessions.deliver(gone, 'notice:x:2', '通知', target) == 'drop'
    host.db.put('session_dispatch', json.dumps(['r-sup', conv]), {
        'targetSessionId': target, 'callerRunId': caller['run_id'], 'callerChain': [], 'kind': 'send', 'createdAt': ''})
    host.sessions.record_run('r-sup', target, sessions_mod.default_provenance())
    host.sessions.suppress('r-sup', conv)
    host.meta(f'conversation:{conv}', archived=False)  # only the suppression may stop it / 只靠屏蔽拦截
    host.meta(f'conversation:{target}', status='completed', runId='r-sup')
    await host.sessions.run_ended(target, 'r-sup', 'done')
    assert not any(x['kind'] == 'notice' for x in snap(host, conv)['messages'])
    assert host.sessions.run_provenance('r-sup')['notified']


async def test_wake_limit_holds_then_continue(host):
    a, b = agent(host, 'A', max_wakeups=1), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    await say(host, conv, '开始')
    await settle(host, conv)
    host.meta(f'conversation:{conv}', autoWakeups=1)
    assert await host.sessions.deliver(conv, 'notice:t:1', '后台会话「x」已完成。', target) == 'hold'
    s = host.snapshot('conversation', conv, SCOPE)
    assert s['meta']['capabilities']['wake'] and next(x for x in s['messages'] if x['id'] == 'notice:t:1')['held']
    await host.command('conversation', conv, SCOPE, dict(type='wake'))
    await settle(host, conv)
    held = next(x for x in snap(host, conv)['messages'] if x['id'] == 'notice:t:1')
    assert 'held' not in held and held['runId'] == snap(host, conv)['meta']['runId']
    assert snap(host, conv)['meta']['autoWakeups'] == 0
    assert '后台会话「x」已完成' in tool_text(host, conv)


async def test_user_message_consumes_held_notice_and_watch(host):
    a, b = agent(host, 'A', max_wakeups=0), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    caller = await running(host, conv)
    await host.sessions.watch(caller, target, True)
    host.model.release()
    await settle(host, conv)
    await say(host, target, '用户自己跑一轮')
    await settle(host, target)
    await until(lambda: any(x['kind'] == 'notice' for x in snap(host, conv)['messages']))  # watch notifies any run
    await settle(host, conv)
    await host.sessions.watch({**caller, 'run_id': snap(host, conv)['meta']['runId']}, target, False)
    assert host.db.items('session_watch') == []


# ---------- edit and resend (W1) ----------
async def test_edit_deletes_rewinds_and_archives(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv = new(host, a)
    for text in ('第一轮', '第二轮', '第三轮'):
        await say(host, conv, text, request=f'r-{text}')
        await settle(host, conv)
    s = snap(host, conv)
    second = next(x for x in s['messages'] if x['text'] == '第二轮')
    assert second['rewindable']
    third_cp = s['meta']['checkpoints'][-1]['id']
    first_reply = next(x for x in s['messages'] if x['role'] == 'assistant')
    first_cp = next(cp['id'] for cp in s['meta']['checkpoints'] if cp.get('messageId') == first_reply['id'])
    late = (await host.command('conversation', conv, SCOPE, dict(type='fork', checkpointId=third_cp)))['resource']['id']
    early = await host.command('conversation', conv, SCOPE, dict(type='fork', checkpointId=first_cp))
    early = early['resource']['id']
    # A session created during round two. / 第二轮派生的会话。
    host.model.gate.clear()
    created = new(host, b)
    host.meta(f'conversation:{created}', provenance={'depth': 1, 'chain': [conv], 'parentSessionId': conv,
                                                     'parentRunId': second['runId'], 'rootSessionId': conv})
    await say(host, created, '#hold 长任务')
    await until(lambda: host.engine._run_control.token(snap(host, created)['meta']['runId']))
    host.db.put('session_dispatch', json.dumps([snap(host, created)['meta']['runId'], conv]),
                {'targetSessionId': created, 'callerRunId': second['runId'], 'callerChain': [], 'kind': 'create',
                 'createdAt': ''})
    preview = await host.command('conversation', conv, SCOPE, dict(type='editPreview', messageId=second['id']))
    assert preview['preview'] == {'messages': 4, 'branches': 1, 'sessions': 1}
    body = dict(type='editMessage', messageId=second['id'], text='改过的第二轮', requestId='edit-1', attachments=[])
    await host.command('conversation', conv, SCOPE, body)
    await settle(host, conv)
    texts = [x['text'] for x in snap(host, conv)['messages'] if x['role'] == 'user']
    assert texts == ['第一轮', '改过的第二轮']
    assert snap(host, late)['meta']['archived'] and snap(host, late)['meta']['archivedReason'] == 'edited'
    assert not snap(host, early)['meta'].get('archived')
    cm = snap(host, created)['meta']
    assert cm['archived'] and cm['status'] == 'cancelled'
    assert not any(x['kind'] == 'notice' for x in snap(host, conv)['messages'])
    assert host.db.items('session_dispatch') == []
    history = [json.loads(k) for k, _ in host.db.items('history')]
    stored = next(v for k, v in host.db.items('history') if json.loads(k)[1] == conv)
    assert history and '第三轮' not in json.dumps(stored, ensure_ascii=False)
    history_text = json.dumps(stored, ensure_ascii=False)
    assert '第一轮' in history_text and '改过的第二轮' in history_text


async def test_edit_rejections(host):
    a = agent(host, 'A')
    conv = new(host, a)
    await say(host, conv, '一')
    await settle(host, conv)
    reply = next(x for x in snap(host, conv)['messages'] if x['role'] == 'assistant')
    with pytest.raises(ValueError, match='不能编辑'):
        await host.command('conversation', conv, SCOPE, dict(type='editPreview', messageId=reply['id']))
    user = next(x for x in snap(host, conv)['messages'] if x['role'] == 'user')
    host.emit(f'conversation:{conv}', 'message', {**user, 'runId': 'legacy-run'})
    with pytest.raises(ValueError, match='旧版本'):
        await host.command('conversation', conv, SCOPE, dict(type='editMessage', messageId=user['id'], text='x',
                                                             requestId='e', attachments=[]))
    host.meta(f'conversation:{conv}', archived=True)
    with pytest.raises(ValueError, match='动作不可用'):
        await host.command('conversation', conv, SCOPE, dict(type='editPreview', messageId=user['id']))


# ---------- host prompt channel ----------
async def test_sessions_only_channel_does_not_pass_engine_queues(host):
    a = agent(host, 'A')
    conv = new(host, a)
    await running(host, conv)
    channel = await until(lambda: host.channels.get(f'conversation:{conv}'))
    await until(lambda: host.engine._run_control.token(snap(host, conv)['meta']['runId']))
    assert channel.run_options()  # host prompts only; queues are not handed to the engine / 只用于宿主提示
    agent_row = host.agent_row(a)
    assert not agent_row['runtime']['humanInTheLoop']
    host.model.release()
    await settle(host, conv)
    assert f'conversation:{conv}' not in host.channels


async def test_grants_commands(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    host.sessions.put_grant(conv, ('session', target), 'read', 'granted', 'user')
    listed = (await host.command('conversation', conv, SCOPE, dict(type='listGrants')))['grants']
    assert listed[0]['targetId'] == target and listed[0]['targetTitle']
    await host.command('conversation', conv, SCOPE, dict(type='revokeGrant', grantId=listed[0]['id']))
    assert host.sessions.grants(conv) == []
    with pytest.raises(ValueError, match='授权记录不存在'):
        await host.command('conversation', conv, SCOPE, dict(type='revokeGrant', grantId=listed[0]['id']))

# ---------- settlement races / shutdown ----------
async def test_notice_and_channel_survive_next_run_start(host, monkeypatch):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    caller = await running(host, conv)
    original = host.mark_rewindable
    async def slow_mark(key, run):
        await asyncio.sleep(0.5)
        await original(key, run)
    monkeypatch.setattr(host, 'mark_rewindable', slow_mark)
    assert (await host.sessions.send(caller, target, '第一次', 8))['accepted']
    host.model.gate.set()  # release A and B's first run / 放行 A 与 B 的第一轮
    await until(lambda: snap(host, target)['meta']['status'] == 'completed')
    first_run = snap(host, target)['meta']['runId']
    host.model.gate.clear()
    await say(host, target, '#hold 第二次')  # starts in the finalization window / 在收尾窗口内开启新一轮
    second_run = snap(host, target)['meta']['runId']
    assert second_run != first_run
    notice = await until(lambda: next((x for x in snap(host, conv)['messages']
                                        if x['id'] == f'notice:{target}:{first_run}'), None), 5)
    assert notice['kind'] == 'notice'
    channel = host.channels.get(f'conversation:{target}')
    assert channel is not None and channel.run_id == second_run
    host.model.release()
    await settle(host, target)
    await settle(host, conv)


async def test_shutdown_interrupts_run_without_notice(host, tmp_path):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    caller = await running(host, conv)
    assert (await host.sessions.send(caller, target, '#hold 长任务', 8))['accepted']
    await until(lambda: snap(host, target)['meta']['status'] == 'running')
    await host.close()
    host.close = lambda: asyncio.sleep(0)  # already closed / 已关闭
    again = HostService(tmp_path, Script(), db=str(tmp_path / 'host.db'))
    try:
        assert snap(again, target)['meta']['status'] == 'interrupted'
        assert not any(x['kind'] == 'notice' for x in snap(again, conv)['messages'])
    finally:
        await again.close()


async def test_expire_pending_scopes_to_run(host):
    a = agent(host, 'A')
    conv = new(host, a)
    key = f'conversation:{conv}'
    host.emit(key, 'prompt', dict(id='p-old', order=1, kind='approval', status='pending', runId='r-old', createdAt='x'))
    host.emit(key, 'prompt', dict(id='p-new', order=2, kind='approval', status='pending', runId='r-new', createdAt='x'))
    expire_pending(host, key, 'r-new')
    assert {p['id']: p['status'] for p in snap(host, conv)['prompts']} == {'p-old': 'pending', 'p-new': 'expired'}


# ---------- round-two fixes: run tails, shutdown, restart, edit locks ----------
def slow_tail(host, monkeypatch, fail=False):
    """Widen the window between a run's terminal event and the end of its task. / 拉长运行收尾窗口。"""
    original = host.mark_rewindable

    async def tail(key, run):
        await asyncio.sleep(0.4)
        if fail:
            raise RuntimeError('收尾失败')
        await original(key, run)
    monkeypatch.setattr(host, 'mark_rewindable', tail)


async def next_turn_in_tail(host, conv):
    host.model.release()
    await say(host, conv, '第一轮', request='t1')
    await until(lambda: snap(host, conv)['meta']['status'] == 'completed')
    first, old = snap(host, conv)['meta']['runId'], host.tasks[f'conversation:{conv}']
    host.model.gate.clear()
    await say(host, conv, '#hold 第二轮', request='t2')
    return first, old


async def test_tail_cut_excludes_next_turn(host, monkeypatch):
    conv = new(host, agent(host, 'A'))
    slow_tail(host, monkeypatch)
    first, old = await next_turn_in_tail(host, conv)
    await asyncio.wait_for(asyncio.shield(old), 5)
    reply = next(x for x in snap(host, conv)['messages'] if x['role'] == 'assistant' and x['runId'] == first)
    cp = next(cp['id'] for cp in snap(host, conv)['meta']['checkpoints'] if cp.get('messageId') == reply['id'])
    assert [x['text'] for x in host.db.get('cut', cp)['messages']] == ['第一轮', reply['text']]


async def test_tail_failure_keeps_newer_run_status(host, monkeypatch):
    conv = new(host, agent(host, 'A'))
    slow_tail(host, monkeypatch, fail=True)
    first, old = await next_turn_in_tail(host, conv)
    second = snap(host, conv)['meta']['runId']
    await asyncio.wait_for(asyncio.shield(old), 5)
    m = snap(host, conv)['meta']
    assert m['status'] == 'running' and m['runId'] == second
    assert host.sessions.run_provenance(first)['settled'] == 'done'
    assert any(x['kind'] == 'phase' and '收尾失败' in x['text'] for x in snap(host, conv)['messages'])


async def test_close_awaits_displaced_run(host, monkeypatch):
    conv = new(host, agent(host, 'A'))
    slow_tail(host, monkeypatch)
    _, old = await next_turn_in_tail(host, conv)
    host.model.release()
    await host.close()
    host.close = lambda: asyncio.sleep(0)  # already closed / 已关闭
    assert old.done() and (old.cancelled() or old.exception() is None)  # never writes after the DB closed
    assert not host.running


async def test_shutdown_cancel_event_marks_interrupted(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    caller = await running(host, conv)
    await host.sessions.send(caller, target, '#hold 长任务', 8)
    run = snap(host, target)['meta']['runId']
    await until(lambda: host.engine._run_control.token(run))
    host.closing = True
    host.engine.cancel_run(run)  # the engine's own cancelled event while closing / 关闭期间引擎发出 cancelled
    await asyncio.wait_for(asyncio.shield(host.tasks[f'conversation:{target}']), 5)
    assert snap(host, target)['meta']['status'] == 'interrupted'
    assert host.sessions.run_provenance(run)['settled'] is None
    assert not any(x['kind'] == 'notice' for x in snap(host, conv)['messages'])
    host.closing = False


async def test_notice_settled_during_shutdown_is_replayed(host, tmp_path):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    caller = await running(host, conv)
    await host.sessions.send(caller, target, '#hold 快完成了', 8)
    run = snap(host, target)['meta']['runId']
    host.closing = True  # shutdown begins; the run still completes / 开始关闭，运行仍然完成
    host.model.release()
    await asyncio.wait_for(asyncio.shield(host.tasks[f'conversation:{target}']), 5)
    assert snap(host, target)['meta']['status'] == 'completed'
    assert host.sessions.run_provenance(run)['settled'] == 'done' and not host.sessions.run_provenance(run)['notified']
    await host.close()
    host.close = lambda: asyncio.sleep(0)  # already closed / 已关闭
    again = HostService(tmp_path, Script(), db=str(tmp_path / 'host.db'))
    try:
        again.model.release()
        await again.recover()
        assert any(x['id'] == f'notice:{target}:{run}' for x in snap(again, conv)['messages'])
        assert again.sessions.run_provenance(run)['notified']
        await again.recover()  # idempotent / 幂等
        assert sum(x['id'] == f'notice:{target}:{run}' for x in snap(again, conv)['messages']) == 1
    finally:
        await again.close()


async def test_restart_clears_stale_streaming(host, tmp_path):
    conv = new(host, agent(host, 'A'))
    key = f'conversation:{conv}'
    host.message(key, '半截', 'A', ident='m1', streaming=True,
                 parts=[{'id': 'p', 'kind': 'text', 'text': '半截', 'status': 'running'}])
    await host.close()
    host.close = lambda: asyncio.sleep(0)  # already closed / 已关闭
    again = HostService(tmp_path, Script(), db=str(tmp_path / 'host.db'))
    try:
        m = next(x for x in snap(again, conv)['messages'] if x['id'] == 'm1')
        assert m['streaming'] is False and m['parts'][0]['status'] == 'interrupted'
    finally:
        await again.close()


async def test_close_expires_only_its_run_prompts(host):
    conv = new(host, agent(host, 'A'))
    key = f'conversation:{conv}'
    host.emit(key, 'prompt', dict(id='p-old', order=1, kind='approval', status='pending', runId='r-old', createdAt='x'))
    channel = PromptChannel(host, key, 'r-new')
    channel.ask(dict(kind='session_access', level='read'))
    await channel.close()
    statuses = {p.get('runId'): p['status'] for p in snap(host, conv)['prompts']}
    assert statuses == {'r-old': 'pending', 'r-new': 'expired'}


async def edited_with_running_children(host, monkeypatch):
    """Conversation S with a running late branch and a running created session; rewind is slowed.
    构造带运行中分支与派生会话的会话，并放慢回退。"""
    a, b = agent(host, 'A'), agent(host, 'B')
    conv = new(host, a)
    host.model.release()
    for text in ('一', '二'):
        await say(host, conv, text, request=f'e-{text}')
        await settle(host, conv)
    s = snap(host, conv)
    second = next(x for x in s['messages'] if x['text'] == '二')
    fork = dict(type='fork', checkpointId=s['meta']['checkpoints'][-1]['id'])
    late = (await host.command('conversation', conv, SCOPE, fork))['resource']['id']
    created = new(host, b)
    host.meta(f'conversation:{created}', provenance={'depth': 1, 'chain': [conv], 'parentSessionId': conv,
                                                     'parentRunId': second['runId'], 'rootSessionId': conv})
    host.model.gate.clear()
    for child in (late, created):
        await say(host, child, '#hold 跑', request=f'c-{child}')
        await until(lambda: host.engine._run_control.token(snap(host, child)['meta']['runId']))
    agent_obj = await host.agent(a)
    original = agent_obj.rewind_session

    async def slow_rewind(*args, **kwargs):
        await asyncio.sleep(0.4)
        return await original(*args, **kwargs)
    monkeypatch.setattr(agent_obj, 'rewind_session', slow_rewind)
    return conv, second, late, created


async def test_edit_halts_running_branch_and_blocks_sends(host, monkeypatch):
    conv, second, late, created = await edited_with_running_children(host, monkeypatch)
    other = new(host, agent(host, 'C'))
    caller = await running(host, other)
    edit = asyncio.create_task(host.command('conversation', conv, SCOPE, dict(
        type='editMessage', messageId=second['id'], text='改', requestId='edit-lock', attachments=[])))
    await until(lambda: snap(host, late)['meta']['status'] != 'running')
    sent = await host.sessions.send(caller, created, '趁编辑时发', 8)  # waits for the edit lock / 等编辑释放锁
    await edit
    assert sent == {'accepted': False, 'message_id': '', 'reason': sessions_mod.ARCHIVED_REASON}
    for child in (late, created):
        m = snap(host, child)['meta']
        assert m['archived'] and m['archivedReason'] == 'edited' and m['status'] == 'cancelled', m
    host.model.release()
    await settle(host, conv)
    assert not any(x['kind'] == 'notice' for x in snap(host, conv)['messages'])


# ---------- unattended runs: pre-authorization and plugin settings ----------
async def test_preauthorized_read_skips_prompt_operate_still_asks(host):
    b = agent(host, 'B')
    a = agent(host, 'A', grants=[{'target': '*', 'level': 'read'}])
    target, conv = new(host, b), new(host, a)
    caller = await running(host, conv)
    s = host.sessions
    assert await s.authorize(caller, target, 'read', True) == 'granted'
    assert pending(host, conv) is None and s.grants(conv) == []  # nothing stored per session / 不写会话授权
    assert s.access(conv, host.db.get('resource', f'conversation:{target}')) == 'read'
    task = asyncio.create_task(s.authorize(caller, target, 'operate', True))
    await respond(host, conv, 'deny')
    assert await task == 'denied'


async def test_preauthorization_by_agent_and_explicit_denial_wins(host):
    b, c = agent(host, 'B'), agent(host, 'C')
    a = agent(host, 'A', grants=[{'target': b, 'level': 'operate'}])
    tb, tb2, tc, conv = new(host, b), new(host, b), new(host, c), new(host, a)
    caller = await running(host, conv)
    s = host.sessions
    assert await s.authorize(caller, tb, 'operate', True) == 'granted'
    assert await s.authorize(caller, tb, 'read', True) == 'granted'  # operate includes read / 操作包含读取
    s.put_grant(conv, ('session', tb2), 'read', 'denied', 'user')
    assert await s.authorize(caller, tb2, 'operate', True) == 'denied'  # explicit denial wins / 明确拒绝优先
    task = asyncio.create_task(s.authorize(caller, tc, 'read', True))  # other agent: not pre-authorized
    await respond(host, conv, 'session')
    assert await task == 'granted'
    assert await s.authorize(caller, tc, 'read', False) == 'denied'  # cross_agent off still applies / 仍受跨 Agent 限制


async def test_unknown_preauthorized_agent_is_rejected(host):
    body = AgentInput.model_validate({'name': 'A', 'models': {}, 'plugins': {}, 'bindings': {},
                                      'runtime': {'sessionGrants': [{'target': 'missing', 'level': 'read'}]}})
    with pytest.raises(ValueError, match='授权目标 Agent 不存在'):
        host.agents_svc.save(body)


async def test_plugin_settings_reach_agent_yaml(host):
    a = agent(host, 'A', plugins={'sessions': {'enabled': True, 'config': {'max_active': 1, 'cross_agent': False}}})
    config = host.agents_svc.render(host.agents_svc.items.get(a), a, host.test_path)
    assert config['plugins']['sessions'] == {'enabled': True, 'max_active': 1, 'cross_agent': False, 'max_wakeups': 10}
    instance = await host.agent(a)  # the engine accepts the values / 引擎接受这些值
    assert instance.registry.has('session_send')


# ---------- third-round fixes ----------
async def test_unsettled_write_is_not_resumable(host):
    conv = new(host, agent(host, 'A'))
    host.meta(f'conversation:{conv}', status='interrupted', runId='r-cut')
    cp = dict(id='cp-1', run_id='r-cut', sequence=1, status='running', kind='step', metadata={}, created_at=0.0,
              state={'unsettled_writes': {'call_1': {'name': 'session_create', 'step_id': None}}})
    host.db.put('checkpoint', 'cp-1', cp)
    assert not host.snapshot('conversation', conv, SCOPE)['meta']['capabilities']['resume']
    host.db.put('checkpoint', 'cp-2', {**cp, 'id': 'cp-2', 'sequence': 2, 'state': {}})
    assert host.snapshot('conversation', conv, SCOPE)['meta']['capabilities']['resume']


async def test_cancel_during_tail_keeps_result_and_replays_notice(host, monkeypatch, tmp_path):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    caller = await running(host, conv)
    slow_tail(host, monkeypatch)
    await host.sessions.send(caller, target, '#hold 收尾', 8)
    run = snap(host, target)['meta']['runId']
    host.model.release()
    await until(lambda: snap(host, target)['meta']['status'] == 'completed')
    await host.close()  # cancels the target inside its tail / 在收尾阶段取消
    host.close = lambda: asyncio.sleep(0)  # already closed / 已关闭
    again = HostService(tmp_path, Script(), db=str(tmp_path / 'host.db'))
    try:
        assert snap(again, target)['meta']['status'] == 'completed'
        again.model.release()
        await again.recover()
        assert any(x['id'] == f'notice:{target}:{run}' for x in snap(again, conv)['messages'])
    finally:
        await again.close()


async def test_stop_then_resume_sends_a_second_notice(host):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    caller = await running(host, conv)
    await host.sessions.send(caller, target, '#hold 长任务', 8)
    run = snap(host, target)['meta']['runId']
    await until(lambda: host.engine.cancel_run(run))
    await settle(host, target)
    first = await until(lambda: next((x for x in snap(host, conv)['messages']
                                      if x['id'] == f'notice:{target}:{run}'), None))
    assert '已停止' in first['text']
    host.model.release()
    await host.command('conversation', target, SCOPE, dict(type='resume'))
    await settle(host, target)
    second = await until(lambda: next((x for x in snap(host, conv)['messages']
                                       if x['id'] == f'notice:{target}:{run}.2'), None))
    assert '已完成' in second['text']
    await settle(host, conv)


async def test_caller_never_ready_fails_delivery_instead_of_holding(host, monkeypatch):
    a, b = agent(host, 'A'), agent(host, 'B')
    conv, target = new(host, a), new(host, b)
    host.meta(f'conversation:{conv}', status='running', runId='r-ghost')  # marked running, no engine run
    monkeypatch.setattr(sessions_mod, 'LIVE_INPUT_TIMEOUT', 0.2)
    with pytest.raises(RuntimeError, match='未能接收通知'):
        await host.sessions.deliver(conv, 'notice:x:1', '通知', target)
    assert not any(x['kind'] == 'notice' for x in snap(host, conv)['messages'])


async def test_close_also_stops_runs_started_while_closing(host):
    started = asyncio.Event()

    async def second():
        started.set()
        await asyncio.sleep(30)

    async def first():
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            host.spawn('conversation:late', second())  # e.g. a notice starting a turn / 如通知开启新一轮
            raise
    host.spawn('conversation:early', first())
    await asyncio.sleep(0)
    await host.close()
    host.close = lambda: asyncio.sleep(0)  # already closed / 已关闭
    assert started.is_set() and not host.running


async def test_edit_scope_includes_sessions_created_by_created_sessions(host):
    a = agent(host, 'A')
    conv = new(host, a)
    host.model.release()
    await say(host, conv, '一', request='g-1')
    await settle(host, conv)
    first = next(x for x in snap(host, conv)['messages'] if x['role'] == 'user')
    child, grandchild = new(host, a), new(host, a)
    host.meta(f'conversation:{child}', provenance={'depth': 1, 'chain': [conv], 'parentSessionId': conv,
                                                   'parentRunId': first['runId'], 'rootSessionId': conv})
    host.meta(f'conversation:{grandchild}', provenance={'depth': 2, 'chain': [conv, child], 'parentSessionId': child,
                                                        'parentRunId': 'any', 'rootSessionId': conv})
    scope = host.edit_scope(f'conversation:{conv}', first['id'])
    assert scope['sessions'] == [f'conversation:{child}', f'conversation:{grandchild}']


async def test_timeout_denial_yields_to_preauthorization_user_denial_does_not(host):
    b = agent(host, 'B')
    a = agent(host, 'A', grants=[{'target': '*', 'level': 'operate'}])
    t1, t2, conv = new(host, b), new(host, b), new(host, a)
    caller = await running(host, conv)
    s = host.sessions
    s.put_grant(conv, ('session', t1), 'read', 'denied', 'timeout')
    s.put_grant(conv, ('session', t2), 'operate', 'denied', 'user')
    assert await s.authorize(caller, t1, 'operate', True) == 'granted'
    assert await s.authorize(caller, t2, 'operate', True) == 'denied'
    # The list shows what authorize decides. / 列表权限与授权判断一致。
    assert s.access(conv, host.db.get('resource', f'conversation:{t2}')) == 'read'
    assert s.access(conv, host.db.get('resource', f'conversation:{t1}')) == 'operate'


async def test_failed_write_tool_keeps_run_forkable(host):
    """A write tool that returns an error is settled (engine 3.3.2): the reply after it can still be forked.
    写工具返回失败结果后已确定（引擎 3.3.2）：之后的回复仍可开分支。"""
    conv = new(host, agent(host, 'A'))
    host.model.release()
    await say(host, conv, '#call session_create {"agent_name": "missing", "text": "x"}')
    await settle(host, conv)
    s = snap(host, conv)
    reply = [x for x in s['messages'] if x['role'] == 'assistant'][-1]
    assert 'Agent 不存在' in reply['text']
    cp = next(cp['id'] for cp in s['meta']['checkpoints'] if cp.get('messageId') == reply['id'])
    assert not host.db.get('checkpoint', cp)['state'].get('unsettled_writes')
    branch = (await host.command('conversation', conv, SCOPE, dict(type='fork', checkpointId=cp)))['resource']['id']
    assert snap(host, branch)['meta']['parentId'] == conv
