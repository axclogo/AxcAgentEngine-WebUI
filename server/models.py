"""Strict configuration and deterministic real-engine fixture. / 严格配置及真实引擎确定性模型夹具。"""
import asyncio
import json
import os
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from axc_agent_engine import LLMMessage, LLMResponse, LLMStreamChunk, LLMConfig
from axc_agent_engine.llm.client import OpenAIClient

MODES = dict(group_chat=2, supervisor=2, debate=2, redblue=2, discussion=1, interview=1, social=1, retrospective=1, backcast=1, sandbox=1)

class TopicContext(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    topic_id: int = Field(ge=1)

class Shortcut(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    shortcut_key: Literal['example.topic']
    context: TopicContext

class LocalScope(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    key: str = Field(min_length=1)
    shortcut: Shortcut | None = None

class Definition(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    name: str = Field(min_length=1)
    mode: Literal['group_chat', 'supervisor', 'debate', 'redblue', 'discussion', 'interview', 'social', 'retrospective', 'backcast', 'sandbox']
    objective: str = Field(min_length=1)
    topic: str = Field(min_length=1)
    background: str
    persona: str
    agents: list[str]
    maxRounds: int = Field(ge=1, le=200)
    maxSteps: int = Field(ge=1, le=200)
    redObjective: str
    blueObjective: str

    @model_validator(mode='after')
    def validate_fields(self):
        if any(not getattr(self, k).strip() for k in ('name', 'objective', 'topic')):
            raise ValueError('名称、目标和议题不能为空')
        if len(set(self.agents)) != len(self.agents) or len(self.agents) < MODES[self.mode]:
            raise ValueError('参与者重复或人数不足')
        if self.mode == 'redblue' and (not self.redObjective.strip() or not self.blueObjective.strip()):
            raise ValueError('红蓝目标不能为空')
        return self

class FixtureModel:
    model = 'deterministic-fixture'
    tool_name_mapping = None

    async def chat(self, messages, tools=None, **options):
        text = json.dumps({'goal': '验证工作台', 'steps': [
            {'step_id': 1, 'description': '检查输入', 'depends_on': []},
            {'step_id': 2, 'description': '核对范围', 'depends_on': []},
        ]}, ensure_ascii=False)
        if '结构化仿真场景' in str(messages):
            text = json.dumps({'type': 'communicate', 'intent': '已核对场景约束', 'parameters': {}, 'rationale': '确定性验收'}, ensure_ascii=False)
        return LLMResponse(message=LLMMessage(content=text))

    async def stream(self, messages, tools=None, **options):
        prompt = str(messages[-1]['content'])
        if '结构化仿真场景' in prompt:
            text = json.dumps({'type': 'communicate', 'intent': '已核对场景约束', 'parameters': {}, 'rationale': '确定性验收'}, ensure_ascii=False)
        else:
            text = '真实引擎已执行：中文流式输出。\n\n|检查|结果|\n|---|---|\n|状态|通过|'
        for i in range(0, len(text), 8):
            await asyncio.sleep(0.02)
            yield LLMStreamChunk(content_delta=text[i:i+8])

    async def ask(self, prompt, **options):
        return '{"action":"done","step_ok":true,"goal_achieved":true}'

    async def close(self):
        pass

def model_mode():
    mode = os.environ.get('AXC_MODEL_MODE', 'openai')
    if mode not in ('openai', 'fixture'):
        raise ValueError('AXC_MODEL_MODE 必须为 openai 或 fixture')
    return mode
def configured_model():
    """Shared model override: FixtureModel in fixture mode, else None (each agent resolves its own providers).
    共享模型覆盖：fixture 模式返回夹具模型，否则返回 None（按 Agent 配置解析提供商）。"""
    return FixtureModel() if model_mode() == 'fixture' else None
class CompatibleClient(OpenAIClient):
    """OpenAI-compatible client that sends a thinking field real providers accept.
    The engine forwards runtime.thinking verbatim as {"type": "auto"|"always"}, which OpenAI-compatible
    providers such as DeepSeek reject (422: expected adaptive/enabled/disabled). Map it here:
    auto → omit (provider default), always → enabled.
    引擎把 thinking 原样发成 {"type": "auto"}，DeepSeek 等兼容服务会以 422 拒绝；这里映射：auto 省略，always → enabled。"""
    def _build_payload(self, messages, tools=None, **kwargs):
        payload = super()._build_payload(messages, tools, **kwargs)
        thinking = payload.get('thinking')
        if isinstance(thinking, dict):
            if thinking.get('type') == 'always':
                payload['thinking'] = {**thinking, 'type': 'enabled'}
            else:
                payload.pop('thinking')
        # The engine replays assistant tool_calls without "type": "function"; strict providers reject that.
        # 引擎回放的 tool_calls 缺少 type 字段，严格的兼容服务会拒绝。
        for message in payload.get('messages', []):
            for call in message.get('tool_calls') or []:
                call.setdefault('type', 'function')
        return payload
def openai_client(base_url, api_key, model):
    return CompatibleClient(LLMConfig(base_url=base_url, api_key=api_key, model=model))
def has_images(messages):
    for message in messages or []:
        content = message.get('content') if isinstance(message, dict) else None
        if isinstance(content, list) and any(isinstance(p, dict) and p.get('type') in ('image_url', 'image_base64') for p in content):
            return True
    return False
class VisionRouter:
    """Routes model calls whose messages carry images to the vision model. / 含图片的调用转给视觉模型。"""
    def __init__(self, main, vision):
        self.main, self.vision = main, vision
    def __getattr__(self, name):
        return getattr(self.main, name)
    def _pick(self, messages):
        return self.vision if has_images(messages) else self.main
    async def chat(self, messages, tools=None, **options):
        return await self._pick(messages).chat(messages, tools, **options)
    async def stream(self, messages, tools=None, **options):
        async for chunk in self._pick(messages).stream(messages, tools, **options):
            yield chunk
    async def close(self):
        await self.main.close()
        await self.vision.close()
