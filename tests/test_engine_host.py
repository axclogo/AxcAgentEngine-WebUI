import asyncio
import pytest
from server.services.resources import HostService
from server.services.seed import GENERAL_ID, PLANNER_ID
from server.models import FixtureModel, Definition, MODES

SCOPE = {'key': 'local'}
def definition(mode):
    return dict(name=mode,mode=mode,objective='测试目标',topic='测试议题',background='',persona='',agents=[GENERAL_ID,PLANNER_ID] if MODES[mode] == 2 else [GENERAL_ID],maxRounds=1,maxSteps=1,redObjective='红方',blueObjective='蓝方')

@pytest.mark.asyncio
async def test_chat_persistence_fork_and_receipt(tmp_path):
    path = str(tmp_path/'host.db')
    host = HostService(tmp_path,FixtureModel(),db=path,seed=True)
    try:
        m=host.create('conversation',SCOPE,GENERAL_ID)
        command=dict(type='send',mode='send',requestId='once',text='你好',attachments=[])
        await host.command('conversation',m['id'],SCOPE,command)
        await host.tasks['conversation:'+m['id']]
        await host.command('conversation',m['id'],SCOPE,command)
        state=host.snapshot('conversation',m['id'],SCOPE)
        assert state['meta']['status']=='completed'
        assert len(state['messages'])==2
        assert '真实引擎' in state['messages'][1]['text']
        cp=state['meta']['checkpoints'][-1]['id']
        result=await host.command('conversation',m['id'],SCOPE,dict(type='fork',checkpointId=cp))
        child=result['resource']['id']
        assert child!=m['id']
        await host.command('conversation',child,SCOPE,dict(type='resume'))
        await host.tasks['conversation:'+child]
        assert host.snapshot('conversation',child,SCOPE)['meta']['status']=='completed'
        assert host.snapshot('conversation',m['id'],SCOPE)['messages']==state['messages']
    finally:
        await host.close()
    host=HostService(tmp_path,FixtureModel(),db=path)
    try:
        assert host.snapshot('conversation',m['id'],SCOPE)['messages']==state['messages']
    finally:
        await host.close()

@pytest.mark.asyncio
@pytest.mark.parametrize('mode',MODES)
async def test_real_engine_ten_modes(mode,tmp_path):
    host=HostService(tmp_path,FixtureModel(),db=':memory:',seed=True)
    try:
        d=Definition(**definition(mode)).model_dump()
        m=host.create('simulation',SCOPE,definition=d)
        await host.command('simulation',m['id'],SCOPE,dict(type='start'))
        await asyncio.wait_for(host.tasks['simulation:'+m['id']],10)
        state=host.snapshot('simulation',m['id'],SCOPE)
        assert state['meta']['status']=='completed',state['messages']
        assert any(msg['role']=='assistant' for msg in state['messages']),state['messages']
        result=await host.command('simulation',m['id'],SCOPE,dict(type='interview',requestId='interview',target='all',question='结论是什么'))
        assert result['events'][0]['value']['kind']=='interview'
        again=await host.command('simulation',m['id'],SCOPE,dict(type='interview',requestId='interview',target='all',question='结论是什么'))
        assert again==result
        assert host.snapshot('simulation',m['id'],SCOPE)['report'] is None
        await host.command('simulation',m['id'],SCOPE,dict(type='generateReport'))
        assert '# '+mode in host.snapshot('simulation',m['id'],SCOPE)['report']
    finally:
        await host.close()

@pytest.mark.asyncio
async def test_topic_scope_and_rejected_commands(tmp_path):
    host=HostService(tmp_path,FixtureModel(),db=':memory:',seed=True)
    topic={'key':'arbitrary','shortcut':{'shortcut_key':'example.topic','context':{'topic_id':1}}}
    try:
        m=host.create('conversation',topic,GENERAL_ID)
        assert not host.snapshot('conversation',m['id'],SCOPE)['meta']['capabilities']['send']
        with pytest.raises(ValueError,match='动作不可用'):
            await host.command('conversation',m['id'],SCOPE,dict(type='send',mode='send',requestId='r',text='x',attachments=[]))
        assert host.snapshot('conversation',m['id'],topic)['meta']['status']=='idle'
        with pytest.raises(ValueError,match='范围'):
            host.snapshot('conversation',m['id'],{'key':'b','shortcut':{'shortcut_key':'example.topic','context':{'topic_id':2}}})
    finally:
        await host.close()

