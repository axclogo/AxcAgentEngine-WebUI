from fastapi import APIRouter, Request, Response
from ..schemas import ProviderInput, ProviderTestInput
from . import host_of

router = APIRouter(prefix='/api/providers', tags=['providers'])


@router.get('')
async def list_providers(request: Request):
    return host_of(request).providers.list()


@router.post('')
async def create_provider(request: Request, body: ProviderInput):
    return host_of(request).providers.save(body)


@router.post('/test')
async def test_provider(request: Request, body: ProviderTestInput):
    return await host_of(request).providers.test(body)


@router.put('/{ident}')
async def update_provider(request: Request, ident: str, body: ProviderInput):
    return host_of(request).providers.save(body, ident)


@router.delete('/{ident}', status_code=204)
async def delete_provider(request: Request, ident: str):
    host_of(request).providers.delete(ident)
    return Response(status_code=204)
