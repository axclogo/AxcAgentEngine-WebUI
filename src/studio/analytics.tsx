import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Coins, Lightbulb } from 'lucide-react';
import { useStudio } from '../provider';
import { Badge, Empty, NativeSelect, Table, THead, TBody, Tr, Th, Td } from '../ui/primitives';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/overlay';
import { Page, PageBody, PageHeader, LoadState, keys, formatTokens } from './page';
import { useAgents } from './agents';
import { useNavigate } from './nav';
import type { AnalyticsQuery } from '../client';

// Categories and suggestions from the engine failure miner (sidecar/failure_miner/core.py), shown in Chinese.
// 引擎失败分析的分类与建议，在界面上以中文展示。
const categoryLabel: Record<string, string> = {
  timeout: '超时',
  policy: '权限策略',
  format: '输出格式',
  tool: '工具',
  provider_limit: '模型服务限流',
  context_budget: '上下文超限',
  unknown: '未分类',
};
const suggestion = (category: string, tool: string) =>
  ({
    timeout: '增加超时预算或进度检查点，或把任务拆成更小的步骤。',
    policy: '检查能力权限配置，确认 Agent 只拥有所需的权限。',
    format: '为这条路径加上输出格式校验或更严格的结构修复（output_format 插件）。',
    tool: tool ? `为工具 ${tool} 增加契约测试并完善错误映射。` : '增加工具契约测试并完善结构化错误映射。',
    provider_limit: '调整模型路由、备用模型、限流或重试退避。',
    context_budget: '缩减提示词与上下文，或调整上下文治理（compress 插件）的压缩边界。',
  })[category] ?? '查看样例，把反复出现的失败整理成评估用例。';

// The distiller and cost optimizer emit fixed English templates; show them in Chinese. Text that matches
// no known template (a newer engine) is shown unchanged rather than guessed.
// 蒸馏与成本模块输出固定的英文模板，这里译成中文；不认识的模板原样显示，不做猜测。
const templates: [RegExp, (...m: string[]) => string][] = [
  [/^Avoid repeating failure pattern: (.*)$/s, (e) => `避免重复出现的失败：${e}`],
  [/^Create a skill for recurring '(.*)' tasks$/, (t) => `为反复出现的「${t}」类任务创建技能`],
  [
    /^Prefer tool '(.*)' for similar tasks when its inputs are available\.$/,
    (t) => `同类任务在条件具备时优先使用工具 ${t}`,
  ],
  [
    /^Treat '(.*)' tasks as a recurring task family and route them through a repeatable checklist\.$/,
    (t) => `把「${t}」视为一类常见任务，用固定的检查清单来处理`,
  ],
  [/^Highest spend Agent: (.*)$/, (a) => `花费最高的 Agent：${a}`],
  [/^Highest spend model: (.*)$/, (m) => `花费最高的模型：${m}`],
  [/^Large contexts without compression$/, () => '大上下文运行未启用压缩'],
  [/^Slow Agent: (.*)$/, (a) => `响应慢的 Agent：${a}`],
  [/^Failed runs still consume budget: (.*)$/, (a) => `失败的运行仍在消耗预算：${a}`],
  [
    /^Review model choice, context size, and tool strategy for this Agent\.$/,
    () => '检查这个 Agent 的模型选择、上下文大小和工具策略。',
  ],
  [
    /^Consider routing simple or utility tasks to a cheaper provider\.$/,
    () => '把简单或辅助性任务交给更便宜的模型。',
  ],
  [
    /^Enable or tighten compression boundaries for large-context runs\.$/,
    () => '为大上下文运行开启或收紧压缩（compress 插件）。',
  ],
  [
    /^Inspect tool latency, provider routing, and step decomposition\.$/,
    () => '排查工具耗时、模型路由和步骤拆分。',
  ],
  [
    /^Mine failures into eval cases and add earlier validation or guardrails\.$/,
    () => '把失败整理成评估用例，并更早加入校验或防护。',
  ],
];
const zh = (text: string) => {
  for (const [re, fn] of templates) {
    const m = re.exec(text);
    if (m) return fn(...m.slice(1));
  }
  return text;
};

/**
 * Reports built by the engine sidecars from recorded conversation runs: failure clusters, distilled
 * rules and skill candidates, and cost with optimization findings.
 * 由引擎旁路模块基于对话运行记录生成：失败聚类、经验蒸馏、成本分析。
 */
