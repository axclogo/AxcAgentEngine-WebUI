"""Request models mirroring ``src/studio/schema.ts`` (camelCase on the wire). / 与 schema.ts 对齐的请求模型。

Python attributes are snake_case; ``dump()`` returns the camelCase JSON document stored and served.
Unknown keys are dropped like zod's default object parsing.
"""
from typing import Annotated, Any, Literal
from urllib.parse import urlparse
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel


def _non_empty(message):
    def check(value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError(message)
        return value
    return AfterValidator(check)


Name = Annotated[str, _non_empty('名称不能为空')]


class Input(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, strict=True, extra='ignore')

    def dump(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True)


# ---------- Providers ----------
class ModelEntry(Input):
    id: Annotated[str, _non_empty('模型 ID 不能为空')]
    label: str = ''
    type: Literal['llm', 'embedding', 'image'] = 'llm'
    vision: bool = False
    context_window: int | None = Field(default=None, gt=0)


class ProviderInput(Input):
    name: Name
    base_url: str
    api_key: str = ''
    enabled: bool = True
    models: list[ModelEntry] = Field(max_length=500)

    @field_validator('base_url')
    @classmethod
    def url(cls, value: str) -> str:
        value = value.strip()
        parsed = urlparse(value)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc:
            raise ValueError('请输入完整 URL，例如 https://api.openai.com/v1')
        return value.rstrip('/')

    @field_validator('models')
    @classmethod
    def unique(cls, value: list[ModelEntry]) -> list[ModelEntry]:
        ids = [m.id for m in value]
        if len(set(ids)) != len(ids):
            raise ValueError('模型 ID 不得重复')
        return value


class ProviderTestInput(Input):
    id: str | None = None
    base_url: str
    api_key: str = ''


# ---------- Agents ----------
Timeout = Annotated[float, Field(gt=0)] | None


class RuntimeInput(Input):
    max_rounds: int = Field(default=20, ge=1, le=500)
    thinking: Literal['auto', 'always', 'never'] = 'auto'
    stream_idle_timeout: Timeout = None
    step_timeout: Timeout = None
    total_timeout: Timeout = None
    parallel_tool_calls: bool = True
    human_in_the_loop: bool = False


class ModelsInput(Input):
    main: str | None = None
    utility: str | None = None
    vision: str | None = None
    image: str | None = None


class PluginSetting(Input):
    enabled: bool
    config: dict[str, Any]


class BindingsInput(Input):
    skills: list[str] = []
    knowledge: list[str] = []
    graph: str | None = None


class AgentInput(Input):
    name: Annotated[str, _non_empty('名称不能为空'), Field(max_length=80)]
    avatar: str = '🤖'
    description: str = ''
    enabled: bool = True
    system_prompt: str = ''
    strategy: Literal['react', 'por'] = 'react'
    runtime: RuntimeInput
    models: ModelsInput
    plugins: dict[str, PluginSetting]
    bindings: BindingsInput


# ---------- Skills ----------
class SkillInput(Input):
    name: Annotated[str, _non_empty('名称不能为空'), Field(pattern=r'^[\w\-\u4e00-\u9fa5]+$')]
    description: str = ''
    when_to_use: str = ''
    trigger_keywords: list[str] = Field(default=[], max_length=50)
    instructions: Annotated[str, _non_empty('指令内容不能为空')]
    enabled: bool = True


# ---------- Knowledge ----------
class KnowledgeInput(Input):
    name: Name
    description: str = ''
    enabled: bool = True


class TextDocumentInput(Input):
    title: Annotated[str, _non_empty('标题不能为空')]
    content: str


# ---------- Graphs ----------
class GraphInput(Input):
    name: Name
    description: str = ''
    enabled: bool = True
    entity_types: list[str] = []
    relation_types: list[str] = []


class EntityInput(Input):
    name: Annotated[str, _non_empty('实体名称不能为空')]
    type: str = 'concept'
    description: str = ''
    aliases: list[str] = []


class RelationInput(Input):
    source: Annotated[str, Field(min_length=1)]
    target: Annotated[str, Field(min_length=1)]
    relation_type: Annotated[str, _non_empty('关系类型不能为空')]
    description: str = ''


# ---------- Evaluation ----------
class EvalInput(Input):
    name: Name
    agent_id: Annotated[str, Field(min_length=1)]
    description: str = ''


class EvalCaseInput(Input):
    input: Annotated[str, _non_empty('输入不能为空')]
    expected_output: str = ''
    expected_tools: list[str] = []
