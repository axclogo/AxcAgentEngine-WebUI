"""Management API (docs/API.zh-CN.md) end to end in fixture mode. / 管理端 API 端到端测试（fixture 模式）。"""
import io
import json
import time
import zipfile
import httpx
import pytest
from axc_agent_engine import LLMStreamChunk
from fastapi.testclient import TestClient
from server.app import create_app
from server.models import FixtureModel
from server.services.resources import HostService
from server.services.seed import GENERAL_ID, PLANNER_ID

SCOPE = '{"key":"local"}'


class GraphCaller(FixtureModel):
    """Calls graph_search once (with a thinking delta), then answers. / 先思考并调用图谱工具，再作答。"""

    def __init__(self):
        self.seen = []

    async def stream(self, messages, tools=None, **options):
        self.seen.append(json.dumps(messages, ensure_ascii=False, default=str))
        if any(m.get('role') == 'tool' for m in messages):
            async for chunk in super().stream(messages, tools, **options):
                yield chunk
            return
        yield LLMStreamChunk(thinking_delta='先查图谱')
        yield LLMStreamChunk(tool_call_delta={'index': 0, 'id': 'call_1', 'type': 'function', 'function': {
            'name': 'graph_search', 'arguments': json.dumps({'query': '织女星'})}}, finish_reason='tool_calls')


class Recording(FixtureModel):
    """Fixture model that records every prompt it receives. / 记录收到的提示词。"""

    def __init__(self):
        self.seen = []

    async def stream(self, messages, tools=None, **options):
        self.seen.append(json.dumps(messages, ensure_ascii=False, default=str))
        async for chunk in super().stream(messages, tools, **options):
            yield chunk


@pytest.fixture
def model():
    return Recording()


@pytest.fixture
def client(tmp_path, model, monkeypatch):
    monkeypatch.setenv('AXC_SECRET_KEY', 'suqzeVCj3y0XqPUlSGllxZTTFFdHAQX49Qh3-MuKHMs=')
    host = HostService(tmp_path, model, seed=True)
    with TestClient(create_app(host)) as c:
        c.host = host
        yield c


def agent_body(name, **extra):
    return {'name': name, 'strategy': 'react', 'runtime': {}, 'models': {}, 'plugins': {},
            'bindings': {'skills': [], 'knowledge': [], 'graph': None}, **extra}


