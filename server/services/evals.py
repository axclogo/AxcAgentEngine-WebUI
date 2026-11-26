"""Evaluation tasks run with the engine ``EvalRunner``. / 使用引擎 EvalRunner 的评估任务。

Scores are reported on 0-10 (engine scores are 0-1); a case passes at >= 6 without error.
The judge is the agent's utility model (else main). In fixture mode (shared deterministic model) no LLM
judge is used: a case scores 10 when ``expectedOutput`` is empty or contained in the output and every
``expectedTools`` entry was called, otherwise 0.
分数为 0–10，≥6 且无错误为通过。fixture 模式不使用 LLM 裁判，改为确定性包含匹配。
A human verdict (``manualPassed``) overrides ``passed`` in the task pass rate. / 人工判定覆盖自动结果。
"""
from __future__ import annotations
import asyncio
import logging
from axc_agent_engine.sidecar.eval.report import generate_report
from axc_agent_engine.sidecar.eval.runner import EvalCase, EvalResult, EvalRunner
from ..schemas import EvalCaseInput, EvalInput, EvalReview
from .common import Collection, NotFound, now, uid

PASS_SCORE = 6.0
logger = logging.getLogger(__name__)


def pass_rate(results: list[dict]) -> float | None:
    if not results:
        return None
    verdicts = [r['passed'] if r['manualPassed'] is None else r['manualPassed'] for r in results]
    return round(sum(verdicts) / len(verdicts), 4)
def cell(text) -> str:
    return str(text).replace('|', '\\|').replace('\n', ' ')
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

    def review(self, ident: str, case_id: str, body: EvalReview) -> dict:
        if self.items.get(ident)['status'] == 'running':
            raise ValueError('评估运行中，不可标注')
        results = self.results(ident)
        target = next((r for r in results if r['caseId'] == case_id), None)
        if target is None:
            raise NotFound('评估结果不存在')
        target.update(body.dump())
        self.db.put('eval_result', ident, results)
        self._finish(ident, passRate=pass_rate(results))
        return target
    def report(self, ident: str) -> str:
        """Markdown: engine ``generate_report`` summary, then per-case verdicts and notes.
        The engine scores on 0-1 with ``pass_threshold`` on the same scale, so stored 0-10 scores are divided by
        10 and the threshold is PASS_SCORE / 10. Its pass count is score-only; the manual-aware rate follows.
        引擎报告使用 0–1 分制，这里把 0–10 分与阈值同除以 10；引擎通过数只看分数，人工修正后的通过率另列。"""
        task = self.public(self.items.get(ident))
        results = self.results(ident)
        engine = generate_report([EvalResult(case_id=r['caseId'], input=r['input'], actual_output=r['output'],
                                             actual_tools=list(r['tools']), score=r['score'] / 10, judge_reason=r['reason'],
                                             input_tokens=r['inputTokens'], output_tokens=r['outputTokens'],
                                             duration_ms=r['durationMs'], error=r['error']) for r in results],
                                 pass_threshold=PASS_SCORE / 10)
        agent = self.agents.items.find(task['agentId'])
        rate = pass_rate(results)
        lines = [f"# 评估报告：{task['name']}", '', f"- Agent：{agent['name'] if agent else task['agentId']}",
                 f"- 状态：{task['status']}", f"- 通过率（含人工标注）：{'—' if rate is None else f'{rate:.0%}'}", '',
                 '## 汇总', '', '```', engine.summary(), '```', '', '## 用例', '',
                 '| # | 输入 | 分数 | 自动判定 | 人工判定 | 备注 | 错误 |', '|---|---|---|---|---|---|---|']
        verdict = {True: '通过', False: '未通过', None: '—'}
        for i, r in enumerate(results, 1):
            lines.append(f"| {i} | {cell(r['input'])} | {r['score']} | {verdict[r['passed']]} | {verdict[r['manualPassed']]} "
                         f"| {cell(r['note'])} | {cell(r['error'])} |")
        return '\n'.join(lines) + '\n'
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
                            'reason': r.judge_reason, 'durationMs': r.duration_ms, 'error': r.error,
                            'inputTokens': r.input_tokens, 'outputTokens': r.output_tokens, 'manualPassed': None, 'note': ''})
            self.db.put('eval_result', ident, out)
            avg = round(sum(r['score'] for r in out) / len(out), 2) if out else None
            self._finish(ident, status='completed', avgScore=avg, passRate=pass_rate(out))
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
