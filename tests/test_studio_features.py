"""Contract 0.2 host features in fixture mode: human interaction, usage, embeddings, MCP, memories, analytics,
eval review/report. / 0.2 协议新增宿主功能（fixture 模式）。"""
import asyncio
from datetime import datetime, timedelta, timezone
import json
from urllib.parse import quote
from axc_agent_engine import LLMStreamChunk
from fastapi.testclient import TestClient
import pytest
from server.app import create_app
from server.models import FixtureModel
from server.services.resources import HostService
from server.services.seed import GENERAL_ID
from test_studio import SCOPE, agent_body, chat, wait

SECRET_KEY = 'suqzeVCj3y0XqPUlSGllxZTTFFdHAQX49Qh3-MuKHMs='


class ToolCaller(FixtureModel):
    """Calls one tool, then answers with the fixture text. / 先调用一个工具，再作答。"""
    def __init__(self, name, arguments):
        self.name, self.arguments = name, arguments
        self.seen = []

    async def stream(self, messages, tools=None, **options):
        self.seen.append(json.dumps(messages, ensure_ascii=False, default=str))
        if any(m.get('role') == 'tool' for m in messages):
            async for chunk in super().stream(messages, tools, **options):
                yield chunk
            return
        yield LLMStreamChunk(tool_call_delta={'index': 0, 'id': 'call_1', 'type': 'function', 'function': {
            'name': self.name, 'arguments': json.dumps(self.arguments, ensure_ascii=False)}}, finish_reason='tool_calls')


class MemoryWriter(FixtureModel):
    """Answers the memory plugin's extraction prompt with one fact line. / 回答记忆抽取提示。"""
    FACT = '用户长期偏好：所有回答都使用简体中文，并且优先给出结论，然后再用不超过三条要点解释原因和依据，每条要点都附上可以核对的来源。'

    async def ask(self, prompt, **options):
        return f'0.9|{self.FACT}' if '事实列表' in prompt else await super().ask(prompt, **options)


class Failing(FixtureModel):
    async def stream(self, messages, tools=None, **options):
        raise RuntimeError('provider timeout while streaming')
        yield  # pragma: no cover


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('AXC_SECRET_KEY', SECRET_KEY)
    host = HostService(tmp_path, FixtureModel(), seed=True)
    with TestClient(create_app(host)) as c:
        c.host = host
        yield c


def new_agent(client, model, name, **extra):
    """Create an agent whose engine instance uses ``model``. / 新建使用指定夹具模型的 Agent。"""
    client.host.model = model
    response = client.post('/api/agents', json=agent_body(name, **extra))
    assert response.status_code == 200, response.text
    return response.json()['id']


def snapshot(client, conv):
    return client.get(f'/api/conversation/{conv}', params={'scope': SCOPE}).json()


def start(client, agent_id, text):
    conv = client.post('/api/conversation', json={'scope': {'key': 'local'}, 'agentId': agent_id}).json()['id']
    body = {'type': 'send', 'requestId': f'r-{conv}', 'text': text, 'attachments': [], 'mode': 'send'}
    assert client.post(f'/api/conversation/{conv}', params={'scope': SCOPE}, json=body).status_code == 200
    return conv


def respond(client, conv, **body):
    return client.post(f'/api/conversation/{conv}', params={'scope': SCOPE}, json={'type': 'respond', **body})


def pending(client, conv):
    state = wait(lambda: snapshot(client, conv), lambda s: any(p['status'] == 'pending' for p in s['prompts']))
    return state, next(p for p in state['prompts'] if p['status'] == 'pending')


HITL = {'runtime': {'humanInTheLoop': True}}
DANGEROUS = ('shell', {'command': 'git push origin main'})


def test_plugin_catalog_marks_new_managed_plugins(client):
    plugins = {p['name']: p for p in client.get('/api/plugins').json()}
    assert plugins['human_in_the_loop']['managed'] and plugins['mcp']['managed'] and not plugins['memory']['managed']


