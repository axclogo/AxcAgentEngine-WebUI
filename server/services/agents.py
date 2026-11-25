"""Agent definitions, agent.yaml rendering/validation and engine instantiation.
Agent 定义、agent.yaml 渲染与校验、引擎实例化。

The host uses the agent id as the engine agent name; a changed definition (or any bound resource)
unloads the old instance on next use. 宿主以 Agent ID 作为引擎内名称，定义或绑定资源变化后下次使用时重建实例。
"""
from __future__ import annotations
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import tempfile
from typing import Any
from pydantic import ValidationError
import yaml
from axc_agent_engine import AgentModels, Engine, PluginRegistry
from axc_agent_engine.core.schema import AgentConfig
from axc_agent_engine.plugins.builtin import AVAILABLE_BUILTIN_PLUGINS
from axc_agent_engine.plugins.builtin.graph.support import InMemoryGraphStore
from ..models import FixtureModel, VisionRouter, openai_client
from ..schemas import AgentInput
from .common import Collection, now, uid

STRATEGIES = ('react', 'por')
MANAGED = ('skill', 'knowledge', 'graph')
MANAGED_CAPABILITIES = {'skill': ['skill_read'], 'knowledge': ['knowledge_read'],
                        'graph': ['graph_read', 'graph_write', 'graph_delete']}


def build_registry() -> PluginRegistry:
    registry = PluginRegistry()
    registry.register_many(AVAILABLE_BUILTIN_PLUGINS.values())
    return registry


def _field(f) -> dict:
    return {'key': f.key, 'label': f.label or f.key, 'type': f.type, 'description': f.description, 'default': f.default,
            'required': f.required, 'enum': list(f.enum), 'children': [_field(c) for c in f.children],
            'itemSchema': _field(f.item_schema) if f.item_schema else None, 'advanced': f.advanced}


def plugin_catalog(registry: PluginRegistry) -> list[dict]:
    out = []
    for name in registry.names():
        cls = registry.get(name)
        schema = registry.get_plugin_config_schema(name)
        doc = (getattr(cls, '__doc__', '') or '').strip().splitlines()
        out.append({
            'name': name,
            'displayName': schema.display_name or getattr(cls, 'display_name', '') or name,
            'description': schema.description or getattr(cls, 'description', '') or (doc[0] if doc else ''),
            'version': str(getattr(cls, 'version', '') or ''),
            'kind': 'strategy' if name in STRATEGIES else 'plugin',
            'managed': name in MANAGED,
            'fields': [_field(f) for f in schema.fields],
        })
    return sorted(out, key=lambda p: (p['kind'] != 'strategy', p['name']))


def _errors(exc: ValidationError, prefix: str = '') -> list[dict]:
    return [{'path': '.'.join(str(p) for p in (prefix, *e['loc']) if p != ''),
             'message': e['msg'].removeprefix('Value error, ')} for e in exc.errors()]


