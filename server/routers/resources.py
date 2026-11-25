"""Conversations and simulations: snapshot, SSE, commands, attachments. / 会话与推演资源协议。"""
import asyncio
import json
from typing import Literal
from urllib.parse import quote
from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from ..models import Definition
from ..services.resources import MAX_ATTACHMENT
from . import host_of, read_upload

router = APIRouter(tags=['resources'])
Kind = Literal['conversation', 'simulation']


class CommandBody(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    type: Literal['send', 'stop', 'resume', 'fork', 'delete', 'archive', 'unarchive', 'start', 'pause', 'interview', 'generateReport', 'cancelRequest']
    requestId: str | None = None
    text: str | None = None
    attachments: list[dict] = Field(default_factory=list)
    mode: Literal['send', 'insert', 'enqueue', 'priority'] = 'send'
    target: str | None = None
    question: str | None = None
    checkpointId: str | None = None

    def command(self):
        required = {'send': ['requestId', 'text'], 'interview': ['requestId', 'target', 'question'], 'fork': ['checkpointId'], 'cancelRequest': ['requestId']}
        value = self.model_dump(exclude_none=True)
        for key in required.get(self.type, []):
            if not value.get(key):
                raise ValueError(f'缺少 {key}')
        return value


class CreateBody(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    scope: dict
    agentId: str | None = None
    definition: Definition | None = None
    id: str | None = None


class ListFilter(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    keyword: str = ''
    agentId: str = ''
    mode: str = ''
    status: str = ''


def parse_scope(scope: str):
    try:
        return json.loads(scope)
    except json.JSONDecodeError as exc:
        raise ValueError('scope 不是有效 JSON') from exc


@router.get('/api/catalog')
async def catalog(request: Request, scope: str):
    return host_of(request).catalog(parse_scope(scope))


@router.post('/api/conversation/{ident}/attachments')
async def upload_attachment(request: Request, ident: str, scope: str, file: UploadFile = File(...)):
    content = await read_upload(file, MAX_ATTACHMENT, '附件')
    return host_of(request).upload('conversation', ident, parse_scope(scope), file.filename or 'attachment',
                                   file.content_type or '', content)


@router.get('/api/attachments/{ident}')
async def get_attachment(request: Request, ident: str):
    row, path = host_of(request).attachment(ident)
    disposition = 'inline' if row['contentType'].startswith('image/') else 'attachment'
    return FileResponse(path, media_type=row['contentType'],
                        headers={'Content-Disposition': f"{disposition}; filename*=UTF-8''{quote(row['name'])}",
                                 'X-Content-Type-Options': 'nosniff'})


@router.get('/api/{kind}')
async def listing(request: Request, kind: Kind, scope: str, filter: str = '{}'):
    filters = ListFilter.model_validate_json(filter).model_dump()
    return host_of(request).list(kind, parse_scope(scope), filters)


@router.post('/api/{kind}')
async def create(request: Request, kind: Kind, body: CreateBody):
    host = host_of(request)
    if kind == 'conversation':
        if not body.agentId:
            raise ValueError('缺少 agentId')
        return host.create(kind, body.scope, body.agentId)
    if body.definition is None:
        raise ValueError('缺少推演定义')
    definition = body.definition.model_dump()
    if body.id:
        return host.update_simulation(body.id, body.scope, definition)
    return host.create(kind, body.scope, definition['agents'][0], definition)


@router.get('/api/{kind}/{ident}')
async def detail(request: Request, kind: Kind, ident: str, scope: str, events: bool = False):
    host, owner = host_of(request), parse_scope(scope)
    host.get(kind, ident, owner)
    if not events:
        return host.snapshot(kind, ident, owner)
    key = host.key(kind, ident)
    queue = asyncio.Queue()
    host.listeners.setdefault(key, set()).add(queue)

    async def stream():
        try:
            yield ': subscribed\n\n'
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                    if event['kind'] == 'meta':
                        event = {**event, 'value': {**event['value'], 'capabilities': host.capabilities(host.get(kind, ident, owner), owner)}}
                    yield f'data: {json.dumps(event, ensure_ascii=False)}\n\n'
                except asyncio.TimeoutError:
                    yield ': heartbeat\n\n'
        finally:
            host.listeners[key].discard(queue)
    return StreamingResponse(stream(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@router.post('/api/{kind}/{ident}')
async def command(request: Request, kind: Kind, ident: str, scope: str, body: CommandBody):
    return await host_of(request).command(kind, ident, parse_scope(scope), body.command())
