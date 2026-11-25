from urllib.parse import quote
from fastapi import APIRouter, Request, Response
from fastapi.responses import FileResponse
from pydantic import ValidationError
from starlette.datastructures import UploadFile
from ..schemas import KnowledgeInput, TextDocumentInput
from ..services.knowledge import MAX_DOCUMENT
from . import host_of, read_upload

router = APIRouter(prefix='/api/knowledge', tags=['knowledge'])


@router.get('')
async def list_knowledge(request: Request):
    return host_of(request).knowledge.list()


@router.post('')
async def create_knowledge(request: Request, body: KnowledgeInput):
    return host_of(request).knowledge.save(body)


@router.get('/{ident}')
async def get_knowledge(request: Request, ident: str):
    svc = host_of(request).knowledge
    return svc.public(svc.items.get(ident))


@router.put('/{ident}')
async def update_knowledge(request: Request, ident: str, body: KnowledgeInput):
    return host_of(request).knowledge.save(body, ident)


@router.delete('/{ident}', status_code=204)
async def delete_knowledge(request: Request, ident: str):
    host_of(request).knowledge.delete(ident)
    return Response(status_code=204)


@router.get('/{ident}/documents')
async def list_documents(request: Request, ident: str):
    svc = host_of(request).knowledge
    return [svc.public_doc(d) for d in svc.documents(ident)]


@router.post('/{ident}/documents')
async def add_document(request: Request, ident: str):
    """multipart ``file`` or JSON ``{title, content}``. / 上传文件或文本文档。"""
    svc = host_of(request).knowledge
    svc.items.get(ident)
    if request.headers.get('content-type', '').startswith('multipart/form-data'):
        form = await request.form()
        file = form.get('file')
        if not isinstance(file, UploadFile):
            raise ValueError('缺少上传文件 file')
        content = await read_upload(file, MAX_DOCUMENT, '单个文档')
        return svc.add(ident, file.filename or 'document', content)
    try:
        body = TextDocumentInput.model_validate_json(await request.body())
    except ValidationError as exc:
        raise ValueError('；'.join(e['msg'].removeprefix('Value error, ') for e in exc.errors())) from exc
    return svc.add_text(ident, body.title, body.content)


@router.get('/{ident}/documents/{doc_id}')
async def download_document(request: Request, ident: str, doc_id: str):
    doc, path = host_of(request).knowledge.document(ident, doc_id)
    return FileResponse(path, media_type=doc['contentType'],
                        headers={'Content-Disposition': f"attachment; filename*=UTF-8''{quote(doc['title'])}"})


@router.delete('/{ident}/documents/{doc_id}', status_code=204)
async def delete_document(request: Request, ident: str, doc_id: str):
    host_of(request).knowledge.remove_document(ident, doc_id)
    return Response(status_code=204)
