"""Shared helpers for management services. / 管理服务通用工具。"""
from datetime import datetime, timezone
from pathlib import Path
import re
import uuid


class NotFound(LookupError):
    """Mapped to HTTP 404. / 映射为 404。"""


class Conflict(ValueError):
    """Mapped to HTTP 409. / 映射为 409。"""


def uid() -> str:
    return uuid.uuid4().hex


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_filename(name: str, fallback: str = 'file') -> str:
    """Basename without separators or control characters. / 去除路径与控制字符的文件名。"""
    base = Path(str(name or '').replace('\\', '/')).name
    base = re.sub(r'[\x00-\x1f<>:"|?*]', '', base).strip(' .')
    return base[:200] or fallback


def suffix(name: str) -> str:
    return Path(safe_filename(name)).suffix.lower()


class Collection:
    """Typed view over one database bucket. / 单个 bucket 的集合视图。"""

    def __init__(self, db, bucket: str, label: str):
        self.db, self.bucket, self.label = db, bucket, label

    def all(self) -> list[dict]:
        return sorted(self.db.values(self.bucket), key=lambda v: (v.get('createdAt', ''), v.get('id', '')))

    def find(self, ident: str) -> dict | None:
        return self.db.get(self.bucket, ident)

    def get(self, ident: str) -> dict:
        value = self.db.get(self.bucket, ident)
        if value is None:
            raise NotFound(f'{self.label}不存在')
        return value

    def put(self, value: dict) -> dict:
        self.db.put(self.bucket, value['id'], value)
        return value

    def remove(self, ident: str) -> None:
        self.get(ident)
        self.db.remove(self.bucket, ident)

    def unique_name(self, name: str, ident: str | None = None) -> None:
        if any(v['name'] == name and v['id'] != ident for v in self.db.values(self.bucket)):
            raise Conflict(f'{self.label}名称已存在')
