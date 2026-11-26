"""Reports from recorded conversation runs via the engine sidecars. / 用引擎旁路模块从运行记录生成报告。

- failures: ``failure_miner`` over failed runs (run error) and failed tool calls.
- distill: ``distiller`` over one trace per run (score 1.0 on success, else 0.0).
- cost: ``cost_optimizer`` with prices from provider model entries (``inputPricePer1k/outputPricePer1k``).
"""
from __future__ import annotations
from axc_agent_engine.sidecar.cost_optimizer.core import CostEstimator, CostReportBuilder, CostSample, ModelPrice
from axc_agent_engine.sidecar.distiller.core import DistillationReportBuilder, ExecutionTrace, TraceStep
from axc_agent_engine.sidecar.failure_miner.core import FailureRecord, FailureReportBuilder


def _rule(rule) -> dict:
    return {'text': rule.text, 'confidence': rule.confidence, 'evidence': list(rule.evidence)}


class AnalyticsService:
    def __init__(self, runs, providers):
        self.runs, self.providers = runs, providers

    def failures(self, agent_id: str | None, days: int) -> dict:
        records = []
        for run in self.runs.query(agent_id, days):
            if run['error']:
                records.append(FailureRecord(record_id=run['id'], agent_name=run['agentId'], message=run['error'],
                                             task=run['task']))
            for i, call in enumerate(run['toolCalls']):
                if not call['success']:
                    records.append(FailureRecord(record_id=f"{run['id']}:{i}", agent_name=run['agentId'],
                                                 message=call['error'], tool_name=call['name'], task=run['task']))
        report = FailureReportBuilder().build(records)
        return {
            'records': report.metadata['records'],
            'categoryCounts': report.category_counts,
            'clusters': [{
                'key': c.key, 'category': c.category, 'count': c.count, 'severity': c.severity,
                'agents': sorted(c.affected_agents), 'suggestedAction': c.suggested_action,
                'examples': [{'id': e.record_id, 'agentId': e.agent_name, 'message': e.message, 'task': e.task,
                              'toolName': e.tool_name} for e in c.examples],
            } for c in report.clusters],
        }

    def distill(self, agent_id: str | None, days: int) -> dict:
        traces = [ExecutionTrace(
            trace_id=run['id'], task=run['task'], agent_name=run['agentId'], success=run['success'],
            score=1.0 if run['success'] else 0.0,
            steps=[TraceStep(role='tool', tool_name=c['name'], success=c['success'], error=c['error'])
                   for c in run['toolCalls']] + ([TraceStep(role='assistant', success=False, error=run['error'])]
                                                 if run['error'] else []),
        ) for run in self.runs.query(agent_id, days)]
        report = DistillationReportBuilder().build(traces)
        return {'traces': report.metadata['traces'], 'rules': [_rule(r) for r in report.rules],
                'toolPreferences': list(report.tool_preferences), 'antiPatterns': [_rule(r) for r in report.anti_patterns],
                'skillCandidates': list(report.skill_candidates)}

    def prices(self) -> dict[str, ModelPrice]:
        """ModelRef -> price for entries with any price set; a missing side counts as 0. / 已配置价格的模型。"""
        out = {}
        for provider in self.providers.items.all():
            for m in provider['models']:
                if m['inputPricePer1k'] is not None or m['outputPricePer1k'] is not None:
                    out[f"{provider['id']}:{m['id']}"] = ModelPrice(m['inputPricePer1k'] or 0.0, m['outputPricePer1k'] or 0.0)
        return out

    def cost(self, agent_id: str | None, days: int) -> dict:
        prices = self.prices()
        runs = self.runs.query(agent_id, days)
        samples = [CostSample(sample_id=r['id'], agent_name=r['agentId'], model=r['model'], input_tokens=r['inputTokens'],
                              output_tokens=r['outputTokens'], duration_ms=r['durationMs'], tool_calls=len(r['toolCalls']),
                              success=r['success']) for r in runs]
        report = CostReportBuilder(CostEstimator(prices)).build(samples)
        return {
            'samples': report.metadata['samples'], 'totalCost': report.total_cost, 'totalTokens': report.total_tokens,
            'unpricedSamples': sum(1 for s in samples if s.model not in prices),
            'byAgent': report.by_agent, 'byModel': report.by_model,
            'findings': [{'title': f.title, 'impact': f.impact, 'recommendation': f.recommendation,
                          'evidence': list(f.evidence)} for f in report.findings],
        }
