"""HTTP routers; each module maps one section of docs/API.zh-CN.md. / 每个模块对应 API 文档的一节。"""
from fastapi import Request, UploadFile


def host_of(request: Request):
    return request.app.state.host


async def read_upload(file: UploadFile, limit: int, label: str) -> bytes:
    """Read at most ``limit`` bytes, rejecting larger files. / 读取上传文件并限制大小。"""
    content = await file.read(limit + 1)
    if len(content) > limit:
        raise ValueError(f'{label}不能超过 {limit // (1024 * 1024)} MB')
    return content
