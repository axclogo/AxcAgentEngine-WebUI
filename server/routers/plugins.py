from fastapi import APIRouter, Request
from . import host_of

router = APIRouter(prefix='/api/plugins', tags=['plugins'])


@router.get('')
async def list_plugins(request: Request):
    return host_of(request).plugins()
