"""Persistence, teardown and transport boundaries of the standalone host."""
import asyncio
import json
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request
from axc_agent_engine import Checkpoint
from server.app import create_app
from server.routers.resources import detail
from server.services.resources import HostService
from server.services.seed import GENERAL_ID, PLANNER_ID
from server.models import FixtureModel, configured_model
from server.db import Database, Checkpoints, Messages

LOCAL = {'key': 'local'}
DEFINITION = dict(name='生命周期', mode='group_chat', objective='目标', topic='议题',
                  background='', persona='', agents=[GENERAL_ID, PLANNER_ID],
                  maxRounds=1, maxSteps=1, redObjective='', blueObjective='')

@pytest.mark.asyncio
async def test_storage_keeps_scopes_and_runs_independent(tmp_path):
    db = Database(str(tmp_path / 'storage.db'))
    messages, checkpoints = Messages(db), Checkpoints(db)
    try:
        await messages.save('a', '1', [{'role': 'user', 'content': 'A'}])
        await messages.save('b', '1', [{'role': 'user', 'content': 'B'}])
        await messages.save('a', '2', [])
        await messages.delete('a', '1')
        assert await messages.load('a', '1') == []
        await messages.clear('a')
        assert len(db.items('history')) == 1
        assert (await messages.load('b', '1'))[0]['content'] == 'B'
        for cp in [Checkpoint(run_id='one', sequence=2, status='completed'),
                   Checkpoint(run_id='two', kind='step'),
                   Checkpoint(run_id='one', sequence=1)]:
            await checkpoints.save(cp)
        assert (await checkpoints.latest('one')).sequence == 2
        assert set(await checkpoints.list_runs()) == {'one', 'two'}
        assert await checkpoints.list_runs(status='completed', kind='round') == ['one']
        assert await checkpoints.list_runs(kind='step') == ['two']
        await checkpoints.delete_run('one')
        assert await checkpoints.latest('one') is None
        assert await checkpoints.list_runs() == ['two']
    finally:
        db.close()

@pytest.mark.asyncio
async def test_immediate_stop_and_restart_preserve_confirmed_status(tmp_path):
    path = str(tmp_path / 'restart.db')
    host = HostService(tmp_path, FixtureModel(), db=path, seed=True)
    sim = host.create('simulation', LOCAL, definition=DEFINITION)
    await host.command('simulation', sim['id'], LOCAL, {'type': 'start'})
    await host.command('simulation', sim['id'], LOCAL, {'type': 'stop'})
    assert host.snapshot('simulation', sim['id'], LOCAL)['meta']['status'] == 'cancelled'
    chat = host.create('conversation', LOCAL, GENERAL_ID)
    # A crash can leave persisted running/paused state without a live in-process task.
    host.meta('conversation:' + chat['id'], status='running')
    host.meta('simulation:' + sim['id'], status='paused')
    await host.close()
    host = HostService(tmp_path, FixtureModel(), db=path)
    try:
        interrupted = host.snapshot('conversation', chat['id'], LOCAL)['meta']
        assert interrupted['status'] == 'interrupted'
        assert not interrupted['capabilities']['resume']
        failed = host.snapshot('simulation', sim['id'], LOCAL)['meta']
        assert failed['status'] == 'failed'
        assert not failed['capabilities']['resume']
    finally:
        await host.close()

@pytest.mark.asyncio
async def test_rejected_payloads_leave_transcript_unchanged(tmp_path):
    host = HostService(tmp_path, FixtureModel(), db=':memory:', seed=True)
    try:
        chat = host.create('conversation', LOCAL, GENERAL_ID)
        base = dict(type='send', requestId='r', text='文本', attachments=[], mode='send')
        for payload in [{**base, 'attachments': [{'id': 'image'}]}, {**base, 'text': ' '}]:
            with pytest.raises(ValueError):
                await host.command('conversation', chat['id'], LOCAL, payload)
        assert host.snapshot('conversation', chat['id'], LOCAL)['messages'] == []
        sim = host.create('simulation', LOCAL, definition=DEFINITION)
        for target, question in [('unknown', '问题'), ('all', ' ')]:
            with pytest.raises(ValueError):
                await host.command('simulation', sim['id'], LOCAL, dict(type='interview', requestId='i', target=target, question=question))
        assert host.snapshot('simulation', sim['id'], LOCAL)['messages'] == []
    finally:
        await host.close()

