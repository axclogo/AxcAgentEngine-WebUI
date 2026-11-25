"""Durable graph store shared by the management API and the engine graph plugin.
管理 API 与引擎图谱插件共用的持久化图存储。

It extends the engine ``InMemoryGraphStore`` (same matching and search semantics) with collision-free ids
and a ``persist`` callback invoked after every mutation, so writes made by agents through graph tools are
saved too. 继承引擎内存图存储，使用不冲突的 ID，并在每次变更后回调持久化（含 Agent 工具写入）。
"""
from collections.abc import Callable
from contextlib import contextmanager
from typing import Any
import uuid
from axc_agent_engine.plugins.builtin.graph.support import InMemoryGraphStore


class PersistentGraphStore(InMemoryGraphStore):
    def __init__(self, persist: Callable[[dict], None], state: dict | None = None) -> None:
        super().__init__()
        self._persist = persist
        self._batch = 0
        for entity in (state or {}).get('entities', []):
            self.entities[entity['id']] = {**entity, 'aliases': set(entity.get('aliases', []))}
        for relation in (state or {}).get('relations', []):
            self.relations[relation['id']] = dict(relation)

    def dump(self) -> dict:
        return {
            'entities': [{**e, 'aliases': sorted(e['aliases'])} for e in self.entities.values()],
            'relations': [dict(r) for r in self.relations.values()],
        }

    @contextmanager
    def batch(self):
        """Persist once for a group of mutations. / 批量变更只持久化一次。"""
        self._batch += 1
        try:
            yield self
        finally:
            self._batch -= 1
            self._save()

    def _save(self) -> None:
        if not self._batch:
            self._persist(self.dump())

    def upsert_entity(self, name: str, entity_type: str = 'concept', aliases: list[str] | None = None, **metadata: Any) -> dict[str, Any]:
        name = name.strip()
        if not name:
            raise ValueError('实体名称不能为空')
        entity = self._resolve_entity(name, entity_type, aliases or [])
        if entity:
            entity['mention_count'] += 1
            entity['aliases'].update(aliases or [])
            if entity_type and entity.get('type') == 'concept':
                entity['type'] = entity_type
            entity['metadata'].update(metadata)
            entity_id = entity['id']
        else:
            entity_id = f'entity:{uuid.uuid4().hex[:12]}'
            self.entities[entity_id] = {
                'id': entity_id, 'name': name, 'type': entity_type, 'aliases': set(aliases or []),
                'mention_count': 1, 'metadata': dict(metadata),
            }
        self._save()
        return self._entity_dict(entity_id)

    def upsert_relation(self, source: str, target: str, relation_type: str = 'RELATED_TO', description: str = '',
                        source_memory_id: str = '', **metadata: Any) -> dict[str, Any]:
        with self.batch():
            source_entity = self.upsert_entity(source)
            target_entity = self.upsert_entity(target)
            for relation in self.relations.values():
                if (relation['source_id'], relation['target_id'], relation['relation_type']) == (
                        source_entity['id'], target_entity['id'], relation_type):
                    if len(description) > len(relation.get('description', '')):
                        relation['description'] = description
                    relation['confidence'] = min(float(relation.get('confidence', 0.8)) + 0.05, 1.0)
                    relation['metadata'].update(metadata)
                    return self._relation_dict(relation['id'])
            relation_id = f'relation:{uuid.uuid4().hex[:12]}'
            self.relations[relation_id] = {
                'id': relation_id, 'source_id': source_entity['id'], 'target_id': target_entity['id'],
                'relation_type': relation_type, 'description': description, 'confidence': 0.8,
                'source_memory_id': source_memory_id, 'metadata': dict(metadata),
            }
            return self._relation_dict(relation_id)

    def delete_entity(self, entity_id: str) -> bool:
        removed = super().delete_entity(entity_id)
        if removed:
            self._save()
        return removed

    def delete_relation(self, relation_id: str) -> bool:
        removed = super().delete_relation(relation_id)
        if removed:
            self._save()
        return removed