def wait(fn, done, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if done(value):
            return value
        time.sleep(0.02)
    raise AssertionError(f'timeout: {value}')


def chat(client, agent_id, text, attachments=(), conv=None):
    if conv is None:
        conv = client.post('/api/conversation', json={'scope': {'key': 'local'}, 'agentId': agent_id}).json()['id']
    path = f'/api/conversation/{conv}'
    body = {'type': 'send', 'requestId': f'r-{time.time_ns()}', 'text': text, 'attachments': list(attachments), 'mode': 'send'}
    response = client.post(path, params={'scope': SCOPE}, json=body)
    assert response.status_code == 200, response.text
    state = wait(lambda: client.get(path, params={'scope': SCOPE}).json(), lambda s: s['meta']['status'] != 'running')
    return conv, state


def test_provider_keys_are_encrypted_masked_and_kept(client, monkeypatch):
    body = {'name': 'OpenAI', 'baseUrl': 'https://api.example.com/v1/', 'apiKey': 'sk-secret-abcd',
            'models': [{'id': 'gpt-x'}, {'id': 'vis', 'vision': True}, {'id': 'emb', 'type': 'embedding', 'inputPricePer1k': 0.1}]}
    created = client.post('/api/providers', json=body).json()
    assert created['apiKeyMasked'] == 'sk-••••abcd' and created['hasKey'] and 'apiKey' not in created
    assert created['baseUrl'] == 'https://api.example.com/v1'
    assert created['models'][0] == {'id': 'gpt-x', 'label': '', 'type': 'llm', 'vision': False, 'contextWindow': None,
                                    'inputPricePer1k': None, 'outputPricePer1k': None}
    assert created['models'][2]['inputPricePer1k'] == 0.1
    raw = json.dumps(client.host.db.items('provider'))
    assert 'sk-secret-abcd' not in raw
    listed = client.get('/api/providers').json()
    assert [p['apiKeyMasked'] for p in listed] == ['sk-••••abcd']
    updated = client.put(f"/api/providers/{created['id']}", json={**body, 'name': '改名', 'apiKey': ''}).json()
    assert updated['name'] == '改名' and updated['hasKey'] and updated['apiKeyMasked'] == 'sk-••••abcd'
    assert client.host.providers.api_key(created['id']) == 'sk-secret-abcd'
    for invalid in ({**body, 'baseUrl': 'not a url'}, {**body, 'name': ' '}, {**body, 'models': [{'id': 'a'}, {'id': 'a'}]},
                    {**body, 'models': [{'id': 'a', 'type': 'video'}]}, {**body, 'models': [{'id': 'a', 'type': 'image'}]},
                    {**body, 'models': [{'id': 'a', 'inputPricePer1k': -1}]}):
        response = client.post('/api/providers', json=invalid)
        assert response.status_code == 422 and response.json()['error']

    seen = {}

    def handler(request):
        seen['auth'] = request.headers.get('authorization')
        seen['url'] = str(request.url)
        return httpx.Response(200, json={'data': [{'id': 'm2'}, {'id': 'm1'}]})
    real = httpx.AsyncClient
    monkeypatch.setattr('server.services.providers.httpx.AsyncClient',
                        lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    result = client.post('/api/providers/test', json={'id': created['id'], 'baseUrl': 'https://api.example.com/v1'}).json()
    assert result['ok'] and result['models'] == ['m1', 'm2']
    assert seen == {'auth': 'Bearer sk-secret-abcd', 'url': 'https://api.example.com/v1/models'}
    assert 'sk-secret' not in json.dumps(result)
    monkeypatch.setattr('server.services.providers.httpx.AsyncClient',
                        lambda **kw: real(transport=httpx.MockTransport(lambda r: httpx.Response(401)), **kw))
    failed = client.post('/api/providers/test', json={'baseUrl': 'https://x.example', 'apiKey': 'k'}).json()
    assert failed == {'ok': False, 'message': '服务返回 HTTP 401', 'models': []}
    assert client.delete(f"/api/providers/{created['id']}").status_code == 204
    assert client.delete(f"/api/providers/{created['id']}").status_code == 404


def test_agent_crud_validate_export_and_model_status(client):
    agent = client.post('/api/agents', json=agent_body('测试员', avatar='🧪')).json()
    assert agent['modelStatus'] == 'unset' and agent['avatar'] == '🧪' and agent['runtime']['maxRounds'] == 20
    assert client.post('/api/agents', json=agent_body('测试员')).status_code == 409
    assert client.post('/api/agents', json=agent_body(' ')).status_code == 422
    assert client.post('/api/agents', json=agent_body('x', plugins={'nope': {'enabled': True, 'config': {}}})).status_code == 400
    provider = client.post('/api/providers', json={'name': 'P', 'baseUrl': 'http://127.0.0.1:9/v1', 'apiKey': 'k',
                                                   'models': [{'id': 'main'}]}).json()
    ref = f"{provider['id']}:main"
    updated = client.put(f"/api/agents/{agent['id']}", json=agent_body('测试员', models={'main': ref})).json()
    assert updated['modelStatus'] == 'ok' and updated['createdAt'] == agent['createdAt']
    assert client.put(f"/api/agents/{agent['id']}", json=agent_body('通用助手')).status_code == 409
    client.delete(f"/api/providers/{provider['id']}")
    assert client.get(f"/api/agents/{agent['id']}").json()['modelStatus'] == 'missing'

    ok = client.post('/api/agents/validate', json=agent_body('校验', strategy='por', runtime={'stepTimeout': 1.5},
                                                             plugins={'safety': {'enabled': True, 'config': {}}})).json()
    assert ok['ok'] and ok['errors'] == []
    assert 'strategy: por' in ok['yaml'] and 'step_timeout: 2' in ok['yaml'] and 'safety' in ok['yaml']
    bad = client.post('/api/agents/validate', json={**agent_body(''), 'runtime': {'maxRounds': 0}}).json()
    assert not bad['ok'] and {e['path'] for e in bad['errors']} == {'name', 'runtime.maxRounds'}
    engine_bad = client.post('/api/agents/validate', json=agent_body('坏', plugins={'por': {'enabled': True, 'config': {'mode': 'bogus'}}},
                                                                     strategy='por')).json()
    assert not engine_bad['ok'] and engine_bad['errors'][0]['path'] == 'plugins'

    export = client.get(f'/api/agents/{GENERAL_ID}/export')
    assert export.headers['content-type'].startswith('text/yaml') and 'attachment' in export.headers['content-disposition']
    assert 'name: 通用助手' in export.text and 'skill:' in export.text and 'graph:' in export.text
    assert client.delete(f"/api/agents/{agent['id']}").status_code == 204
    assert client.get(f"/api/agents/{agent['id']}").status_code == 404


def test_catalog_only_lists_enabled_agents(client):
    names = [a['name'] for a in client.get('/api/catalog', params={'scope': SCOPE}).json()['agents']]
    assert names == ['通用助手', '规划助手']
    planner = client.get(f'/api/agents/{PLANNER_ID}').json()
    client.put(f'/api/agents/{PLANNER_ID}', json={**planner, 'enabled': False})
    catalog = client.get('/api/catalog', params={'scope': SCOPE}).json()
    assert catalog['agents'] == [{'id': GENERAL_ID, 'name': '通用助手', 'avatar': '🤖'}]
    assert catalog['defaultAgentId'] == GENERAL_ID and catalog['create'] and catalog['createSimulation']
    assert client.post('/api/conversation', json={'scope': {'key': 'local'}, 'agentId': PLANNER_ID}).status_code == 400


def zip_bytes(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return buffer.getvalue()


SKILL_MD = '---\nname: {name}\ndescription: 导入的技能\nwhen_to_use: 测试\ntrigger_keywords: [导入]\n---\n\n按步骤执行。\n'


def test_skills_create_import_and_reject_traversal(client):
    created = client.post('/api/skills', json={'name': 'review', 'instructions': '检查代码', 'triggerKeywords': ['审查']}).json()
    text = (client.host.skills.dir(created['id']) / 'SKILL.md').read_text()
    assert 'name: review' in text and 'trigger_keywords:' in text and '检查代码' in text
    assert client.post('/api/skills', json={'name': 'review', 'instructions': 'x'}).status_code == 409
    assert client.post('/api/skills', json={'name': 'a b', 'instructions': 'x'}).status_code == 422
    assert client.post('/api/skills', json={'name': 'ok', 'instructions': ' '}).status_code == 422

    archive = zip_bytes({'pkg/SKILL.md': SKILL_MD.format(name='zipped'), 'pkg/scripts/run.py': 'print(1)'})
    imported = client.post('/api/skills/import', files={'file': ('skill.zip', archive, 'application/zip')}).json()
    assert imported['name'] == 'zipped' and imported['whenToUse'] == '测试' and imported['triggerKeywords'] == ['导入']
    assert imported['instructions'] == '按步骤执行。'
    assert (client.host.skills.dir(imported['id']) / 'scripts' / 'run.py').read_text() == 'print(1)'
    plain = client.post('/api/skills/import', files={'file': ('SKILL.md', SKILL_MD.format(name='plain').encode(), 'text/markdown')})
    assert plain.status_code == 200 and plain.json()['name'] == 'plain'
    for evil in ({'SKILL.md': SKILL_MD.format(name='evil'), '../escape.txt': 'x'},
                 {'SKILL.md': SKILL_MD.format(name='evil'), '/abs.txt': 'x'}):
        response = client.post('/api/skills/import', files={'file': ('evil.zip', zip_bytes(evil), 'application/zip')})
        assert response.status_code == 400 and '非法路径' in response.json()['error']
    assert client.post('/api/skills/import', files={'file': ('x.md', b'no frontmatter', 'text/markdown')}).status_code == 400
    big = client.post('/api/skills/import', files={'file': ('big.md', b'x' * (5 * 1024 * 1024 + 1), 'text/markdown')})
    assert big.status_code == 400
    assert not (client.host.data / 'escape.txt').exists()
    updated = client.put(f"/api/skills/{created['id']}", json={'name': 'review', 'instructions': '新指令'}).json()
    assert updated['instructions'] == '新指令'
    assert client.delete(f"/api/skills/{created['id']}").status_code == 204
    assert not client.host.skills.dir(created['id']).exists()


def test_knowledge_documents(client):
    kb = client.post('/api/knowledge', json={'name': '手册'}).json()
    assert kb['documentCount'] == 0 and kb['totalBytes'] == 0
    path = f"/api/knowledge/{kb['id']}/documents"
    uploaded = client.post(path, files={'file': ('../../指南.md', '# 指南\n内容'.encode(), 'text/markdown')}).json()
    assert uploaded['title'] == '指南.md' and uploaded['contentType'] == 'text/markdown'
    text = client.post(path, json={'title': '笔记', 'content': '纯文本'}).json()
    assert text['title'] == '笔记' and set(text) == {'id', 'title', 'size', 'contentType', 'createdAt'}
    assert client.post(path, files={'file': ('a.exe', b'MZ', 'application/octet-stream')}).status_code == 400
    assert client.post(path, json={'title': ' ', 'content': 'x'}).status_code == 400
    assert len(client.get(path).json()) == 2
    info = client.get(f"/api/knowledge/{kb['id']}").json()
    assert info['documentCount'] == 2 and info['totalBytes'] == len('# 指南\n内容'.encode()) + len('纯文本'.encode())
    download = client.get(f"{path}/{uploaded['id']}")
    assert download.status_code == 200 and download.content == '# 指南\n内容'.encode()
    assert client.delete(f"{path}/{uploaded['id']}").status_code == 204
    assert client.get(f"{path}/{uploaded['id']}").status_code == 404
    assert [d['id'] for d in client.get(path).json()] == [text['id']]
    assert client.delete(f"/api/knowledge/{kb['id']}").status_code == 204
    assert client.get(path).status_code == 404


def test_graph_crud_import_persistence_and_agent_mount(client, tmp_path):
    graph = client.post('/api/graphs', json={'name': '星图', 'entityTypes': ['star']}).json()
    base = f"/api/graphs/{graph['id']}"
    sun = client.post(f'{base}/entities', json={'name': '天狼星', 'type': 'star', 'description': '最亮的恒星'}).json()
    again = client.post(f'{base}/entities', json={'name': '天狼星', 'type': 'star', 'aliases': ['Sirius']}).json()
    assert again['id'] == sun['id'] and again['aliases'] == ['Sirius']
    rel = client.post(f'{base}/relations', json={'source': sun['id'], 'target': '大犬座', 'relationType': 'IN'}).json()
    assert rel['sourceName'] == '天狼星' and rel['targetName'] == '大犬座' and rel['relationType'] == 'IN'
    assert client.post(f'{base}/relations', json={'source': '', 'target': 'x', 'relationType': 'R'}).status_code == 422
    jsonl = '\n'.join(json.dumps(x, ensure_ascii=False) for x in [
        {'id': 'e1', 'name': '织女星', 'type': 'star'}, {'id': 'e2', 'name': '天琴座'},
        {'source_id': 'e1', 'target_id': 'e2', 'relation_type': 'IN'}])
    data = client.post(f'{base}/import', files={'file': ('g.jsonl', jsonl.encode(), 'application/jsonl')}).json()
    assert {e['name'] for e in data['entities']} >= {'织女星', '天琴座', '天狼星'} and len(data['relations']) == 2
    doc = {'entities': [{'name': '牛郎星', 'type': 'star'}], 'relations': [{'source': '牛郎星', 'target': '织女星', 'relationType': 'FACES'}]}
    data = client.post(f'{base}/import', files={'file': ('g.json', json.dumps(doc).encode(), 'application/json')}).json()
    assert len(data['relations']) == 3
    assert client.post(f'{base}/import', files={'file': ('g.jsonl', b'{"bad": 1}', 'application/jsonl')}).status_code == 400
    assert client.get(base).json()['entityCount'] == 5
    assert client.delete(f"{base}/entities/{sun['id']}").status_code == 204
    data = client.get(f'{base}/data').json()
    assert sun['id'] not in {e['id'] for e in data['entities']} and len(data['relations']) == 2
    assert client.delete(f"{base}/relations/{data['relations'][0]['id']}").status_code == 204
    assert client.delete(f"{base}/relations/{data['relations'][0]['id']}").status_code == 404

    agent = client.post('/api/agents', json=agent_body('观星者', bindings={'skills': [], 'knowledge': [], 'graph': graph['id']})).json()
    caller = GraphCaller()
    client.host.model = caller  # Next instantiation of this new agent uses the tool-calling fixture.
    _, state = chat(client, agent['id'], '织女星在哪')
    assert state['meta']['status'] == 'completed', state['messages']
    parts = state['messages'][-1]['parts']
    assert [p['kind'] for p in parts][:2] == ['thinking', 'tool'] and parts[0]['text'] == '先查图谱'
    tool = parts[1]
    assert tool['title'] == 'graph_search' and tool['status'] == 'completed' and tool['id'].endswith(':tool:call_1')
    # The tool result comes from the store shared with the management API. / 工具结果来自共享存储。
    assert '牛郎星' in json.dumps(json.loads(tool['text']), ensure_ascii=False)
    assert 'tmp' not in json.dumps(client.get(f'{base}/data').json())
    assert len(caller.seen) >= 2 and 'graph_search' in caller.seen[1]
    # Writes through the mounted store (what graph tools do) are visible to the management API and persisted.
    client.host.graphs.store(graph['id']).upsert_entity('北极星', 'star')
    assert '北极星' in {e['name'] for e in client.get(f'{base}/data').json()['entities']}
    db_path = client.host.data / 'workbench.db'
    reopened = HostService(tmp_path / 'other', FixtureModel(), db=db_path)
    try:
        assert '北极星' in {e['name'] for e in reopened.graphs.data(graph['id'])['entities']}
    finally:
        import asyncio
        asyncio.run(reopened.close())


def test_plugin_catalog_shape(client):
    plugins = {p['name']: p for p in client.get('/api/plugins').json()}
    assert plugins['react']['kind'] == 'strategy' and plugins['por']['kind'] == 'strategy'
    assert all(plugins[n]['managed'] for n in ('skill', 'knowledge', 'graph'))
    assert not plugins['safety']['managed'] and plugins['safety']['kind'] == 'plugin'
    for plugin in plugins.values():
        assert set(plugin) == {'name', 'displayName', 'description', 'version', 'kind', 'managed', 'fields'}
        for field in plugin['fields']:
            assert set(field) == {'key', 'label', 'type', 'description', 'default', 'required', 'enum', 'children',
                                  'itemSchema', 'advanced'}
    compress = {f['key']: f for f in plugins['compress']['fields']}
    assert compress['tool_result']['type'] == 'object' and compress['tool_result']['children']


def test_eval_run_end_to_end(client):
    task = client.post('/api/evals', json={'name': '冒烟', 'agentId': GENERAL_ID}).json()
    assert task['status'] == 'idle' and task['caseCount'] == 0 and task['avgScore'] is None
    assert client.post('/api/evals', json={'name': 'x', 'agentId': 'missing'}).status_code == 404
    base = f"/api/evals/{task['id']}"
    assert client.post(f'{base}/run').status_code == 400
    passing = client.post(f'{base}/cases', json={'input': '你好', 'expectedOutput': '真实引擎'}).json()
    client.post(f'{base}/cases', json={'input': '你好', 'expectedOutput': '不会出现'})
    removable = client.post(f'{base}/cases', json={'input': '删掉'}).json()
    assert client.delete(f"{base}/cases/{removable['id']}").status_code == 204
    assert len(client.get(f'{base}/cases').json()) == 2
    started = client.post(f'{base}/run').json()
    assert started['status'] == 'running'
    done = wait(lambda: client.get(base).json(), lambda t: t['status'] != 'running')
    assert done['status'] == 'completed', done
    assert done['avgScore'] == 5.0 and done['passRate'] == 0.5 and done['caseCount'] == 2
    results = client.get(f'{base}/results').json()
    by_case = {r['caseId']: r for r in results}
    assert by_case[passing['id']]['score'] == 10 and by_case[passing['id']]['passed']
    assert '真实引擎' in by_case[passing['id']]['output']
    assert sorted(r['passed'] for r in results) == [False, True]
    assert set(results[0]) == {'caseId', 'input', 'output', 'tools', 'score', 'passed', 'reason', 'durationMs', 'error',
                               'inputTokens', 'outputTokens', 'manualPassed', 'note'}
    assert results[0]['inputTokens'] > 0 and results[0]['manualPassed'] is None and results[0]['note'] == ''


def test_chat_with_text_attachment(client, model):
    conv = client.post('/api/conversation', json={'scope': {'key': 'local'}, 'agentId': GENERAL_ID}).json()
    assert conv['parentId'] is None and conv['createdAt']
    upload = f"/api/conversation/{conv['id']}/attachments"
    att = client.post(upload, params={'scope': SCOPE}, files={'file': ('note.txt', '暗号 ZXQ-42'.encode(), 'text/plain')}).json()
    assert att['name'] == 'note.txt' and att['url'] == f"/api/attachments/{att['id']}" and att['size'] == len('暗号 ZXQ-42'.encode())
    assert client.get(att['url']).content == '暗号 ZXQ-42'.encode()
    other = client.post('/api/conversation', json={'scope': {'key': 'local'}, 'agentId': GENERAL_ID}).json()
    foreign = client.post(f"/api/conversation/{other['id']}", params={'scope': SCOPE},
                          json={'type': 'send', 'requestId': 'f', 'text': '偷用', 'attachments': [att], 'mode': 'send'})
    assert foreign.status_code == 400
    _, state = chat(client, GENERAL_ID, '读一下附件', [att], conv['id'])
    assert state['meta']['status'] == 'completed'
    user = state['messages'][0]
    assert user['role'] == 'user' and user['attachments'] == [att]
    assert any('ZXQ-42' in s for s in model.seen)
    assistant = state['messages'][-1]
    assert assistant['actor'] == '通用助手' and assistant['parts'][0]['kind'] == 'text' and not assistant['streaming']


def test_fork_records_parent_and_checkpoint_message(client):
    conv, state = chat(client, GENERAL_ID, '第一句')
    checkpoint = state['meta']['checkpoints'][-1]
    assert checkpoint['messageId'] == state['messages'][-1]['id']
    result = client.post(f'/api/conversation/{conv}', params={'scope': SCOPE}, json={'type': 'fork', 'checkpointId': checkpoint['id']}).json()
    child = result['resource']['id']
    meta = client.get(f'/api/conversation/{child}', params={'scope': SCOPE}).json()
    assert meta['meta']['parentId'] == conv and meta['messages'] == state['messages']
    listed = {m['id']: m['parentId'] for m in client.get('/api/conversation', params={'scope': SCOPE}).json()}
    assert listed[child] == conv and listed[conv] is None


def test_seed_is_idempotent_and_skippable(tmp_path, monkeypatch):
    monkeypatch.setenv('AXC_SECRET_KEY', 'suqzeVCj3y0XqPUlSGllxZTTFFdHAQX49Qh3-MuKHMs=')
    import asyncio
    host = HostService(tmp_path, FixtureModel(), seed=True)
    counts = [len(host.db.items(b)) for b in ('agent', 'skill', 'knowledge', 'graph')]
    asyncio.run(host.close())
    host = HostService(tmp_path, FixtureModel(), seed=True)
    assert [len(host.db.items(b)) for b in ('agent', 'skill', 'knowledge', 'graph')] == counts == [2, 1, 1, 1]
    asyncio.run(host.close())
    empty = HostService(tmp_path / 'empty', FixtureModel(), seed=False)
    assert empty.db.items('agent') == [] and empty.catalog({'key': 'local'})['create'] is False
    asyncio.run(empty.close())
def test_every_reply_is_forkable_and_archive_keeps_the_fork_tree(client):
    conv, state = chat(client, GENERAL_ID, '第一句')
    conv, state = chat(client, GENERAL_ID, '第二句', conv=conv)
    replies = [m['id'] for m in state['messages'] if m['role'] == 'assistant']
    anchored = {c['messageId'] for c in state['meta']['checkpoints'] if c.get('messageId')}
    assert len(replies) == 2 and set(replies) <= anchored
    first = next(c for c in state['meta']['checkpoints'] if c.get('messageId') == replies[0])
    child = client.post(f'/api/conversation/{conv}', params={'scope': SCOPE}, json={'type': 'fork', 'checkpointId': first['id']}).json()
    assert 'resource' in child, child
    child = child['resource']['id']
    child_state = client.get(f'/api/conversation/{child}', params={'scope': SCOPE}).json()
    assert child_state['messages'][-1]['id'] == replies[0]
    path = f'/api/conversation/{conv}'
    assert client.post(path, params={'scope': SCOPE}, json={'type': 'delete'}).status_code == 400
    assert client.post(path, params={'scope': SCOPE}, json={'type': 'archive'}).status_code == 200
    listed = {m['id']: m for m in client.get('/api/conversation', params={'scope': SCOPE}).json()}
    assert listed[conv]['archived'] and listed[child]['archived'] and listed[child]['parentId'] == conv
    assert listed[conv]['archivedAt']
    assert client.post(path, params={'scope': SCOPE}, json={'type': 'unarchive'}).status_code == 200
    listed = {m['id']: m for m in client.get('/api/conversation', params={'scope': SCOPE}).json()}
    assert not listed[conv]['archived'] and not listed[child]['archived']
