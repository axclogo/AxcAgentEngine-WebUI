"""Knowledge graphs backed by ``PersistentGraphStore``. / 基于持久化图存储的知识图谱。"""
from __future__ import annotations
import json
import os
from pathlib import Path
import tempfile
from axc_agent_engine.plugins.builtin.graph.config import GraphConfig
from axc_agent_engine.plugins.builtin.graph.service import GraphService
from ..graph_store import PersistentGraphStore
from ..schemas import EntityInput, GraphInput, RelationInput
from .common import Collection, NotFound, now, uid

MAX_IMPORT = 20 * 1024 * 1024


def public_entity(e: dict) -> dict:
    return {'id': e['id'], 'name': e['name'], 'type': e['type'], 'description': e.get('description', ''),
            'aliases': list(e.get('aliases', []))}


def public_relation(r: dict) -> dict:
    return {'id': r['id'], 'sourceId': r['source_id'], 'targetId': r['target_id'], 'sourceName': r['source_name'],
            'targetName': r['target_name'], 'relationType': r['relation_type'], 'description': r['description']}


class GraphServiceHost:
    def __init__(self, db):
        self.db = db
        self.items = Collection(db, 'graph', '图谱')
        self.stores: dict[str, PersistentGraphStore] = {}

    def store(self, ident: str) -> PersistentGraphStore:
        """The single live store per graph, also mounted into agents. / 每个图谱唯一的存储实例。"""
        self.items.get(ident)
        if ident not in self.stores:
            self.stores[ident] = PersistentGraphStore(lambda state: self.db.put('graph_data', ident, state),
                                                      self.db.get('graph_data', ident))
        return self.stores[ident]

    def public(self, row: dict) -> dict:
        store = self.store(row['id'])
        return {**row, 'entityCount': len(store.entities), 'relationCount': len(store.relations)}

    def list(self) -> list[dict]:
        return [self.public(r) for r in self.items.all()]

    def save(self, body: GraphInput, ident: str | None = None) -> dict:
        old = self.items.get(ident) if ident else None
        stamp = now()
        row = {**body.dump(), 'id': ident or uid(), 'createdAt': old['createdAt'] if old else stamp, 'updatedAt': stamp}
        return self.public(self.items.put(row))

    def delete(self, ident: str) -> None:
        self.items.remove(ident)
        self.stores.pop(ident, None)
        self.db.remove('graph_data', ident)

    def data(self, ident: str) -> dict:
        store = self.store(ident)
        return {'entities': [public_entity(store._entity_dict(i)) for i in store.entities],
                'relations': [public_relation(store._relation_dict(i)) for i in store.relations]}

    def upsert_entity(self, ident: str, body: EntityInput) -> dict:
        store = self.store(ident)
        aliases = [a.strip() for a in body.aliases if a.strip()]
        return public_entity(store.upsert_entity(body.name, body.type or 'concept', aliases, description=body.description))

    def delete_entity(self, ident: str, entity_id: str) -> None:
        if not self.store(ident).delete_entity(entity_id):
            raise NotFound('实体不存在')

    def upsert_relation(self, ident: str, body: RelationInput) -> dict:
        store = self.store(ident)

        def name(ref: str) -> str:
            return store.entities[ref]['name'] if ref in store.entities else ref.strip()
        source, target = name(body.source), name(body.target)
        if not source or not target:
            raise ValueError('请选择起点和终点')
        return public_relation(store.upsert_relation(source, target, body.relation_type, body.description))

    def delete_relation(self, ident: str, relation_id: str) -> None:
        if not self.store(ident).delete_relation(relation_id):
            raise NotFound('关系不存在')

    def import_file(self, ident: str, filename: str, content: bytes) -> dict:
        """JSONL in the engine source format, or JSON ``{entities, relations}``. / 导入 JSONL 或 JSON。"""
        store = self.store(ident)
        if len(content) > MAX_IMPORT:
            raise ValueError('导入文件不能超过 20 MB')
        try:
            text = content.decode('utf-8-sig')
        except UnicodeDecodeError as exc:
            raise ValueError('导入文件必须是 UTF-8 文本') from exc
        stripped = text.strip()
        if stripped.startswith('{') and not filename.lower().endswith('.jsonl'):
            try:
                payload = json.loads(stripped)
            except json.JSONDecodeError:
                payload = None  # Fall back to JSONL (one object per line). / 回退为逐行 JSONL。
            if isinstance(payload, dict) and ('entities' in payload or 'relations' in payload):
                text = self._json_to_jsonl(payload)
        fd, path = tempfile.mkstemp(suffix='.jsonl')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                handle.write(text)
            with store.batch():
                # The engine loader validates records and upserts them into our store. / 复用引擎导入器。
                GraphService(GraphConfig.from_dict({'sources': [path], 'namespace': ident}), store)
                # Record the uploaded file name instead of the temporary path. / 用上传文件名替换临时路径。
                for item in [*store.entities.values(), *store.relations.values()]:
                    for key in ('source', 'data_source'):
                        if item['metadata'].get(key) == path:
                            item['metadata'][key] = filename
        finally:
            Path(path).unlink(missing_ok=True)
        return self.data(ident)

    @staticmethod
    def _json_to_jsonl(payload: dict) -> str:
        lines = []
        for item in payload.get('entities') or []:
            if not isinstance(item, dict) or not item.get('name'):
                raise ValueError('实体必须包含 name')
            lines.append({**item, 'id': item.get('id') or item['name']})
        for item in payload.get('relations') or []:
            if not isinstance(item, dict):
                raise ValueError('关系必须是对象')
            relation = dict(item)
            for camel, snake in (('relationType', 'relation_type'), ('sourceId', 'source_id'), ('targetId', 'target_id'),
                                 ('sourceName', 'source'), ('targetName', 'target')):
                if camel in relation and snake not in relation:
                    relation[snake] = relation.pop(camel)
            relation.setdefault('relation_type', 'RELATED_TO')
            lines.append(relation)
        return '\n'.join(json.dumps(line, ensure_ascii=False) for line in lines)