class AgentService:
    def __init__(self, db, data: Path, registry: PluginRegistry, providers, skills, knowledge, graphs):
        self.items = Collection(db, 'agent', 'Agent')
        self.data = data
        self.registry = registry
        self.providers, self.skills, self.knowledge, self.graphs = providers, skills, knowledge, graphs
        self.cache: dict[str, tuple[str, Any, list]] = {}

    # ---------- CRUD ----------
    def model_status(self, row: dict) -> str:
        main = row['models']['main']
        if not main:
            return 'unset'
        resolved = self.providers.resolve(main)
        return 'ok' if resolved and resolved[1]['type'] == 'llm' else 'missing'

    def public(self, row: dict) -> dict:
        return {**row, 'modelStatus': self.model_status(row)}

    def list(self) -> list[dict]:
        return [self.public(r) for r in self.items.all()]

    def get(self, ident: str) -> dict:
        return self.public(self.items.get(ident))

    def save(self, body: AgentInput, ident: str | None = None, fixed_id: str | None = None) -> dict:
        data = body.dump()
        self.items.unique_name(data['name'], ident)
        unknown = sorted(set(data['plugins']) - set(self.registry.names()))
        if unknown:
            raise ValueError(f'未知插件：{", ".join(unknown)}')
        old = self.items.get(ident) if ident else None
        stamp = now()
        row = {**data, 'id': ident or fixed_id or uid(), 'createdAt': old['createdAt'] if old else stamp, 'updatedAt': stamp}
        return self.public(self.items.put(row))

    def delete(self, ident: str) -> None:
        self.items.remove(ident)
        shutil.rmtree(self.data / 'agent-skills' / ident, ignore_errors=True)

    # ---------- agent.yaml ----------
    def render(self, row: dict, name: str, skill_dir: Path) -> dict:
        """AgentInput document -> engine AgentConfig dict. / 转换为引擎 YAML 结构。"""
        rt = row['runtime']
        runtime = {'strategy': row['strategy'], 'max_rounds': rt['maxRounds'], 'thinking': rt['thinking'],
                   'parallel_tool_calls': rt['parallelToolCalls'], 'human_in_the_loop': rt['humanInTheLoop']}
        for key, field in (('stream_idle_timeout', 'streamIdleTimeout'), ('step_timeout', 'stepTimeout'),
                           ('total_timeout', 'totalTimeout')):
            if rt[field] is not None:
                runtime[key] = max(1, math.ceil(rt[field]))  # Engine timeouts are integer seconds. / 引擎超时为整数秒。
        settings = row['plugins']
        plugins: dict[str, dict] = {}
        for plugin, setting in settings.items():
            if plugin not in STRATEGIES and plugin not in MANAGED and setting['enabled']:
                plugins[plugin] = {**setting['config'], 'enabled': True}
        plugins[row['strategy']] = {**settings.get(row['strategy'], {}).get('config', {}), 'enabled': True}
        bound = self._bound_skills(row)
        if bound:
            plugins['skill'] = {**settings.get('skill', {}).get('config', {}), 'enabled': True, 'paths': [str(skill_dir)]}
        sources = self.knowledge.sources(row['bindings']['knowledge'])
        if sources:
            plugins['knowledge'] = {**settings.get('knowledge', {}).get('config', {}), 'enabled': True, 'sources': sources}
        if self._bound_graph(row):
            plugins['graph'] = {**settings.get('graph', {}).get('config', {}), 'enabled': True, 'sources': []}
        # The engine denies capability-tagged tools unless allowed; grant what bound resources need.
        # 引擎默认拒绝带能力标签的工具，这里为已绑定资源授予所需能力（不含 shell）。
        capabilities = [c for plugin, caps in MANAGED_CAPABILITIES.items() if plugin in plugins for c in caps]
        if capabilities:
            runtime['allowed_capabilities'] = capabilities
        config = {'name': name, 'description': row['description'], 'runtime': runtime, 'plugins': plugins}
        if row['systemPrompt'].strip():
            config['system_prompt'] = row['systemPrompt']
        return config

    def _bound_skills(self, row: dict) -> list[dict]:
        return [s for i in row['bindings']['skills'] if (s := self.skills.items.find(i)) and s['enabled']]

    def _bound_graph(self, row: dict) -> str | None:
        graph = self.graphs.items.find(row['bindings']['graph']) if row['bindings']['graph'] else None
        return graph['id'] if graph and graph['enabled'] else None

    def link_skills(self, row: dict, folder: Path) -> None:
        shutil.rmtree(folder, ignore_errors=True)
        folder.mkdir(parents=True, exist_ok=True)
        for skill in self._bound_skills(row):
            target = self.skills.dir(skill['id'])
            try:
                os.symlink(target, folder / skill['id'], target_is_directory=True)
            except OSError:
                shutil.copytree(target, folder / skill['id'])

    def yaml_text(self, row: dict) -> str:
        config = self.render(row, row['name'], self.data / 'agent-skills' / row['id'])
        return yaml.safe_dump(config, allow_unicode=True, sort_keys=False)

    async def validate(self, raw: Any) -> dict:
        try:
            body = AgentInput.model_validate(raw)
        except ValidationError as exc:
            return {'ok': False, 'errors': _errors(exc), 'yaml': ''}
        row = {**body.dump(), 'id': 'validate'}
        errors = [{'path': 'plugins', 'message': f'未知插件：{p}'} for p in sorted(set(row['plugins']) - set(self.registry.names()))]
        with tempfile.TemporaryDirectory() as tmp:
            skill_dir = Path(tmp) / 'skills'
            self.link_skills(row, skill_dir)
            config = self.render(row, row['name'], skill_dir)
            text = yaml.safe_dump(config, allow_unicode=True, sort_keys=False)
            try:
                AgentConfig(**config)
            except ValidationError as exc:
                return {'ok': False, 'errors': errors + _errors(exc), 'yaml': text}
            if errors:
                return {'ok': False, 'errors': errors, 'yaml': text}
            path = Path(tmp) / 'agent.yaml'
            path.write_text(yaml.safe_dump({**config, 'name': 'validate'}, allow_unicode=True), encoding='utf-8')
            engine = Engine(plugin_registry=self.registry)
            try:
                engine.load_agent_template(str(path)).instantiate(
                    models=AgentModels(default=FixtureModel()), mounts={'graph.store': InMemoryGraphStore()})
            except Exception as exc:  # Engine plugin init errors carry the reason. / 插件初始化错误。
                return {'ok': False, 'errors': [{'path': 'plugins', 'message': str(exc)}], 'yaml': text}
            finally:
                await engine.close()
        return {'ok': True, 'errors': [], 'yaml': text}

    # ---------- runtime ----------
    def fingerprint(self, row: dict) -> str:
        related = [row,
                   [(s['id'], s['updatedAt']) for s in self._bound_skills(row)],
                   [(k['id'], k['updatedAt'], k['enabled']) for i in row['bindings']['knowledge'] if (k := self.knowledge.items.find(i))],
                   self.graphs.items.find(row['bindings']['graph'] or '') or {},
                   [(p['id'], p['updatedAt']) for p in self.providers.items.all()]]
        return hashlib.sha256(json.dumps(related, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def _models(self, row: dict, override) -> tuple[AgentModels, list]:
        if override is not None:
            return AgentModels(default=override), []
        main = self.providers.resolve(row['models']['main'])
        if not main or main[1]['type'] != 'llm':
            raise ValueError('Agent 未配置可用的主模型')
        clients = []

        def client(resolved):
            provider, entry, key = resolved
            value = openai_client(provider['baseUrl'], key, entry['id'])
            clients.append(value)
            return value
        default = client(main)
        vision = self.providers.resolve(row['models']['vision'])
        if vision and vision[1]['type'] == 'llm' and vision[1]['vision']:
            default = VisionRouter(default, client(vision))
        utility = self.providers.resolve(row['models']['utility'])
        utility = client(utility) if utility and utility[1]['type'] == 'llm' else None
        return AgentModels(default=default, utility=utility), clients

    def judge_model(self, ident: str, override):
        """Utility model, else main; None in fixture mode. / 裁判模型。"""
        if override is not None:
            return None
        row = self.items.get(ident)
        for ref in (row['models']['utility'], row['models']['main']):
            resolved = self.providers.resolve(ref)
            if resolved and resolved[1]['type'] == 'llm':
                provider, entry, key = resolved
                return openai_client(provider['baseUrl'], key, entry['id'])
        raise ValueError('Agent 未配置可用的主模型')

    async def instance(self, engine: Engine, ident: str, override, busy: bool):
        row = self.items.get(ident)
        version = self.fingerprint(row)
        cached = self.cache.get(ident)
        if cached and (cached[0] == version or busy):
            return cached[1]
        if cached:
            await self.unload(engine, ident)
        models, clients = self._models(row, override)
        folder = self.data / 'agent-skills' / ident
        self.link_skills(row, folder)
        agents = self.data / 'agents'
        agents.mkdir(parents=True, exist_ok=True)
        path = agents / f'{ident}.yaml'
        path.write_text(yaml.safe_dump(self.render(row, ident, folder), allow_unicode=True, sort_keys=False), encoding='utf-8')
        graph = self._bound_graph(row)
        mounts = {'graph.store': self.graphs.store(graph)} if graph else None
        try:
            agent = engine.load_agent_template(str(path)).instantiate(models=models, mounts=mounts)
        except Exception:
            for c in clients:
                await c.close()
            raise
        self.cache[ident] = (version, agent, clients)
        return agent

    async def unload(self, engine: Engine, ident: str) -> None:
        cached = self.cache.pop(ident, None)
        if cached:
            await engine.unload_agent(ident)
            for c in cached[2]:
                await c.close()
