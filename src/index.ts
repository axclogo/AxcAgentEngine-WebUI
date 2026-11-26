// @axc/agent-workbench — Agent Studio SDK.
// Full app: <AgentStudio client={createHttpClient()} />. Single surfaces: wrap in <StudioProvider>.
export { AgentStudio } from './studio';
export type { AgentStudioProps, SectionId } from './studio';
export { StudioProvider, useStudio } from './provider';
export type { StudioProviderProps, StudioConfig, Theme } from './provider';
export { createHttpClient, HttpError } from './client';
export type { StudioClient, Crud, HttpClientOptions, AnalyticsQuery } from './client';
export { Workbench } from './workbench';
export type { WorkbenchProps } from './workbench';
export { SimulationDetail, SimulationManager, SimulationForm } from './simulation-view';
export type { SimulationDetailProps, SimulationManagerProps } from './simulation-view';
export { AgentManager, AgentEditor } from './studio/agents';
export { ProviderManager } from './studio/providers';
export { SkillManager } from './studio/skills';
export { KnowledgeManager } from './studio/knowledge';
export { GraphManager } from './studio/graphs';
export { ToolCatalog } from './studio/tools';
export { EvalManager } from './studio/evals';
export { ArchiveManager } from './studio/archive';
export { AnalyticsManager } from './studio/analytics';
export { McpManager } from './studio/mcp';
export { MemoryManager } from './studio/memory';
export { NavContext } from './studio/nav';
export type { NavTarget } from './studio/nav';
export { Markdown, SafeLink } from './markdown';
export type { MarkdownProps, LinkProps } from './markdown';
export * from './studio/schema';
export type {
  Host,
  Scope,
  Resource,
  Message,
  MessagePart,
  Meta,
  Command,
  Capabilities,
  Snapshot,
  ResourceEvent,
  Attachment,
  Prompt,
  AccessChoice,
  Grant,
  EditPreview,
  CommandResult,
  SimulationDefinition,
  Mode,
} from './core';