@pytest.mark.asyncio
async def test_closing_during_model_call_persists_interruption(tmp_path):
    class WaitingModel(FixtureModel):
        def __init__(self):
            self.entered = asyncio.Event()
        async def stream(self, *args, **kwargs):
            self.entered.set()
            await asyncio.Event().wait()
            yield
    path = str(tmp_path / 'closing.db')
    model = WaitingModel()
    host = HostService(tmp_path, model, db=path, seed=True)
    chat = host.create('conversation', LOCAL, GENERAL_ID)
    await host.command('conversation', chat['id'], LOCAL, dict(type='send', requestId='r', text='中断', attachments=[], mode='send'))
    await asyncio.wait_for(model.entered.wait(), 5)
    await asyncio.wait_for(host.close(), 5)
    recovered = HostService(tmp_path, FixtureModel(), db=path)
    try:
        state = recovered.snapshot('conversation', chat['id'], LOCAL)
        assert state['meta']['status'] in ('cancelled', 'interrupted')
        assert state['messages'][0]['text'] == '中断'
    finally:
        await recovered.close()

@pytest.mark.asyncio
async def test_sse_scopes_capabilities_and_unsubscribes(tmp_path):
    host = HostService(tmp_path, FixtureModel(), db=':memory:', seed=True)
    app = create_app(host)
    app.state.host = host
    topic = {'key': 'topic', 'shortcut': {'shortcut_key': 'example.topic', 'context': {'topic_id': 1}}}
    meta = host.create('conversation', topic, GENERAL_ID)
    request = Request({'type': 'http', 'app': app})
    response = await detail(request, 'conversation', meta['id'], json.dumps(LOCAL), True)
    stream = response.body_iterator
    key = 'conversation:' + meta['id']
    try:
        assert await anext(stream) == ': subscribed\n\n'
        host.meta(key, title='实时标题')
        event = json.loads((await anext(stream))[6:])
        assert event['value']['title'] == '实时标题'
        assert not event['value']['capabilities']['send']
        host.message(key, '中文事件', 'analyst')
        assert json.loads((await anext(stream))[6:])['value']['text'] == '中文事件'
    finally:
        await stream.aclose()
        assert not host.listeners[key]
        await host.close()

def test_http_unknown_input_is_rejected_before_mutation(tmp_path):
    host = HostService(tmp_path, FixtureModel(), db=':memory:', seed=True)
    with TestClient(create_app(host)) as client:
        for scope in [None, [], {'key': 'local', 'extra': True}, {'key': 'missing'},
                      {'key': 'topic', 'shortcut': {}},
                      {'key': 'topic', 'shortcut': {'shortcut_key': 'example.topic', 'context': {'topic_id': True}}}]:
            assert client.get('/api/catalog', params={'scope': json.dumps(scope)}).status_code == 400
        for filters in [[], {'keyword': 3}, {'unknown': True}]:
            assert client.get('/api/conversation', params={'scope': json.dumps(LOCAL), 'filter': json.dumps(filters)}).status_code == 400
        assert client.post('/api/conversation', json={'scope': LOCAL, 'agentId': 'unknown'}).status_code == 400
        assert client.post('/api/simulation', json={'scope': LOCAL}).status_code == 400
        assert client.post('/api/simulation', json={'scope': LOCAL, 'definition': {**DEFINITION, 'name': ' '}}).status_code == 422
        assert host.db.items('resource') == []

def test_model_configuration_does_not_fall_back_to_fixture(monkeypatch):
    monkeypatch.setenv('AXC_MODEL_MODE', 'fixture')
    assert isinstance(configured_model(), FixtureModel)
    monkeypatch.setenv('AXC_MODEL_MODE', 'invalid')
    with pytest.raises(ValueError, match='AXC_MODEL_MODE'):
        configured_model()
    monkeypatch.setenv('AXC_MODEL_MODE', 'openai')
    # openai mode never falls back to the fixture: each agent must resolve its own provider model.
    assert configured_model() is None
