"""One-time data migrations of stored documents, run at startup. / 启动时执行的一次性数据迁移。

Records are JSON documents read without re-validation, so a contract change must rewrite existing rows once
instead of every reader tolerating old shapes. ``meta/schemaVersion`` records the applied version.
存储文档读取时不再校验，因此协议变化时一次性改写旧数据，而不是让每个读取方兼容旧格式。
"""

VERSION = 4


def _v2(db) -> None:
    """Contract 0.2 additions: drop the ``image`` model type and agent slot; add MCP bindings, model prices,
    knowledge embedding models, eval review fields and conversation prompts.
    去掉 image 模型类型与槽位；补齐 MCP 绑定、模型价格、知识库向量模型、评估标注字段与会话提示。"""
    for key, row in db.items('provider'):
        row['models'] = [{'inputPricePer1k': None, 'outputPricePer1k': None, **m} for m in row['models'] if m['type'] != 'image']
        db.put('provider', key, row)
    for key, row in db.items('agent'):
        row['models'].pop('image', None)
        row['bindings'].setdefault('mcp', [])
        db.put('agent', key, row)
    for key, row in db.items('knowledge'):
        row.setdefault('embeddingModel', None)
        db.put('knowledge', key, row)
    for key, results in db.items('eval_result'):
        db.put('eval_result', key, [{'inputTokens': 0, 'outputTokens': 0, 'manualPassed': None, 'note': '', **r} for r in results])
    for key, row in db.items('resource'):
        row['snapshot'].setdefault('prompts', [])
        db.put('resource', key, row)


def _v3(db) -> None:
    """Session operations: agent runtime switches and conversation provenance / wake-up fields.
    会话操作：Agent 运行开关，以及会话的来源链与唤醒计数字段。"""
    for key, row in db.items('agent'):
        row['runtime'].setdefault('sessionOperations', False)
        row['runtime'].setdefault('maxWakeups', 100)
        db.put('agent', key, row)
    for key, row in db.items('resource'):
        if row['kind'] == 'conversation':
            m = row['snapshot']['meta']
            m.setdefault('provenance', {'depth': 0, 'chain': [], 'parentSessionId': None, 'parentRunId': None,
                                        'rootSessionId': None})
            for field, value in (('autoWakeups', 0), ('forkCheckpointId', None), ('archivedReason', None),
                                 ('editedFrom', None)):
                m.setdefault(field, value)
            db.put('resource', key, row)


def _v4(db) -> None:
    """Agent-level pre-authorization of session access. / Agent 级别的会话预先授权。"""
    for key, row in db.items('agent'):
        row['runtime'].setdefault('sessionGrants', [])
        db.put('agent', key, row)


def migrate(db) -> None:
    version = db.get('meta', 'schemaVersion') or 1
    if version < 2:
        _v2(db)
    if version < 3:
        _v3(db)
    if version < 4:
        _v4(db)
    db.put('meta', 'schemaVersion', VERSION)