def test_hitl_approval_approved_and_denied(client):
    agent = new_agent(client, ToolCaller(*DANGEROUS), '审批员', **HITL)
    exported = client.get(f'/api/agents/{agent}/export').text
    assert 'human_in_the_loop:' in exported and 'human_approval' in exported and 'human_in_the_loop: true' not in exported
    results = {}
    for approved in (True, False):
        conv = start(client, agent, '清理临时目录')
        state, prompt = pending(client, conv)
        assert prompt['kind'] == 'approval' and prompt['toolName'] == 'shell' and prompt['riskLevel'] == 'dangerous'
        assert prompt['arguments'] == DANGEROUS[1] and prompt['order'] > 0 and prompt['createdAt']
        assert state['meta']['capabilities']['respond'] and state['meta']['status'] == 'running'
        assert respond(client, conv, promptId=prompt['id']).status_code == 400  # approval needs approved
        reply = respond(client, conv, promptId=prompt['id'], approved=approved)
        assert reply.status_code == 200, reply.text
        event = reply.json()['events'][0]
        assert event['kind'] == 'prompt' and event['value']['status'] == 'answered' and event['value']['answer'] is approved
        assert respond(client, conv, promptId=prompt['id'], approved=approved).status_code == 400  # already answered
        state = wait(lambda: snapshot(client, conv), lambda s: s['meta']['status'] != 'running')
        assert state['meta']['status'] == 'completed' and not state['meta']['capabilities']['respond']
        results[approved] = next(p for p in state['messages'][-1]['parts'] if p['kind'] == 'tool')
    # Approved calls pass the plugin and reach tool resolution; denied ones are rejected by the plugin.
    assert 'Unknown tool' in results[True]['text'] and 'human_in_the_loop' in results[False]['text']
    assert results[True]['status'] == results[False]['status'] == 'failed'
    calls = [r['toolCalls'] for r in client.host.runs.query(agent)]
    assert [c[0]['success'] for c in calls] == [False, False] and 'human_in_the_loop' in calls[1][0]['error']


def test_hitl_ask_human_answer(client):
    agent = new_agent(client, ToolCaller('ask_human', {'question': '选哪个方案？', 'options': ['A', 'B']}), '提问者', **HITL)
    conv = start(client, agent, '帮我选')
    _, prompt = pending(client, conv)
    assert prompt['kind'] == 'question' and prompt['question'] == '选哪个方案？' and prompt['options'] == ['A', 'B']
    assert respond(client, conv, promptId=prompt['id'], answer=' ').status_code == 400
    assert respond(client, conv, promptId=prompt['id'], answer='B 方案').status_code == 200
    state = wait(lambda: snapshot(client, conv), lambda s: s['meta']['status'] != 'running')
    assert state['meta']['status'] == 'completed'
    assert [p['answer'] for p in state['prompts']] == ['B 方案']
    tool = next(p for p in state['messages'][-1]['parts'] if p['kind'] == 'tool')
    assert tool['status'] == 'completed' and 'B 方案' in tool['text']


def test_hitl_prompts_expire_on_stop_and_restart(client, tmp_path):
    agent = new_agent(client, ToolCaller(*DANGEROUS), '停止者', **HITL)
    conv = start(client, agent, '清理')
    _, prompt = pending(client, conv)
    assert client.post(f'/api/conversation/{conv}', params={'scope': SCOPE}, json={'type': 'stop'}).status_code == 200
    state = wait(lambda: snapshot(client, conv), lambda s: s['meta']['status'] != 'running')
    assert [p['status'] for p in state['prompts']] == ['expired'] and not state['meta']['capabilities']['respond']
    assert respond(client, conv, promptId=prompt['id'], approved=True).status_code == 400
    # A pending prompt left by a crashed host expires on the next start. / 宿主重启后过期。
    key = f'conversation:{conv}'
    row = client.host.db.get('resource', key)
    row['snapshot']['prompts'] = [{**prompt, 'status': 'pending'}]
    client.host.db.put('resource', key, row)
    reopened = HostService(tmp_path / 'other', FixtureModel(), db=client.host.data / 'workbench.db')
    try:
        assert [p['status'] for p in reopened.snapshot('conversation', conv, {'key': 'local'})['prompts']] == ['expired']
    finally:
        asyncio.run(reopened.close())


