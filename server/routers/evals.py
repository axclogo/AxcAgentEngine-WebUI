from fastapi import APIRouter, Request, Response
from ..schemas import EvalCaseInput, EvalInput
from . import host_of

router = APIRouter(prefix='/api/evals', tags=['evals'])


@router.get('')
async def list_evals(request: Request):
    return host_of(request).evals.list()


@router.post('')
async def create_eval(request: Request, body: EvalInput):
    return host_of(request).evals.save(body)


@router.get('/{ident}')
async def get_eval(request: Request, ident: str):
    svc = host_of(request).evals
    return svc.public(svc.items.get(ident))


@router.put('/{ident}')
async def update_eval(request: Request, ident: str, body: EvalInput):
    return host_of(request).evals.save(body, ident)


@router.delete('/{ident}', status_code=204)
async def delete_eval(request: Request, ident: str):
    host_of(request).evals.delete(ident)
    return Response(status_code=204)


@router.get('/{ident}/cases')
async def list_cases(request: Request, ident: str):
    return host_of(request).evals.case_list(ident)


@router.post('/{ident}/cases')
async def add_case(request: Request, ident: str, body: EvalCaseInput):
    return host_of(request).evals.add_case(ident, body)


@router.delete('/{ident}/cases/{case_id}', status_code=204)
async def delete_case(request: Request, ident: str, case_id: str):
    host_of(request).evals.remove_case(ident, case_id)
    return Response(status_code=204)


@router.post('/{ident}/run')
async def run_eval(request: Request, ident: str):
    host = host_of(request)
    return host.evals.start(ident, host)


@router.get('/{ident}/results')
async def eval_results(request: Request, ident: str):
    return host_of(request).evals.results(ident)
