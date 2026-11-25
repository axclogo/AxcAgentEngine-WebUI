"""First-start demo data (idempotent; skipped with ``AXC_SEED=0``). / 首次启动演示数据。"""
from ..schemas import AgentInput, EntityInput, GraphInput, KnowledgeInput, RelationInput, SkillInput

GENERAL_ID = 'agent-general'
PLANNER_ID = 'agent-planner'

DEMO_DOC = """# AxcAgentEngine 工作台

工作台是 AxcAgentEngine 的示例宿主，提供 Agent 管理、技能、知识库、图谱、评估、对话与推演。

- 模型提供商的密钥在服务端加密保存。
- 每个 Agent 可绑定技能、知识库和一个图谱。
"""


def _agent(name, avatar, strategy, description, prompt, bindings):
    return AgentInput.model_validate({
        'name': name, 'avatar': avatar, 'description': description, 'systemPrompt': prompt, 'strategy': strategy,
        'runtime': {}, 'models': {}, 'plugins': {}, 'bindings': bindings,
    })


def seed(host) -> None:
    db = host.db
    if db.get('meta', 'seeded') or host.agents_svc.items.all():
        return
    skill = host.skills.save(SkillInput.model_validate({
        'name': 'concise-answer', 'description': '用简洁的要点回答问题', 'whenToUse': '用户希望快速得到结论时',
        'triggerKeywords': ['简洁', '要点'], 'instructions': '先给出一句话结论，再用不超过三条要点说明理由。'}))
    kb = host.knowledge.save(KnowledgeInput(name='工作台说明', description='示例知识库'))
    host.knowledge.add_text(kb['id'], '工作台简介', DEMO_DOC)
    graph = host.graphs.save(GraphInput(name='示例图谱', description='工作台组成', entity_types=['system', 'feature'],
                                        relation_types=['HAS_FEATURE']))
    for name, kind, text in (('AxcAgentEngine', 'system', 'Agent 执行引擎'), ('工作台', 'system', '示例宿主'),
                             ('知识库', 'feature', '文档检索'), ('知识图谱', 'feature', '实体与关系')):
        host.graphs.upsert_entity(graph['id'], EntityInput(name=name, type=kind, description=text))
    for source, target, rel in (('工作台', 'AxcAgentEngine', 'USES'), ('工作台', '知识库', 'HAS_FEATURE'),
                                ('工作台', '知识图谱', 'HAS_FEATURE')):
        host.graphs.upsert_relation(graph['id'], RelationInput(source=source, target=target, relation_type=rel))
    host.agents_svc.save(_agent('通用助手', '🤖', 'react', '可直接对话的通用 Agent', '你是一个乐于助人的中文助手。',
                                {'skills': [skill['id']], 'knowledge': [kb['id']], 'graph': graph['id']}), fixed_id=GENERAL_ID)
    host.agents_svc.save(_agent('规划助手', '🧭', 'por', '先规划再执行的 Agent', '你擅长拆解任务并按步骤执行。',
                                {'skills': [], 'knowledge': [], 'graph': None}), fixed_id=PLANNER_ID)
    db.put('meta', 'seeded', True)
