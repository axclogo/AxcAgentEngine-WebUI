from fastapi import APIRouter, File, Request, Response, UploadFile
from ..schemas import SkillInput
from ..services.skills import MAX_IMPORT
from . import host_of, read_upload

router = APIRouter(prefix='/api/skills', tags=['skills'])


@router.get('')
async def list_skills(request: Request):
    return host_of(request).skills.items.all()


@router.post('')
async def create_skill(request: Request, body: SkillInput):
    return host_of(request).skills.save(body)


@router.post('/import')
async def import_skill(request: Request, file: UploadFile = File(...)):
    content = await read_upload(file, MAX_IMPORT, '技能包')
    return host_of(request).skills.import_file(file.filename or 'SKILL.md', content)


@router.get('/{ident}')
async def get_skill(request: Request, ident: str):
    return host_of(request).skills.items.get(ident)


@router.put('/{ident}')
async def update_skill(request: Request, ident: str, body: SkillInput):
    return host_of(request).skills.save(body, ident)


@router.delete('/{ident}', status_code=204)
async def delete_skill(request: Request, ident: str):
    host_of(request).skills.delete(ident)
    return Response(status_code=204)