@pytest.mark.asyncio
async def test_por_live_inputs_stop_resume_and_parallel_steps(tmp_path):
    class Paused(FixtureModel):
        def __init__(self):
            self.entered=asyncio.Event()
            self.release=asyncio.Event()
        async def stream(self,messages,tools=None,**options):
            self.entered.set()
            await self.release.wait()
            async for chunk in super().stream(messages,tools,**options):
                yield chunk
    model=Paused()
    host=HostService(tmp_path,model,db=':memory:',seed=True)
    try:
        m=host.create('conversation',SCOPE,PLANNER_ID)
        await host.command('conversation',m['id'],SCOPE,dict(type='send',mode='send',requestId='root',text='并发任务',attachments=[]))
        await asyncio.wait_for(model.entered.wait(),5)
        for ident,text in [('one','先看中文'),('two','再看英文')]:
            await host.command('conversation',m['id'],SCOPE,dict(type='send',mode='insert',requestId=ident,text=text,attachments=[]))
        state=host.snapshot('conversation',m['id'],SCOPE)
        assert [q['id'] for q in state['queue']]==['one','two']
        assert len([a for a in state['activities'] if a['kind']=='step'])>=2
        await host.command('conversation',m['id'],SCOPE,dict(type='stop'))
        model.release.set()
        await asyncio.wait_for(host.tasks['conversation:'+m['id']],5)
        stopped=host.snapshot('conversation',m['id'],SCOPE)
        assert stopped['meta']['status']=='cancelled'
        assert stopped['meta']['capabilities']['resume']
        await host.command('conversation',m['id'],SCOPE,dict(type='resume'))
        await asyncio.wait_for(host.tasks['conversation:'+m['id']],5)
        assert host.snapshot('conversation',m['id'],SCOPE)['meta']['status']=='completed'
    finally:
        await host.close()

@pytest.mark.asyncio
async def test_simulation_pause_resume_stop_and_error(tmp_path):
    host=HostService(tmp_path,FixtureModel(),db=':memory:',seed=True)
    try:
        m=host.create('simulation',SCOPE,definition=definition('group_chat'))
        await host.command('simulation',m['id'],SCOPE,dict(type='start'))
        await host.command('simulation',m['id'],SCOPE,dict(type='pause'))
        assert host.snapshot('simulation',m['id'],SCOPE)['meta']['status']=='paused'
        await host.command('simulation',m['id'],SCOPE,dict(type='resume'))
        await asyncio.sleep(.01)
        await host.command('simulation',m['id'],SCOPE,dict(type='stop'))
        await asyncio.gather(host.tasks['simulation:'+m['id']],return_exceptions=True)
        assert host.snapshot('simulation',m['id'],SCOPE)['meta']['status']=='cancelled'
    finally:
        await host.close()

@pytest.mark.asyncio
async def test_real_engine_failures_never_become_completed(tmp_path):
    class Broken(FixtureModel):
        async def chat(self,*args,**kwargs):
            raise ValueError('模型拒绝')
        async def stream(self,*args,**kwargs):
            raise ValueError('流式模型拒绝')
            yield
    host=HostService(tmp_path,Broken(),db=':memory:',seed=True)
    try:
        m=host.create('conversation',SCOPE,GENERAL_ID)
        await host.command('conversation',m['id'],SCOPE,dict(type='send',mode='send',requestId='r',text='错误路径',attachments=[]))
        await host.tasks['conversation:'+m['id']]
        assert host.snapshot('conversation',m['id'],SCOPE)['meta']['status']=='failed'
        m=host.create('simulation',SCOPE,definition=definition('discussion'))
        await host.command('simulation',m['id'],SCOPE,dict(type='start'))
        await host.tasks['simulation:'+m['id']]
        assert host.snapshot('simulation',m['id'],SCOPE)['meta']['status']=='failed'
    finally:
        await host.close()
