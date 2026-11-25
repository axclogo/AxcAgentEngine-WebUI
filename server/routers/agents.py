from fastapi import APIRouter, Request, Response
from ..schemas import AgentInput
from . import host_of

router = APIRouter(prefix='/api/agents', tags=['agents'])


@router.get('')
async def list_agents(request: Request):
    return host_of(request).agents_svc.list()


@router.post('')
async def create_agent(request: Request, body: AgentInput):
    return host_of(request).agents_svc.save(body)


@router.post('/validate')
async def validate_agent(request: Request):
    try:
        raw = await request.json()
    except ValueError:
        raw = None
    return await host_of(request).agents_svc.validate(raw)


@router.get('/{ident}')
async def get_agent(request: Request, ident: str):
    return host_of(request).agents_svc.get(ident)


@router.put('/{ident}')
async def update_agent(request: Request, ident: str, body: AgentInput):
    return host_of(request).agents_svc.save(body, ident)


@router.delete('/{ident}', status_code=204)
async def delete_agent(request: Request, ident: str):
    host = host_of(request)
    host.agents_svc.items.get(ident)
    if host.busy(ident):
        raise ValueError('Agent 正在运行，无法删除')
    await host.unload_agent(ident)
    host.agents_svc.delete(ident)
    return Response(status_code=204)


@router.get('/{ident}/export')
async def export_agent(request: Request, ident: str):
    svc = host_of(request).agents_svc
    row = svc.items.get(ident)
    return Response(svc.yaml_text(row), media_type='text/yaml; charset=utf-8',
                    headers={'Content-Disposition': f'attachment; filename="agent-{ident}.yaml"'})
