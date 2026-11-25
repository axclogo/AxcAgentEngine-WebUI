"""Evaluation tasks run with the engine ``EvalRunner``. / 使用引擎 EvalRunner 的评估任务。

Scores are reported on 0-10 (engine scores are 0-1); a case passes at >= 6 without error.
The judge is the agent's utility model (else main). In fixture mode (shared deterministic model) no LLM
judge is used: a case scores 10 when ``expectedOutput`` is empty or contained in the output and every
``expectedTools`` entry was called, otherwise 0.
分数为 0–10，≥6 且无错误为通过。fixture 模式不使用 LLM 裁判，改为确定性包含匹配。
"""
from __future__ import annotations
import asyncio
import logging
from axc_agent_engine.sidecar.eval.runner import EvalCase, EvalRunner
from ..schemas import EvalCaseInput, EvalInput
from .common import Collection, NotFound, now, uid

PASS_SCORE = 6.0
logger = logging.getLogger(__name__)


def deterministic_judge(case: EvalCase, result) -> float:
    expected = (case.expected_output or '').strip()
    output_ok = not expected or expected in (result.actual_output or '')
    tools_ok = set(case.expected_tools) <= set(result.actual_tools)
    return 1.0 if output_ok and tools_ok and not result.error else 0.0


class EvalService:
    def __init__(self, db, agents):
        self.items = Collection(db, 'eval', '评估任务')
        self.cases = Collection(db, 'eval_case', '用例')
        self.db = db
        self.agents = agents
        self.tasks: dict[str, asyncio.Task] = {}

    def case_list(self, ident: str) -> list[dict]:
        self.items.get(ident)
        return [{k: v for k, v in c.items() if k not in ('evalId', 'createdAt')}
                for c in self.cases.all() if c['evalId'] == ident]

    def public(self, row: dict) -> dict:
        return {**row, 'caseCount': sum(1 for c in self.cases.all() if c['evalId'] == row['id'])}

    def list(self) -> list[dict]:
        return [self.public(r) for r in self.items.all()]

    def save(self, body: EvalInput, ident: str | None = None) -> dict:
        self.agents.items.get(body.agent_id)
        old = self.items.get(ident) if ident else None
        if old and old['status'] == 'running':
            raise ValueError('评估运行中，不可编辑')
        stamp = now()
        row = {'status': 'idle', 'avgScore': None, 'passRate': None, 'error': '', **(old or {}), **body.dump(),
               'id': ident or uid(), 'createdAt': old['createdAt'] if old else stamp, 'updatedAt': stamp}
        return self.public(self.items.put(row))

    def delete(self, ident: str) -> None:
        if self.items.get(ident)['status'] == 'running':
            raise ValueError('评估运行中，不可删除')
        self.items.remove(ident)
        for c in self.cases.all():
            if c['evalId'] == ident:
                self.cases.remove(c['id'])
        self.db.remove('eval_result', ident)

    def add_case(self, ident: str, body: EvalCaseInput) -> dict:
        self.items.get(ident)
        row = {**body.dump(), 'id': uid(), 'evalId': ident, 'createdAt': now()}
        self.cases.put(row)
        return {k: v for k, v in row.items() if k not in ('evalId', 'createdAt')}

    def remove_case(self, ident: str, case_id: str) -> None:
        case = self.cases.get(case_id)
        if case['evalId'] != ident:
            raise NotFound('用例不存在')
        self.cases.remove(case_id)

    def results(self, ident: str) -> list[dict]:
        self.items.get(ident)
        return self.db.get('eval_result', ident) or []

    def start(self, ident: str, host) -> dict:
        row = self.items.get(ident)
        if row['status'] == 'running':
            raise ValueError('评估已在运行')
        cases = self.case_list(ident)
        if not cases:
            raise ValueError('请先添加用例')
        self.agents.items.get(row['agentId'])
        row = self.items.put({**row, 'status': 'running', 'error': '', 'updatedAt': now()})
        self.tasks[ident] = asyncio.create_task(self._run(ident, row['agentId'], cases, host))
        return self.public(row)

    async def _run(self, ident: str, agent_id: str, cases: list[dict], host) -> None:
        judge = None
        try:
            await host.agent(agent_id)
            judge = self.agents.judge_model(agent_id, host.model)
            runner = EvalRunner(host.engine, agent_id)
            engine_cases = [EvalCase(input=c['input'], expected_output=c['expectedOutput'] or None,
                                     expected_tools=list(c['expectedTools']), case_id=c['id']) for c in cases]
            results = await runner.run_cases(engine_cases, judge_llm=judge,
                                             custom_judge=deterministic_judge if judge is None else None)
            out = []
            for r in results:
                score = round(max(0.0, min(1.0, float(r.score))) * 10, 2)
                out.append({'caseId': r.case_id, 'input': r.input, 'output': r.actual_output, 'tools': list(r.actual_tools),
                            'score': score, 'passed': score >= PASS_SCORE and not r.error,
                            'reason': r.judge_reason, 'durationMs': r.duration_ms, 'error': r.error})
            self.db.put('eval_result', ident, out)
            avg = round(sum(r['score'] for r in out) / len(out), 2) if out else None
            rate = round(sum(r['passed'] for r in out) / len(out), 4) if out else None
            self._finish(ident, status='completed', avgScore=avg, passRate=rate)
        except asyncio.CancelledError:
            self._finish(ident, status='failed', error='评估被中断')
            raise
        except Exception as exc:
            logger.exception('eval %s failed', ident)
            self._finish(ident, status='failed', error=str(exc))
        finally:
            if judge is not None:
                await judge.close()

    def _finish(self, ident: str, **changes) -> None:
        row = self.items.find(ident)
        if row:
            self.items.put({**row, **changes, 'updatedAt': now()})
