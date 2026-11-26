// StudioClient: the single seam between the SDK and a host. Implement it directly, or use createHttpClient.
// StudioClient：SDK 与宿主之间唯一的接口。可直接实现，也可使用 createHttpClient。
import { z } from 'zod';
import {
  snapshotSchema,
  eventSchema,
  metaSchema,
  attachmentSchema,
  type Host,
  type Resource,
  type Scope,
} from './core';
import * as s from './studio/schema';

export interface Crud<T, I> {
  list(signal?: AbortSignal): Promise<T[]>;
  get(id: string, signal?: AbortSignal): Promise<T>;
  create(input: I): Promise<T>;
  update(id: string, input: I): Promise<T>;
  remove(id: string): Promise<void>;
}
export interface StudioClient extends Host {
  providers: Crud<s.Provider, s.ProviderInput> & {
    test(input: { id?: string; baseUrl: string; apiKey?: string }): Promise<s.ProviderTest>;
  };
  plugins(signal?: AbortSignal): Promise<s.PluginInfo[]>;
  agents: Crud<s.Agent, s.AgentInput> & {
    validate(input: s.AgentInput): Promise<s.Validation>;
    exportUrl(id: string): string;
  };
  skills: Crud<s.Skill, s.SkillInput> & { import(file: File): Promise<s.Skill> };
  knowledge: Crud<s.KnowledgeBase, s.KnowledgeInput> & {
    documents(id: string, signal?: AbortSignal): Promise<s.KnowledgeDocument[]>;
    upload(id: string, file: File): Promise<s.KnowledgeDocument>;
    addText(id: string, doc: { title: string; content: string }): Promise<s.KnowledgeDocument>;
    removeDocument(id: string, docId: string): Promise<void>;
    documentUrl(id: string, docId: string): string;
  };
  graphs: Crud<s.Graph, s.GraphInput> & {
    data(id: string, signal?: AbortSignal): Promise<s.GraphData>;
    upsertEntity(id: string, input: s.EntityInput): Promise<s.GraphEntity>;
    removeEntity(id: string, entityId: string): Promise<void>;
    addRelation(id: string, input: s.RelationInput): Promise<s.GraphRelation>;
    removeRelation(id: string, relationId: string): Promise<void>;
    import(id: string, file: File): Promise<s.GraphData>;
  };
  evals: Crud<s.EvalTask, s.EvalInput> & {
    cases(id: string, signal?: AbortSignal): Promise<s.EvalCase[]>;
    addCase(id: string, input: s.EvalCaseInput): Promise<s.EvalCase>;
    removeCase(id: string, caseId: string): Promise<void>;
    run(id: string): Promise<s.EvalTask>;
    results(id: string, signal?: AbortSignal): Promise<s.EvalResult[]>;
    review(id: string, caseId: string, review: s.EvalReview): Promise<s.EvalResult>;
    reportUrl(id: string): string;
  };
  mcp: Crud<s.McpServer, s.McpInput> & { test(id: string): Promise<s.McpTest> };
  memories: {
    list(agentId?: string, signal?: AbortSignal): Promise<s.Memory[]>;
    remove(id: string): Promise<void>;
  };
  analytics: {
    failures(query: AnalyticsQuery, signal?: AbortSignal): Promise<s.FailureReport>;
    distill(query: AnalyticsQuery, signal?: AbortSignal): Promise<s.DistillReport>;
    cost(query: AnalyticsQuery, signal?: AbortSignal): Promise<s.CostReport>;
  };
}
export interface AnalyticsQuery {
  agentId?: string;
  days: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function errorOf(response: Response) {
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    if (typeof body.error === 'string') return body.error;
    if (Array.isArray(body.detail)) return body.detail.map((d: { msg?: string }) => d.msg).join('；');
    if (typeof body.detail === 'string') return body.detail;
  } catch {
    /* not JSON */
  }
  return text || response.statusText;
}

