import * as React from 'react';
import {
  Bot,
  BookOpen,
  ClipboardCheck,
  Cpu,
  MessageSquare,
  MessagesSquare,
  Moon,
  Archive,
  BarChart3,
  Plug,
  Brain,
  Puzzle,
  Share2,
  Sparkles,
  Sun,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { StudioProvider, type StudioProviderProps, type Theme } from './provider';
import { NavContext, type NavTarget, type SectionId } from './studio/nav';
import { Workbench } from './workbench';
import { AgentManager } from './studio/agents';
import { ProviderManager } from './studio/providers';
import { SkillManager } from './studio/skills';
import { KnowledgeManager } from './studio/knowledge';
import { GraphManager } from './studio/graphs';
import { ToolCatalog } from './studio/tools';
import { EvalManager } from './studio/evals';
import { ArchiveManager } from './studio/archive';
import { AnalyticsManager } from './studio/analytics';
import { McpManager } from './studio/mcp';
import { MemoryManager } from './studio/memory';
import { SimulationManager } from './simulation-view';
import type { Scope } from './core';
import { cn } from './lib/utils';
import { Tip } from './ui/overlay';

export type { SectionId } from './studio/nav';
const SECTIONS: {
  id: SectionId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group: string;
}[] = [
  { id: 'chat', label: '对话', icon: MessageSquare, group: '工作' },
  { id: 'archive', label: '归档', icon: Archive, group: '工作' },
  { id: 'simulation', label: '推演', icon: MessagesSquare, group: '工作' },
  { id: 'evals', label: '评估', icon: ClipboardCheck, group: '工作' },
  { id: 'analytics', label: '分析', icon: BarChart3, group: '工作' },
  { id: 'agents', label: 'Agent', icon: Bot, group: '配置' },
  { id: 'models', label: '模型', icon: Cpu, group: '配置' },
  { id: 'skills', label: 'Skills', icon: Sparkles, group: '资源' },
  { id: 'knowledge', label: '知识库', icon: BookOpen, group: '资源' },
  { id: 'graphs', label: '图谱', icon: Share2, group: '资源' },
  { id: 'mcp', label: 'MCP 服务', icon: Plug, group: '资源' },
  { id: 'memory', label: '记忆', icon: Brain, group: '资源' },
  { id: 'tools', label: '工具目录', icon: Puzzle, group: '资源' },
];

export interface AgentStudioProps extends Omit<StudioProviderProps, 'children'> {
  /** Sections to show, in this order. Default: all. / 要展示的分区，默认全部。 */
  sections?: SectionId[];
  /** Controlled section; omit for internal state. */
  section?: SectionId;
  onSectionChange?: (s: SectionId) => void;
  /** Business scope for conversations and simulations. Default `{ key: 'local' }`. */
  scope?: Scope;
  /** Brand shown at the top of the navigation. */
  brand?: React.ReactNode;
  /** Shows a theme toggle when provided. */
  onThemeChange?: (t: Theme) => void;
}

/**
 * Complete Agent workshop: chat, simulation, evaluation, agents, models and resources.
 * Each section is also exported as a standalone component for hosts that compose their own pages.
 * 完整的 Agent 工坊；每个分区也单独导出，宿主可自行组合。
 */
export function AgentStudio({
  sections = SECTIONS.map((s) => s.id),
  section,
  onSectionChange,
  scope = { key: 'local' },
  brand = (
    <>
      <span className="font-bold tracking-wide text-primary">AXC</span>
      <span className="text-muted-foreground">Agent Studio</span>
    </>
  ),
  onThemeChange,
  ...provider
}: AgentStudioProps) {
  const [inner, setInner] = React.useState<NavTarget>({ section: section ?? sections[0] });
  const current = section ? { ...inner, section } : inner;
  const [collapsed, setCollapsed] = React.useState(false);
  const navigate = React.useCallback(
    (t: NavTarget) => {
      setInner({ ...t, key: Date.now() } as NavTarget);
      onSectionChange?.(t.section);
    },
    [onSectionChange],
  );
  const visible = SECTIONS.filter((s) => sections.includes(s.id));
  const groups = [...new Set(visible.map((s) => s.group))];
  const dark = provider.theme === 'dark';
  const page = (() => {
    const k = (current as NavTarget & { key?: number }).key;
    switch (current.section) {
      case 'chat':
        return (
          <Workbench
            key={`${current.id}-${k}`}
            scope={scope}
            initialAgentId={current.id}
            manageAgents={sections.includes('agents')}
          />
        );
      case 'archive':
        return <ArchiveManager key={k} scope={scope} initialAgentId={current.id} />;
      case 'simulation':
        return <SimulationManager scope={scope} />;
      case 'evals':
        return <EvalManager />;
      case 'agents':
        return <AgentManager />;
      case 'models':
        return <ProviderManager />;
      case 'skills':
        return <SkillManager />;
      case 'knowledge':
        return <KnowledgeManager />;
      case 'graphs':
        return <GraphManager key={k} initialId={current.id} />;
      case 'analytics':
        return <AnalyticsManager />;
      case 'mcp':
        return <McpManager />;
      case 'memory':
        return <MemoryManager />;
      case 'tools':
        return <ToolCatalog />;
    }
  })();
  return (
    <StudioProvider {...provider}>
      <NavContext.Provider value={navigate}>
        <div className="@container flex h-full min-h-0">
          <nav
            aria-label="工坊导航"
            className={cn(
              'flex shrink-0 flex-col border-r bg-sidebar transition-[width]',
              collapsed ? 'w-14' : 'w-14 @5xl:w-48',
            )}
          >
            <div
              className={cn(
                'flex h-12 items-center gap-1.5 overflow-hidden px-4 text-[13.5px] whitespace-nowrap',
                collapsed ? 'hidden' : 'hidden @5xl:flex',
              )}
            >
              {brand}
            </div>
            <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-2 py-2">
              {groups.map((g, gi) => (
                <React.Fragment key={g}>
                  {gi > 0 && <li aria-hidden className="mx-2 my-1.5 h-px bg-border" />}
                  {visible
                    .filter((s) => s.group === g)
                    .map((s) => {
                      const Icon = s.icon;
                      const active = current.section === s.id;
                      const button = (
                        <button
                          type="button"
                          aria-current={active ? 'page' : undefined}
                          onClick={() => navigate({ section: s.id })}
                          className={cn(
                            'flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                            active &&
                              'bg-accent font-medium text-accent-foreground hover:bg-accent hover:text-accent-foreground',
                          )}
                        >
                          <Icon className="size-[16px] shrink-0" />
                          <span
                            className={cn('truncate', collapsed ? 'sr-only' : 'sr-only @5xl:not-sr-only')}
                          >
                            {s.label}
                          </span>
                        </button>
                      );
                      return <li key={s.id}>{collapsed ? <Tip content={s.label}>{button}</Tip> : button}</li>;
                    })}
                </React.Fragment>
              ))}
            </ul>
            <div className="flex flex-col gap-0.5 border-t px-2 py-2">
              {onThemeChange && (
                <button
                  type="button"
                  onClick={() => onThemeChange(dark ? 'light' : 'dark')}
                  className="flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {dark ? (
                    <Sun className="size-[16px] shrink-0" />
                  ) : (
                    <Moon className="size-[16px] shrink-0" />
                  )}
                  <span className={cn(collapsed ? 'sr-only' : 'sr-only @5xl:not-sr-only')}>
                    {dark ? '浅色' : '深色'}
                  </span>
                </button>
              )}
              <button
                type="button"
                aria-label={collapsed ? '展开导航' : '收起导航'}
                onClick={() => setCollapsed((v) => !v)}
                className="hidden h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground @5xl:flex"
              >
                {collapsed ? (
                  <PanelLeftOpen className="size-[16px]" />
                ) : (
                  <PanelLeftClose className="size-[16px]" />
                )}
                {!collapsed && <span>收起</span>}
              </button>
            </div>
          </nav>
          <div className="min-w-0 flex-1">{page}</div>
        </div>
      </NavContext.Provider>
    </StudioProvider>
  );
}
