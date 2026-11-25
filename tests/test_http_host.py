import time
from fastapi.testclient import TestClient
from server.app import create_app
from server.services.resources import HostService
from server.services.seed import GENERAL_ID, PLANNER_ID
from server.models import FixtureModel

SCOPE='{"key":"local"}'
def test_http_command_validation_scope_and_persistence(tmp_path):
    host=HostService(tmp_path,FixtureModel(),seed=True)
    with TestClient(create_app(host)) as client:
        assert client.get('/api/catalog',params={'scope':SCOPE}).status_code==200
        assert client.get('/api/catalog',params={'scope':SCOPE},headers={'origin':'https://untrusted.example'}).status_code==403
        meta=client.post('/api/conversation',json={'scope':{'key':'local'},'agentId':GENERAL_ID}).json()
        path='/api/conversation/'+meta['id']
        assert client.post(path,params={'scope':SCOPE},json={'type':'send'}).status_code==400
        response=client.post(path,params={'scope':SCOPE},json={'type':'send','requestId':'r','text':'HTTP 中文','attachments':[],'mode':'send'})
        assert response.status_code==200
        for _ in range(200):
            state=client.get(path,params={'scope':SCOPE}).json()
            if state['meta']['status']!='running':
                break
            time.sleep(.01)
        assert state['meta']['status']=='completed'
        assert len(state['messages'])==2
        listing=client.get('/api/conversation',params={'scope':SCOPE,'filter':'{"keyword":"HTTP"}'}).json()
        assert len(listing)==1
        assert client.post(path,params={'scope':SCOPE},json={'type':'unknown'}).status_code==422
        # Conversations must be archived before they can be deleted. / 会话须先归档再删除。
        assert client.post(path,params={'scope':SCOPE},json={'type':'delete'}).status_code==400
        assert client.post(path,params={'scope':SCOPE},json={'type':'archive'}).status_code==200
        archived=client.get(path,params={'scope':SCOPE}).json()['meta']
        assert archived['archived'] is True and archived['capabilities']['delete'] is True
        assert client.post(path,params={'scope':SCOPE},json={'type':'unarchive'}).status_code==200
        assert client.get(path,params={'scope':SCOPE}).json()['meta']['capabilities']['delete'] is False
        assert client.post(path,params={'scope':SCOPE},json={'type':'archive'}).status_code==200
        assert client.post(path,params={'scope':SCOPE},json={'type':'delete'}).status_code==200
        assert client.get(path,params={'scope':SCOPE}).status_code==400

def test_simulation_form_http_parity(tmp_path):
    host=HostService(tmp_path,FixtureModel(),seed=True)
    d=dict(name='任务',mode='redblue',objective='目标',topic='议题',background='',persona='',agents=[GENERAL_ID,PLANNER_ID],maxRounds=1,maxSteps=200,redObjective='红',blueObjective='蓝')
    with TestClient(create_app(host)) as client:
        for invalid in ({**d,'agents':[GENERAL_ID]},{**d,'agents':[GENERAL_ID,GENERAL_ID]},{**d,'maxSteps':201},{**d,'redObjective':''}):
            assert client.post('/api/simulation',json={'scope':{'key':'local'},'definition':invalid}).status_code==422
        m=client.post('/api/simulation',json={'scope':{'key':'local'},'definition':d}).json()
        assert m['definition']==d
        changed=client.post('/api/simulation',json={'scope':{'key':'local'},'id':m['id'],'definition':{**d,'name':'修改'}}).json()
        assert changed['title']=='修改'
        assert client.get('/api/simulation',params={'scope':SCOPE,'filter':'{"mode":"debate"}'}).json()==[]
        assert client.get('/api/simulation/'+m['id'],params={'scope':SCOPE}).json()['report'] is None

def test_list_filters_and_edit_permissions(tmp_path):
    host = HostService(tmp_path, FixtureModel(), db=':memory:', seed=True)
    with TestClient(create_app(host)) as client:
        chat = client.post('/api/conversation', json={'scope': {'key': 'local'}, 'agentId': GENERAL_ID}).json()
        for filters in ['{"keyword":"不存在"}', '{"agentId":"'+PLANNER_ID+'"}', '{"status":"completed"}']:
            assert client.get('/api/conversation', params={'scope': SCOPE, 'filter': filters}).json() == []
        other_topic = '{"key":"topic:2","shortcut":{"shortcut_key":"example.topic","context":{"topic_id":2}}}'
        assert client.get('/api/conversation', params={'scope': other_topic, 'filter': '{}'}).json() == []
        d = dict(name='任务', mode='discussion', objective='目标', topic='议题', background='', persona='', agents=[GENERAL_ID], maxRounds=1, maxSteps=1, redObjective='', blueObjective='')
        m = client.post('/api/simulation', json={'scope': {'key': 'local'}, 'definition': d}).json()
        host.meta('simulation:' + m['id'], status='completed')
        assert client.post('/api/simulation', json={'scope': {'key': 'local'}, 'id': m['id'], 'definition': d}).status_code == 400