def test_without_hitl_dangerous_tools_are_not_queued(client):
    agent = new_agent(client, ToolCaller(*DANGEROUS), '无审批')
    _, state = chat(client, agent, '清理')
    assert state['meta']['status'] == 'completed' and state['prompts'] == []


def test_usage_on_reply_and_agent_aggregate(client):
    conv, state = chat(client, GENERAL_ID, '你好')
    usage = state['messages'][-1]['usage']
    assert usage['inputTokens'] > 0 and usage['outputTokens'] > 0
    _, state = chat(client, GENERAL_ID, '再来一次', conv=conv)
    second = state['messages'][-1]['usage']
    agent = client.get(f'/api/agents/{GENERAL_ID}').json()
    assert agent['usage'] == {'inputTokens': usage['inputTokens'] + second['inputTokens'],
                              'outputTokens': usage['outputTokens'] + second['outputTokens'], 'runs': 2}
    assert client.get('/api/agents').json()[1]['usage']['runs'] == 0


def embedding_provider(client, *models):
    return client.post('/api/providers', json={'name': 'Emb', 'baseUrl': 'https://emb.example/v1', 'apiKey': 'k',
                                               'models': [{'id': m, 'type': 'embedding'} for m in models] + [{'id': 'chat'}]}).json()


def test_embedding_mount_is_used_by_knowledge_search(client, monkeypatch):
    from axc_agent_engine.plugins.builtin.knowledge.support.retrieval import HashEmbeddingClient
    calls = []

    class Recording(HashEmbeddingClient):
        async def embed(self, texts):
            calls.append(list(texts))
            return await super().embed(texts)
    monkeypatch.setattr('server.services.agents.HashEmbeddingClient', Recording)
    provider = embedding_provider(client, 'emb-1')
    bad = client.post('/api/knowledge', json={'name': '坏', 'embeddingModel': f"{provider['id']}:chat"})
    assert bad.status_code == 400
    kb = client.post('/api/knowledge', json={'name': '向量库', 'embeddingModel': f"{provider['id']}:emb-1"}).json()
    assert kb['embeddingModel'] == f"{provider['id']}:emb-1"
    client.post(f"/api/knowledge/{kb['id']}/documents", json={'title': '口令', 'content': '仓库的开门口令是 ORCHID-77。'})
    agent = new_agent(client, ToolCaller('knowledge_search', {'query': '开门口令'}), '检索员',
                      bindings={'skills': [], 'knowledge': [kb['id']], 'graph': None})
    _, state = chat(client, agent, '口令是什么')
    assert state['meta']['status'] == 'completed', state['messages']
    tool = next(p for p in state['messages'][-1]['parts'] if p['kind'] == 'tool')
    assert tool['status'] == 'completed' and 'ORCHID-77' in tool['text']
    assert any('ORCHID-77' in t for batch in calls for t in batch) and ['开门口令'] in calls


def test_mixed_embedding_models_and_image_fields_rejected(client):
    provider = embedding_provider(client, 'emb-1', 'emb-2')
    a = client.post('/api/knowledge', json={'name': 'A', 'embeddingModel': f"{provider['id']}:emb-1"}).json()
    b = client.post('/api/knowledge', json={'name': 'B', 'embeddingModel': f"{provider['id']}:emb-2"}).json()
    c = client.post('/api/knowledge', json={'name': 'C'}).json()
    for pair in ([a['id'], b['id']], [a['id'], c['id']]):
        body = agent_body('混合', bindings={'skills': [], 'knowledge': pair, 'graph': None})
        result = client.post('/api/agents/validate', json=body).json()
        assert not result['ok'] and result['errors'][0]['path'] == 'bindings.knowledge'
        assert client.post('/api/agents', json=body).status_code == 400
    same = client.post('/api/agents/validate', json=agent_body('同模', bindings={'skills': [], 'knowledge': [a['id']], 'graph': None})).json()
    assert same['ok'], same
    image = agent_body('图像', models={'image': 'x:y'})
    assert client.post('/api/agents', json=image).status_code == 422
    assert not client.post('/api/agents/validate', json=image).json()['ok']


