from fastapi import APIRouter, Request, Response
from ..schemas import McpInput
from . import host_of
router = APIRouter(prefix='/api/mcp', tags=['mcp'])
@router.get('')
async def list_mcp(request: Request):
    return host_of(request).mcp.list()
@router.post('')
async def create_mcp(request: Request, body: McpInput):
    return host_of(request).mcp.save(body)
@router.get('/{ident}')
async def get_mcp(request: Request, ident: str):
    svc = host_of(request).mcp
    return svc.public(svc.items.get(ident))
@router.put('/{ident}')
async def update_mcp(request: Request, ident: str, body: McpInput):
    return host_of(request).mcp.save(body, ident)
@router.delete('/{ident}', status_code=204)
async def delete_mcp(request: Request, ident: str):
    host_of(request).mcp.delete(ident)
    return Response(status_code=204)
@router.post('/{ident}/test')
async def test_mcp(request: Request, ident: str):
    return await host_of(request).mcp.test(ident)
