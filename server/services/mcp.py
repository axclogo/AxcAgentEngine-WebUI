"""MCP servers with encrypted env/header values. / MCP 服务，env 与 headers 的值加密保存。

Responses expose only key names. On update an empty value keeps the stored secret and keys absent from the
body are removed. ``engine_config`` renders the engine ``mcp`` plugin ``servers`` entry
(plugins/builtin/mcp/support/connection.py: stdio ``command/args/env``, http ``url/headers``).
响应只返回键名；更新时空值保留原密文，未出现的键删除。
"""
from __future__ import annotations
import asyncio
from axc_agent_engine.plugins.builtin.mcp.support import MCPConnection
from ..crypto import SecretBox
from ..schemas import McpInput
from .common import Collection, now, uid

TEST_TIMEOUT = 15


class McpService:
    def __init__(self, db, secrets: SecretBox):
        self.items = Collection(db, 'mcp', 'MCP 服务')
        self.secrets = secrets

    def public(self, row: dict) -> dict:
        out = {k: v for k, v in row.items() if k not in ('env', 'headers')}
        return {**out, 'envKeys': sorted(row['env']), 'headerKeys': sorted(row['headers'])}

    def list(self) -> list[dict]:
        return [self.public(r) for r in self.items.all()]

    def _merge(self, given: dict[str, str], stored: dict[str, str]) -> dict[str, str]:
        return {k: self.secrets.encrypt(v) if v else stored.get(k, '') for k, v in given.items()}

    def save(self, body: McpInput, ident: str | None = None) -> dict:
        data = body.dump()
        self.items.unique_name(data['name'], ident)
        old = self.items.get(ident) if ident else None
        stamp = now()
        row = {**data, 'id': ident or uid(),
               'env': self._merge(data['env'], old['env'] if old else {}),
               'headers': self._merge(data['headers'], old['headers'] if old else {}),
               'createdAt': old['createdAt'] if old else stamp, 'updatedAt': stamp}
        return self.public(self.items.put(row))

    def delete(self, ident: str) -> None:
        self.items.remove(ident)

    def engine_config(self, row: dict, secrets: bool = True) -> dict:
        """Engine server entry; ``secrets=False`` masks values for YAML previews. / 引擎配置，预览时掩码。"""
        def values(stored: dict) -> dict:
            return {k: self.secrets.decrypt(v) if secrets else '••••' for k, v in stored.items()}
        if row['transport'] == 'stdio':
            config = {'name': row['name'], 'transport': 'stdio', 'command': row['command'], 'args': list(row['args'])}
            if row['env']:
                config['env'] = values(row['env'])
            return config
        return {'name': row['name'], 'transport': 'http', 'url': row['url'], 'headers': values(row['headers'])}

    async def test(self, ident: str) -> dict:
        row = self.items.get(ident)
        config = {**self.engine_config(row), 'timeout': TEST_TIMEOUT, 'connect_timeout': TEST_TIMEOUT}
        connection = MCPConnection(config)
        try:
            async with asyncio.timeout(TEST_TIMEOUT):
                await connection.connect()
                tools = await connection.list_tools()
        except Exception as exc:  # Reported to the user as the test result. / 作为测试结果返回给用户。
            return {'ok': False, 'message': f'连接失败：{type(exc).__name__}: {exc}', 'tools': []}
        finally:
            await connection.close()
        return {'ok': True, 'message': f'连接成功，发现 {len(tools)} 个工具',
                'tools': [{'name': t.name, 'description': t.description} for t in tools]}
