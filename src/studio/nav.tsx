import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStudio } from '../provider';
import { keys } from './page';
import type { ComboGroup } from '../ui/overlay';
import type { Provider } from './schema';

export type SectionId =
  | 'chat'
  | 'archive'
  | 'agents'
  | 'models'
  | 'skills'
  | 'knowledge'
  | 'graphs'
  | 'tools'
  | 'simulation'
  | 'evals';
export interface NavTarget {
  section: SectionId;
  /** e.g. agentId for chat, graph id for graphs */
  id?: string;
}
/** Cross-section navigation provided by AgentStudio; standalone components get a no-op. */
export const NavContext = React.createContext<((t: NavTarget) => void) | null>(null);
export const useNavigate = () => React.useContext(NavContext);

export type ModelSlot = 'main' | 'utility' | 'vision' | 'image';
/** Provider → model cascade groups filtered for a slot. / 按槽位过滤的提供商→模型级联选项。 */
export function modelGroups(providers: Provider[], slot: ModelSlot): ComboGroup[] {
  return providers
    .filter((p) => p.enabled)
    .map((p) => ({
      label: p.name,
      options: p.models
        .filter((m) =>
          slot === 'image' ? m.type === 'image' : m.type === 'llm' && (slot !== 'vision' || m.vision),
        )
        .map((m) => ({
          value: `${p.id}:${m.id}`,
          label: m.label || m.id,
          hint: m.label ? m.id : m.vision && slot !== 'vision' ? '视觉' : undefined,
          keywords: [m.id, p.name],
        })),
    }))
    .filter((g) => g.options.length > 0);
}
export function useProviders() {
  const { client } = useStudio();
  return useQuery({ queryKey: keys.providers, queryFn: ({ signal }) => client.providers.list(signal) });
}
export function modelLabel(providers: Provider[] | undefined, ref: string | null) {
  if (!ref) return null;
  const i = ref.indexOf(':');
  const p = providers?.find((x) => x.id === ref.slice(0, i));
  const m = p?.models.find((x) => x.id === ref.slice(i + 1));
  return p && m ? `${p.name} / ${m.label || m.id}` : null;
}