def test_startup_migration_strips_image_fields(tmp_path, monkeypatch):
    monkeypatch.setenv('AXC_SECRET_KEY', SECRET_KEY)
    host = HostService(tmp_path, FixtureModel(), seed=True)
    agent = host.agents_svc.items.get(GENERAL_ID)
    agent['models']['image'] = None
    del agent['bindings']['mcp']
    host.agents_svc.items.put(agent)
    host.db.put('provider', 'p', {'id': 'p', 'name': 'P', 'baseUrl': 'https://x', 'apiKeyEncrypted': '', 'enabled': True,
                                  'models': [{'id': 'a', 'label': '', 'type': 'image', 'vision': False, 'contextWindow': None},
                                             {'id': 'b', 'label': '', 'type': 'llm', 'vision': False, 'contextWindow': None}],
                                  'createdAt': '', 'updatedAt': ''})
    host.db.put('meta', 'schemaVersion', 1)
    asyncio.run(host.close())
    host = HostService(tmp_path, FixtureModel())
    try:
        agent = host.agents_svc.get(GENERAL_ID)
        assert set(agent['models']) == {'main', 'utility', 'vision'} and agent['bindings']['mcp'] == []
        assert [m['id'] for m in host.providers.items.get('p')['models']] == ['b']
        assert host.providers.items.get('p')['models'][0]['inputPricePer1k'] is None
    finally:
        asyncio.run(host.close())


MCP_HTTP = {'name': 'remote', 'transport': 'http', 'url': 'http://127.0.0.1:9/mcp',
            'headers': {'Authorization': 'Bearer s3cret-header', 'X-Team': 'blue-team-value'}}
MCP_STDIO = {'name': 'local-tools', 'transport': 'stdio', 'command': 'uvx', 'args': ['mcp-server-time'],
             'env': {'TOKEN': 'env-s3cret'}}


def test_mcp_crud_masking_test_and_agent_binding(client):
    remote = client.post('/api/mcp', json=MCP_HTTP).json()
    assert remote['headerKeys'] == ['Authorization', 'X-Team'] and 'headers' not in remote and remote['envKeys'] == []
    local = client.post('/api/mcp', json=MCP_STDIO).json()
    assert local['envKeys'] == ['TOKEN'] and local['args'] == ['mcp-server-time'] and 'env' not in local
    raw = json.dumps(client.host.db.items('mcp'))
    assert 's3cret' not in raw and 'blue-team-value' not in raw
    listed = json.dumps(client.get('/api/mcp').json())
    assert 's3cret' not in listed and client.get(f"/api/mcp/{remote['id']}").json()['name'] == 'remote'
    for invalid in ({**MCP_HTTP, 'name': '1bad'}, {**MCP_HTTP, 'url': 'ftp://x'}, {**MCP_STDIO, 'command': ' '}):
        assert client.post('/api/mcp', json=invalid).status_code == 422
    assert client.post('/api/mcp', json=MCP_HTTP).status_code == 409
    updated = client.put(f"/api/mcp/{remote['id']}", json={**MCP_HTTP, 'description': '改', 'headers': {'Authorization': ''}}).json()
    assert updated['headerKeys'] == ['Authorization'] and updated['description'] == '改'
    config = client.host.mcp.engine_config(client.host.mcp.items.get(remote['id']))
    assert config == {'name': 'remote', 'transport': 'http', 'url': MCP_HTTP['url'],
                      'headers': {'Authorization': 'Bearer s3cret-header'}}
    result = client.post(f"/api/mcp/{remote['id']}/test").json()
    assert result['ok'] is False and result['message'].startswith('连接失败') and result['tools'] == []
    body = agent_body('工具人', bindings={'skills': [], 'knowledge': [], 'graph': None, 'mcp': [remote['id'], local['id']]})
    validation = client.post('/api/agents/validate', json=body).json()
    assert validation['ok'], validation
    assert 'mcp:' in validation['yaml'] and 'mcp-server-time' in validation['yaml'] and 's3cret' not in validation['yaml']
    agent = client.post('/api/agents', json=body).json()
    assert 's3cret' not in client.get(f"/api/agents/{agent['id']}/export").text
    instance = client.portal.call(client.host.agent, agent['id'])
    plugin = next(p for p in instance._plugin_manager.plugins if p.name == 'mcp')
    assert plugin._servers == [config, {'name': 'local-tools', 'transport': 'stdio', 'command': 'uvx',
                                        'args': ['mcp-server-time'], 'env': {'TOKEN': 'env-s3cret'}}]
    assert 's3cret' not in (client.host.data / 'agents' / f"{agent['id']}.yaml").read_text()
    unknown = client.post('/api/agents/validate', json={**body, 'bindings': {**body['bindings'], 'mcp': ['nope']}}).json()
    assert not unknown['ok'] and unknown['errors'][0]['path'] == 'bindings.mcp'
    assert client.delete(f"/api/mcp/{local['id']}").status_code == 204
    assert client.get(f"/api/mcp/{local['id']}").status_code == 404


