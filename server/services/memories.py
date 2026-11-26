"""Memories written by the engine ``memory`` plugin into the host KV store. / memory 插件写入的记忆。

Storage keys are ``memory:<scope>:<memoryId>`` or ``memory-v2:<scope>:<memoryId>`` where scope is
``namespace|key=value|...`` with ``% | = :`` %-escaped (plugins/builtin/memory/plugin.py
``MemoryScopeResolver``). Escaping ``:`` means the first ``:`` after the prefix ends the scope. The engine
agent name is our agent id, so ``agentId`` is the scope's ``agent_name`` component ('' when the agent's
memory config leaves it out of ``scope_keys``). The storage key is the public memory id.
"""
from __future__ import annotations
from urllib.parse import unquote
from .common import NotFound

PREFIXES = ('memory:', 'memory-v2:')


def parse_key(key: str) -> tuple[str, str] | None:
    """Storage key -> (scope, memory id), or None for non-record keys. / 解析存储键。"""
    prefix = next((p for p in PREFIXES if key.startswith(p)), None)
    if prefix is None:
        return None
    scope, sep, ident = key[len(prefix):].partition(':')
    return (scope, ident) if sep and ident and ':' not in ident else None


def scope_agent(scope: str) -> str:
    for part in scope.split('|')[1:]:
        name, _, value = part.partition('=')
        if unquote(name) == 'agent_name':
            return unquote(value)
    return ''


class MemoryService:
    def __init__(self, kv):
        self.kv = kv

    async def list(self, agent_id: str | None = None) -> list[dict]:
        out = []
        for key in await self.kv.list_keys():
            parsed = parse_key(key)
            if parsed is None:
                continue
            record = await self.kv.get(key)
            agent = scope_agent(parsed[0])
            if record is None or record.get('id') != parsed[1] or (agent_id and agent != agent_id):
                continue
            out.append({'id': key, 'agentId': agent, 'layer': record['layer'], 'content': record['content'],
                        'factType': record['fact_type'], 'importance': record['importance'], 'source': record['source'],
                        'accessCount': record['access_count'], 'createdAt': record['created_at'],
                        'lastAccessedAt': record['last_accessed_at']})
        return sorted(out, key=lambda m: m['createdAt'], reverse=True)

    async def delete(self, key: str) -> str:
        """Delete one record; returns its agent id. / 删除记忆并返回所属 Agent。"""
        parsed = parse_key(key)
        if parsed is None or await self.kv.get(key) is None:
            raise NotFound('记忆不存在')
        await self.kv.delete(key)
        return scope_agent(parsed[0])
