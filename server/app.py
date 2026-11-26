"""Loopback standalone HTTP/SSE host. / 仅本机的独立应用 HTTP/SSE 宿主。

Run: ``python -m uvicorn server.app:app --host 127.0.0.1 --port 8765``.
Env: AXC_MODEL_MODE (openai|fixture), AXC_DATA (default ./data), AXC_DB (default {data}/workbench.db),
AXC_SECRET_KEY (Fernet key), AXC_SEED (0 disables demo data).
"""
from contextlib import asynccontextmanager
import os
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from .routers import agents, analytics, evals, graphs, knowledge, mcp, memories, plugins, providers, resources, skills
from .services.common import Conflict, NotFound
from .services.resources import HostService

ALLOWED_ORIGINS = frozenset(f'http://{host}:{port}' for host in ('127.0.0.1', 'localhost') for port in (5173, 4173, 8765))


def default_host() -> HostService:
    data = os.environ.get('AXC_DATA', 'data')
    return HostService(data, db=os.environ.get('AXC_DB') or None, seed=os.environ.get('AXC_SEED', '1') != '0')


def create_app(service=None):
    @asynccontextmanager
    async def lifespan(app):
        app.state.host = service or default_host()
        await app.state.host.recover()
        yield
        await app.state.host.close()
    app = FastAPI(title='AxcAgentEngine Workbench Host', lifespan=lifespan)

    @app.exception_handler(NotFound)
    async def not_found(request, exc):
        return JSONResponse(status_code=404, content={'error': str(exc)})

    @app.exception_handler(Conflict)
    async def conflict(request, exc):
        return JSONResponse(status_code=409, content={'error': str(exc)})

    @app.exception_handler(ValueError)
    async def bad_request(request, exc):
        return JSONResponse(status_code=400, content={'error': str(exc)})

    @app.exception_handler(RequestValidationError)
    async def invalid(request, exc):
        errors = exc.errors()
        first = errors[0]['msg'].removeprefix('Value error, ') if errors else '请求参数无效'
        detail = [{k: v for k, v in e.items() if k in ('loc', 'msg', 'type')} for e in errors]
        return JSONResponse(status_code=422, content={'error': first, 'detail': detail})

    @app.middleware('http')
    async def local_origin(request: Request, call_next):
        origin = request.headers.get('origin')
        if origin and origin not in ALLOWED_ORIGINS:
            return JSONResponse(status_code=403, content={'error': '该独立宿主仅允许本地页面'})
        return await call_next(request)

    # Specific prefixes first; resources owns the generic /api/{kind} routes. / 资源通配路由最后注册。
    for module in (providers, plugins, agents, skills, knowledge, graphs, evals, mcp, memories, analytics, resources):
        app.include_router(module.router)
    return app


app = create_app()