export interface HttpClientOptions {
  /** API prefix, default `/api`. */
  base?: string;
  /** Extra headers for every request (auth tokens, tenant ids). / 附加请求头，例如鉴权。 */
  headers?: () => Record<string, string>;
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
}
const catalogSchema = z.object({
  agents: z.array(z.object({ id: z.string(), name: z.string(), avatar: z.string().optional() })),
  defaultAgentId: z.string(),
  create: z.boolean(),
  createSimulation: z.boolean(),
});
const resultSchema = z.object({
  events: z.array(eventSchema).optional(),
  resource: z
    .object({
      kind: z.enum(['conversation', 'simulation']),
      scope: z.object({
        key: z.string(),
        shortcut: z
          .object({ shortcut_key: z.string(), context: z.record(z.string(), z.unknown()) })
          .optional(),
      }),
      id: z.string(),
    })
    .optional(),
});

export function createHttpClient(options: HttpClientOptions = {}): StudioClient {
  const base = options.base ?? '/api';
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  async function call<T>(
    method: string,
    path: string,
    schema: z.ZodType<T> | null,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const form = body instanceof FormData;
    const response = await doFetch(base + path, {
      method,
      headers: {
        ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers?.(),
      },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      signal,
      credentials: options.credentials ?? 'same-origin',
    });
    if (!response.ok) throw new HttpError(response.status, await errorOf(response));
    if (!schema || response.status === 204) return undefined as T;
    return schema.parse(await response.json());
  }
  const fileForm = (file: File) => {
    const f = new FormData();
    f.append('file', file);
    return f;
  };
  function crud<T, I>(path: string, schema: z.ZodType<T>): Crud<T, I> {
    return {
      list: (signal) => call('GET', path, z.array(schema), undefined, signal),
      get: (id, signal) => call('GET', `${path}/${encodeURIComponent(id)}`, schema, undefined, signal),
      create: (input) => call('POST', path, schema, input),
      update: (id, input) => call('PUT', `${path}/${encodeURIComponent(id)}`, schema, input),
      remove: (id) => call('DELETE', `${path}/${encodeURIComponent(id)}`, null),
    };
  }
  const enc = encodeURIComponent;
  const analyticsQuery = (q: AnalyticsQuery) =>
    new URLSearchParams({ days: String(q.days), ...(q.agentId ? { agentId: q.agentId } : {}) }).toString();
  const scopeQuery = (scope: Scope) => enc(JSON.stringify(scope));
  const resourcePath = (r: Resource) => `/${r.kind}/${enc(r.id)}?scope=${scopeQuery(r.scope)}`;
  return {
    // ----- conversations & simulations -----
    catalog: (scope, signal) =>
      call('GET', `/catalog?scope=${scopeQuery(scope)}`, catalogSchema, undefined, signal),
    list: (kind, scope, filter, signal) =>
      call(
        'GET',
        `/${kind}?scope=${scopeQuery(scope)}&filter=${enc(JSON.stringify(filter))}`,
        z.array(metaSchema),
        undefined,
        signal,
      ),
    snapshot: (r, signal) => call('GET', resourcePath(r), snapshotSchema, undefined, signal),
    subscribe: (r, receive, reconnect, error) => {
      const source = new EventSource(base + resourcePath(r) + '&events=1', {
        withCredentials: (options.credentials ?? 'same-origin') !== 'omit',
      });
      source.onopen = reconnect;
      source.onmessage = (e) => {
        try {
          receive(eventSchema.parse(JSON.parse(e.data)));
        } catch (err) {
          error(err instanceof Error ? err : new Error(String(err)));
          source.close();
        }
      };
      source.onerror = () => error(new Error('连接中断，正在重新读取…'));
      return () => source.close();
    },
    command: (r, command) => call('POST', resourcePath(r), resultSchema, command),
    create: (scope, agentId) => call('POST', '/conversation', metaSchema, { scope, agentId }),
    saveSimulation: (scope, definition, id) =>
      call('POST', '/simulation', metaSchema, { scope, definition, id }),
    upload: async (r, file, signal) =>
      call(
        'POST',
        `/conversation/${enc(r.id)}/attachments?scope=${scopeQuery(r.scope)}`,
        attachmentSchema,
        fileForm(file),
        signal,
      ),
    // ----- management -----
    providers: {
      ...crud('/providers', s.providerSchema),
      test: (input) => call('POST', '/providers/test', s.providerTestSchema, input),
    },
    plugins: (signal) => call('GET', '/plugins', z.array(s.pluginInfoSchema), undefined, signal),
    agents: {
      ...crud('/agents', s.agentSchema),
      validate: (input) => call('POST', '/agents/validate', s.validationSchema, input),
      exportUrl: (id) => `${base}/agents/${enc(id)}/export`,
    },
    skills: {
      ...crud('/skills', s.skillSchema),
      import: (file) => call('POST', '/skills/import', s.skillSchema, fileForm(file)),
    },
    knowledge: {
      ...crud('/knowledge', s.knowledgeSchema),
      documents: (id, signal) =>
        call('GET', `/knowledge/${enc(id)}/documents`, z.array(s.knowledgeDocumentSchema), undefined, signal),
      upload: (id, file) =>
        call('POST', `/knowledge/${enc(id)}/documents`, s.knowledgeDocumentSchema, fileForm(file)),
      addText: (id, doc) => call('POST', `/knowledge/${enc(id)}/documents`, s.knowledgeDocumentSchema, doc),
      removeDocument: (id, docId) => call('DELETE', `/knowledge/${enc(id)}/documents/${enc(docId)}`, null),
      documentUrl: (id, docId) => `${base}/knowledge/${enc(id)}/documents/${enc(docId)}`,
    },
    graphs: {
      ...crud('/graphs', s.graphSchema),
      data: (id, signal) => call('GET', `/graphs/${enc(id)}/data`, s.graphDataSchema, undefined, signal),
      upsertEntity: (id, input) => call('POST', `/graphs/${enc(id)}/entities`, s.entitySchema, input),
      removeEntity: (id, entityId) => call('DELETE', `/graphs/${enc(id)}/entities/${enc(entityId)}`, null),
      addRelation: (id, input) => call('POST', `/graphs/${enc(id)}/relations`, s.relationSchema, input),
      removeRelation: (id, relationId) =>
        call('DELETE', `/graphs/${enc(id)}/relations/${enc(relationId)}`, null),
      import: (id, file) => call('POST', `/graphs/${enc(id)}/import`, s.graphDataSchema, fileForm(file)),
    },
    evals: {
      ...crud('/evals', s.evalSchema),
      cases: (id, signal) =>
        call('GET', `/evals/${enc(id)}/cases`, z.array(s.evalCaseSchema), undefined, signal),
      addCase: (id, input) => call('POST', `/evals/${enc(id)}/cases`, s.evalCaseSchema, input),
      removeCase: (id, caseId) => call('DELETE', `/evals/${enc(id)}/cases/${enc(caseId)}`, null),
      run: (id) => call('POST', `/evals/${enc(id)}/run`, s.evalSchema, {}),
      results: (id, signal) =>
        call('GET', `/evals/${enc(id)}/results`, z.array(s.evalResultSchema), undefined, signal),
      review: (id, caseId, review) =>
        call('PUT', `/evals/${enc(id)}/results/${enc(caseId)}`, s.evalResultSchema, review),
      reportUrl: (id) => `${base}/evals/${enc(id)}/report`,
    },
    mcp: {
      ...crud('/mcp', s.mcpSchema),
      test: (id) => call('POST', `/mcp/${enc(id)}/test`, s.mcpTestSchema, {}),
    },
    memories: {
      list: (agentId, signal) =>
        call(
          'GET',
          `/memories${agentId ? `?agentId=${enc(agentId)}` : ''}`,
          z.array(s.memorySchema),
          undefined,
          signal,
        ),
      remove: (id) => call('DELETE', `/memories/${enc(id)}`, null),
    },
    analytics: {
      failures: (q, signal) =>
        call('GET', `/analytics/failures?${analyticsQuery(q)}`, s.failureReportSchema, undefined, signal),
      distill: (q, signal) =>
        call('GET', `/analytics/distill?${analyticsQuery(q)}`, s.distillReportSchema, undefined, signal),
      cost: (q, signal) =>
        call('GET', `/analytics/cost?${analyticsQuery(q)}`, s.costReportSchema, undefined, signal),
    },
  };
}
