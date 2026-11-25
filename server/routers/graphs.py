from fastapi import APIRouter, File, Request, Response, UploadFile
from ..schemas import EntityInput, GraphInput, RelationInput
from ..services.graphs import MAX_IMPORT
from . import host_of, read_upload

router = APIRouter(prefix='/api/graphs', tags=['graphs'])


@router.get('')
async def list_graphs(request: Request):
    return host_of(request).graphs.list()


@router.post('')
async def create_graph(request: Request, body: GraphInput):
    return host_of(request).graphs.save(body)


@router.get('/{ident}')
async def get_graph(request: Request, ident: str):
    svc = host_of(request).graphs
    return svc.public(svc.items.get(ident))


@router.put('/{ident}')
async def update_graph(request: Request, ident: str, body: GraphInput):
    return host_of(request).graphs.save(body, ident)


@router.delete('/{ident}', status_code=204)
async def delete_graph(request: Request, ident: str):
    host_of(request).graphs.delete(ident)
    return Response(status_code=204)


@router.get('/{ident}/data')
async def graph_data(request: Request, ident: str):
    return host_of(request).graphs.data(ident)


@router.post('/{ident}/entities')
async def upsert_entity(request: Request, ident: str, body: EntityInput):
    return host_of(request).graphs.upsert_entity(ident, body)


@router.delete('/{ident}/entities/{entity_id}', status_code=204)
async def delete_entity(request: Request, ident: str, entity_id: str):
    host_of(request).graphs.delete_entity(ident, entity_id)
    return Response(status_code=204)


@router.post('/{ident}/relations')
async def upsert_relation(request: Request, ident: str, body: RelationInput):
    return host_of(request).graphs.upsert_relation(ident, body)


@router.delete('/{ident}/relations/{relation_id}', status_code=204)
async def delete_relation(request: Request, ident: str, relation_id: str):
    host_of(request).graphs.delete_relation(ident, relation_id)
    return Response(status_code=204)


@router.post('/{ident}/import')
async def import_graph(request: Request, ident: str, file: UploadFile = File(...)):
    content = await read_upload(file, MAX_IMPORT, '导入文件')
    return host_of(request).graphs.import_file(ident, file.filename or 'graph.jsonl', content)
