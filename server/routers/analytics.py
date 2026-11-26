from fastapi import APIRouter, Query, Request
from . import host_of
router = APIRouter(prefix='/api/analytics', tags=['analytics'])
Days = Query(30, ge=1, le=3650)
@router.get('/failures')
async def failures(request: Request, agentId: str | None = None, days: int = Days):
    return host_of(request).analytics.failures(agentId, days)
@router.get('/distill')
async def distill(request: Request, agentId: str | None = None, days: int = Days):
    return host_of(request).analytics.distill(agentId, days)
@router.get('/cost')
async def cost(request: Request, agentId: str | None = None, days: int = Days):
    return host_of(request).analytics.cost(agentId, days)
