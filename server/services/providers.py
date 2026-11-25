"""Model providers with encrypted keys. / 模型提供商与加密密钥。"""
from __future__ import annotations
import httpx
from ..crypto import SecretBox, mask
from ..schemas import ProviderInput, ProviderTestInput
from .common import Collection, now, uid


class ProviderService:
    def __init__(self, db, secrets: SecretBox):
        self.items = Collection(db, 'provider', '提供商')
        self.secrets = secrets

    def public(self, row: dict) -> dict:
        out = {k: v for k, v in row.items() if k != 'apiKeyEncrypted'}
        key = self.secrets.decrypt(row['apiKeyEncrypted'])
        return {**out, 'apiKeyMasked': mask(key), 'hasKey': bool(key)}

    def list(self) -> list[dict]:
        return [self.public(r) for r in self.items.all()]

    def save(self, body: ProviderInput, ident: str | None = None) -> dict:
        data = body.dump()
        key = data.pop('apiKey')
        old = self.items.get(ident) if ident else None
        stamp = now()
        row = {
            **data,
            'id': ident or uid(),
            'apiKeyEncrypted': self.secrets.encrypt(key) if key else (old['apiKeyEncrypted'] if old else ''),
            'createdAt': old['createdAt'] if old else stamp,
            'updatedAt': stamp,
        }
        return self.public(self.items.put(row))

    def delete(self, ident: str) -> None:
        self.items.remove(ident)

    def api_key(self, ident: str) -> str:
        return self.secrets.decrypt(self.items.get(ident)['apiKeyEncrypted'])

    def resolve(self, ref: str | None) -> tuple[dict, dict, str] | None:
        """``providerId:modelId`` -> (provider, model entry, api key), or None. / 解析 ModelRef。"""
        if not ref or ':' not in ref:
            return None
        provider_id, model_id = ref.split(':', 1)
        provider = self.items.find(provider_id)
        if not provider or not provider['enabled']:
            return None
        entry = next((m for m in provider['models'] if m['id'] == model_id), None)
        if entry is None:
            return None
        return provider, entry, self.secrets.decrypt(provider['apiKeyEncrypted'])

    async def test(self, body: ProviderTestInput) -> dict:
        key = body.api_key or (self.api_key(body.id) if body.id else '')
        url = body.base_url.strip().rstrip('/') + '/models'
        headers = {'Authorization': f'Bearer {key}'} if key else {}
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            return {'ok': False, 'message': f'连接失败：{type(exc).__name__}', 'models': []}
        if response.status_code >= 400:
            return {'ok': False, 'message': f'服务返回 HTTP {response.status_code}', 'models': []}
        try:
            payload = response.json()
            rows = payload.get('data', payload) if isinstance(payload, dict) else payload
            models = sorted({str(m['id']) for m in rows if isinstance(m, dict) and m.get('id')})
        except (ValueError, TypeError):
            return {'ok': False, 'message': '响应不是有效的模型列表 JSON', 'models': []}
        return {'ok': True, 'message': f'连接成功，发现 {len(models)} 个模型', 'models': models}