def test_memories_written_by_memory_plugin(client):
    agent = new_agent(client, MemoryWriter(), '记忆者', plugins={'memory': {'enabled': True, 'config': {}}})
    _, state = chat(client, agent, '请记住我的偏好')
    assert state['meta']['status'] == 'completed', state['messages']
    memories = client.get('/api/memories', params={'agentId': agent}).json()
    assert len(memories) == 1, memories
    memory = memories[0]
    assert memory['content'] == MemoryWriter.FACT and memory['agentId'] == agent and memory['source'] == 'auto_extract'
    assert set(memory) == {'id', 'agentId', 'layer', 'content', 'factType', 'importance', 'source', 'accessCount',
                           'createdAt', 'lastAccessedAt'}
    assert memory['importance'] == 0.9 and memory['layer'] == 'semantic'
    assert client.get('/api/memories', params={'agentId': GENERAL_ID}).json() == []
    assert len(client.get('/api/memories').json()) == 1
    assert client.delete(f"/api/memories/{quote(memory['id'], safe='')}").status_code == 204
    assert client.get('/api/memories').json() == []
    assert client.delete(f"/api/memories/{quote(memory['id'], safe='')}").status_code == 404


def test_analytics_reports_and_filters(client):
    provider = client.post('/api/providers', json={'name': 'Priced', 'baseUrl': 'https://p.example/v1', 'apiKey': 'k', 'models': [
        {'id': 'm', 'inputPricePer1k': 1.0, 'outputPricePer1k': 2.0}]}).json()
    ref = f"{provider['id']}:m"
    priced = new_agent(client, FixtureModel(), '计价', models={'main': ref})
    for text in ('第一次', '第二次'):
        chat(client, priced, text)
    broken = new_agent(client, ToolCaller(*DANGEROUS), '坏工具')
    chat(client, broken, '清理')
    failing = new_agent(client, Failing(), '失败者')
    _, state = chat(client, failing, '会失败')
    assert state['meta']['status'] == 'failed'
    old = datetime.now(timezone.utc) - timedelta(days=90)
    client.host.runs.record(dict(id='old', agentId=priced, conversationId='c', task='旧', success=True, error='', toolCalls=[],
                                 inputTokens=1000, outputTokens=1000, durationMs=1, model=ref, createdAt=old.isoformat()))

    failures = client.get('/api/analytics/failures').json()
    assert set(failures) == {'records', 'categoryCounts', 'clusters'} and failures['records'] == 2
    by_tool = {c['examples'][0]['toolName']: c for c in failures['clusters']}
    assert by_tool['shell']['category'] == 'tool' and by_tool['shell']['agents'] == [broken]
    assert by_tool['']['category'] == 'timeout' and by_tool['']['examples'][0]['task'] == '会失败'
    assert set(by_tool['shell']['examples'][0]) == {'id', 'agentId', 'message', 'task', 'toolName'}
    assert client.get('/api/analytics/failures', params={'agentId': priced}).json()['records'] == 0

    distill = client.get('/api/analytics/distill').json()
    assert set(distill) == {'traces', 'rules', 'toolPreferences', 'antiPatterns', 'skillCandidates'}
    assert distill['traces'] == 4 and distill['antiPatterns'] and set(distill['antiPatterns'][0]) == {'text', 'confidence', 'evidence'}
    assert client.get('/api/analytics/distill', params={'days': 365}).json()['traces'] == 5

    cost = client.get('/api/analytics/cost', params={'agentId': priced}).json()
    assert set(cost) == {'samples', 'totalCost', 'totalTokens', 'unpricedSamples', 'byAgent', 'byModel', 'findings'}
    runs = client.host.runs.query(priced, 30)
    expected = sum(r['inputTokens'] / 1000 * 1.0 + r['outputTokens'] / 1000 * 2.0 for r in runs)
    assert cost['samples'] == 2 and cost['unpricedSamples'] == 0 and cost['totalCost'] == pytest.approx(expected)
    assert cost['byModel'] == {ref: cost['totalCost']} and cost['findings'][0]['evidence']
    everything = client.get('/api/analytics/cost').json()
    assert everything['samples'] == 4 and everything['unpricedSamples'] == 2
    assert client.get('/api/analytics/cost', params={'days': 0}).status_code == 422


