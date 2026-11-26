from fastapi import APIRouter, Request, Response
from . import host_of
router = APIRouter(prefix='/api/memories', tags=['memories'])
@router.get('')
async def list_memories(request: Request, agentId: str | None = None):
    return await host_of(request).memories.list(agentId)
@router.delete('/{ident:path}', status_code=204)
async def delete_memory(request: Request, ident: str):
    await host_of(request).forget(ident)
    return Response(status_code=204)