export function AnalyticsManager() {
  const agents = useAgents();
  const [agentId, setAgentId] = React.useState('');
  const [days, setDays] = React.useState(30);
  const query: AnalyticsQuery = { agentId: agentId || undefined, days };
  return (
    <Page>
      <PageHeader
        title="分析"
        description="基于对话运行记录，用引擎的失败分析、经验蒸馏和成本分析模块生成报告。"
      >
        <NativeSelect
          aria-label="Agent"
          className="w-44"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          <option value="">全部 Agent</option>
          {agents.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.avatar} {a.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="时间范围"
          className="w-32"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={7}>最近 7 天</option>
          <option value={30}>最近 30 天</option>
          <option value={90}>最近 90 天</option>
        </NativeSelect>
      </PageHeader>
      <PageBody className="px-6 py-5">
        <Tabs defaultValue="failures" className="flex max-w-5xl flex-col gap-4">
          <TabsList className="self-start">
            <TabsTrigger value="failures">
              <AlertTriangle className="size-3.5" />
              失败分析
            </TabsTrigger>
            <TabsTrigger value="distill">
              <Lightbulb className="size-3.5" />
              经验蒸馏
            </TabsTrigger>
            <TabsTrigger value="cost">
              <Coins className="size-3.5" />
              成本
            </TabsTrigger>
          </TabsList>
          <TabsContent value="failures">
            <Failures query={query} agentName={(id) => agents.data?.find((a) => a.id === id)?.name ?? id} />
          </TabsContent>
          <TabsContent value="distill">
            <Distill query={query} />
          </TabsContent>
          <TabsContent value="cost">
            <Cost query={query} agentName={(id) => agents.data?.find((a) => a.id === id)?.name ?? id} />
          </TabsContent>
        </Tabs>
      </PageBody>
    </Page>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Failures({ query, agentName }: { query: AnalyticsQuery; agentName: (id: string) => string }) {
  const { client } = useStudio();
  const q = useQuery({
    queryKey: keys.analytics('failures', query.agentId ?? '', query.days),
    queryFn: ({ signal }) => client.analytics.failures(query, signal),
  });
  if (!q.data) return <LoadState loading={q.isLoading} error={q.error} />;
  const r = q.data;
  if (!r.records) return <Empty icon={<AlertTriangle />} title="这段时间没有失败的运行或工具调用" />;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="失败记录" value={r.records} />
        <Stat label="失败模式" value={r.clusters.length} />
        {Object.entries(r.categoryCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([c, n]) => (
            <Stat key={c} label={categoryLabel[c] ?? c} value={n} />
          ))}
      </div>
      <ul className="flex flex-col gap-2.5" aria-label="失败模式">
        {r.clusters.map((c) => (
          <li key={c.key} className="rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="destructive" className="font-normal">
                {categoryLabel[c.category] ?? c.category}
              </Badge>
              <span className="font-medium">出现 {c.count} 次</span>
              <span className="text-xs text-muted-foreground">严重度 {c.severity.toFixed(2)}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {c.agents.map(agentName).join('、')}
              </span>
            </div>
            <p className="mt-2 text-sm" title={c.suggestedAction}>
              <span className="text-muted-foreground">建议：</span>
              {suggestion(c.category, c.examples[0]?.toolName ?? '')}
            </p>
            <ul className="mt-2 flex flex-col gap-1 border-l-2 pl-3 text-[12px] text-muted-foreground">
              {c.examples.slice(0, 3).map((e) => (
                <li key={e.id} className="line-clamp-2">
                  {e.toolName && <code className="mr-1 font-mono">{e.toolName}</code>}
                  {e.message || e.task}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Distill({ query }: { query: AnalyticsQuery }) {
  const { client } = useStudio();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: keys.analytics('distill', query.agentId ?? '', query.days),
    queryFn: ({ signal }) => client.analytics.distill(query, signal),
  });
  if (!q.data) return <LoadState loading={q.isLoading} error={q.error} />;
  const r = q.data;
  if (!r.traces) return <Empty icon={<Lightbulb />} title="这段时间还没有运行记录" />;
  const rules = (title: string, list: typeof r.rules, tone: 'default' | 'destructive') =>
    list.length > 0 && (
      <section>
        <h3 className="mb-2 text-sm font-medium">{title}</h3>
        <ul className="flex flex-col gap-2">
          {list.map((x) => (
            <li key={x.text} className="rounded-lg border bg-card px-3 py-2.5 text-sm">
              <div className="flex items-start gap-2">
                <p className="flex-1">{zh(x.text)}</p>
                <Badge variant={tone} className="font-normal">
                  置信度 {Math.round(x.confidence * 100)}%
                </Badge>
              </div>
              {x.evidence.length > 0 && (
                <p className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">
                  依据：{x.evidence.join('；')}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">基于 {r.traces} 次运行。</p>
      {rules('有效做法', r.rules, 'default')}
      {rules('应避免', r.antiPatterns, 'destructive')}
      {r.toolPreferences.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium">工具偏好</h3>
          <ul className="list-disc pl-5 text-sm">
            {r.toolPreferences.map((t) => (
              <li key={t}>{zh(t)}</li>
            ))}
          </ul>
        </section>
      )}
      {r.skillCandidates.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium">可以沉淀为技能</h3>
          <div className="flex flex-wrap gap-2">
            {r.skillCandidates.map((t) => (
              <Badge key={t} variant="outline" className="font-normal">
                {zh(t)}
              </Badge>
            ))}
          </div>
          {navigate && (
            <button
              type="button"
              className="mt-2 cursor-pointer text-sm text-primary hover:underline"
              onClick={() => navigate({ section: 'skills' })}
            >
              去 Skills 新建
            </button>
          )}
        </section>
      )}
      {!r.rules.length &&
        !r.antiPatterns.length &&
        !r.toolPreferences.length &&
        !r.skillCandidates.length && <Empty title="运行记录还太少，暂时提炼不出规律" />}
    </div>
  );
}

function Cost({ query, agentName }: { query: AnalyticsQuery; agentName: (id: string) => string }) {
  const { client } = useStudio();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: keys.analytics('cost', query.agentId ?? '', query.days),
    queryFn: ({ signal }) => client.analytics.cost(query, signal),
  });
  if (!q.data) return <LoadState loading={q.isLoading} error={q.error} />;
  const r = q.data;
  if (!r.samples) return <Empty icon={<Coins />} title="这段时间还没有运行记录" />;
  const money = (n: number) => n.toFixed(4);
  const breakdown = (title: string, data: Record<string, number>, label: (k: string) => string) => (
    <section className="min-w-0 flex-1">
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      <Table>
        <TBody>
          {Object.entries(data)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => (
              <Tr key={k}>
                <Td className="truncate">{label(k)}</Td>
                <Td className="text-right tabular-nums">{money(v)}</Td>
              </Tr>
            ))}
        </TBody>
      </Table>
    </section>
  );
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="运行次数" value={r.samples} />
        <Stat label="总 token" value={formatTokens(r.totalTokens)} />
        <Stat label="估算花费" value={money(r.totalCost)} />
        <Stat label="未配置价格的运行" value={r.unpricedSamples} />
      </div>
      {r.unpricedSamples > 0 && (
        <p className="text-sm text-muted-foreground">
          有 {r.unpricedSamples} 次运行使用的模型没有配置价格，花费按 0 计算。
          {navigate && (
            <button
              type="button"
              className="ml-1 cursor-pointer text-primary hover:underline"
              onClick={() => navigate({ section: 'models' })}
            >
              去「模型」填写每千 token 价格
            </button>
          )}
        </p>
      )}
      <div className="flex flex-col gap-5 sm:flex-row">
        {breakdown('按 Agent', r.byAgent, agentName)}
        {breakdown('按模型', r.byModel, (k) => k)}
      </div>
      {r.findings.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium">优化建议</h3>
          <Table>
            <THead>
              <Tr>
                <Th>发现</Th>
                <Th>影响</Th>
                <Th>建议</Th>
              </Tr>
            </THead>
            <TBody>
              {r.findings.map((f) => (
                <Tr key={f.title}>
                  <Td className="font-medium">{zh(f.title)}</Td>
                  <Td className="tabular-nums">{money(f.impact)}</Td>
                  <Td className="text-[13px] text-muted-foreground">{zh(f.recommendation)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </section>
      )}
    </div>
  );
}