def test_eval_review_and_report(client):
    task = client.post('/api/evals', json={'name': '标注', 'agentId': GENERAL_ID}).json()
    base = f"/api/evals/{task['id']}"
    passing = client.post(f'{base}/cases', json={'input': '你好', 'expectedOutput': '真实引擎'}).json()
    failing = client.post(f'{base}/cases', json={'input': '你好|再见', 'expectedOutput': '不会出现'}).json()
    client.post(f'{base}/run')
    done = wait(lambda: client.get(base).json(), lambda t: t['status'] != 'running')
    assert done['passRate'] == 0.5 and done['avgScore'] == 5.0
    reviewed = client.put(f"{base}/results/{failing['id']}", json={'manualPassed': True, 'note': '语义正确'}).json()
    assert reviewed['manualPassed'] is True and reviewed['note'] == '语义正确' and reviewed['passed'] is False
    after = client.get(base).json()
    assert after['passRate'] == 1.0 and after['avgScore'] == 5.0
    client.put(f"{base}/results/{passing['id']}", json={'manualPassed': False, 'note': ''})
    assert client.get(base).json()['passRate'] == 0.5
    assert client.put(f'{base}/results/missing', json={'manualPassed': None, 'note': ''}).status_code == 404
    assert client.put(f"{base}/results/{passing['id']}", json={'note': 'x'}).status_code == 422
    report = client.get(f'{base}/report')
    assert report.status_code == 200 and report.headers['content-type'].startswith('text/markdown')
    assert 'attachment' in report.headers['content-disposition']
    text = report.text
    assert '# 评估报告：标注' in text and '评估报告: 2 用例' in text and '通过: 1, 失败: 1' in text
    assert '语义正确' in text and '你好\\|再见' in text and '通过率（含人工标注）：50%' in text


def test_openai_clients_request_usage_and_embeddings():
    import httpx
    from server.models import EmbeddingClient, openai_client
    chat_client = openai_client('https://llm.example/v1', 'k', 'm')
    messages = [{'role': 'user', 'content': 'hi'}]
    assert chat_client._build_payload(messages, include_usage=True)['stream_options'] == {'include_usage': True}
    assert 'stream_options' not in chat_client._build_payload(messages)
    seen = {}

    def handler(request):
        seen.update(url=str(request.url), auth=request.headers['authorization'], body=json.loads(request.content))
        return httpx.Response(200, json={'data': [{'index': 1, 'embedding': [0.0, 1.0]}, {'index': 0, 'embedding': [1.0, 0.0]}]})
    embedder = EmbeddingClient('https://emb.example/v1/', 'key-1', 'emb-1')
    embedder.client = httpx.AsyncClient(base_url='https://emb.example/v1/', headers={'Authorization': 'Bearer key-1'},
                                        transport=httpx.MockTransport(handler))
    assert asyncio.run(embedder.embed(['a', 'b'])) == [[1.0, 0.0], [0.0, 1.0]]
    assert seen == {'url': 'https://emb.example/v1/embeddings', 'auth': 'Bearer key-1',
                    'body': {'model': 'emb-1', 'input': ['a', 'b']}}
