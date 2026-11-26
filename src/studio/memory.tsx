import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Brain, Trash2 } from 'lucide-react';
import { useStudio } from '../provider';
import type { Memory } from './schema';
import { Badge, Button, Empty, NativeSelect, Table, THead, TBody, Tr, Th, Td } from '../ui/primitives';
import { Confirm } from '../ui/overlay';
import {
  Page,
  PageBody,
  PageHeader,
  SearchBox,
  LoadState,
  keys,
  useAction,
  formatTime,
  matches,
} from './page';
import { useAgents } from './agents';

const layerLabel: Record<string, string> = {
  identity: '身份',
  semantic: '事实',
  episodic: '经历',
  lesson: '经验',
};

/**
 * What the engine memory plugin has remembered, per agent. Memories are written by the agents themselves;
 * here they can be reviewed and deleted.
 * 引擎记忆插件按 Agent 记下的内容；由 Agent 自己写入，这里可查看和删除。
 */
export function MemoryManager() {
  const { client } = useStudio();
  const agents = useAgents();
  const [agentId, setAgentId] = React.useState('');
  const [keyword, setKeyword] = React.useState('');
  const [deleting, setDeleting] = React.useState<Memory>();
  const q = useQuery({
    queryKey: keys.memories(agentId),
    queryFn: ({ signal }) => client.memories.list(agentId || undefined, signal),
  });
  const remove = useAction((m: Memory) => client.memories.remove(m.id), {
    invalidate: [['memories']],
    success: '已删除这条记忆',
  });
  const agentName = (id: string) => agents.data?.find((a) => a.id === id)?.name ?? id;
  const withMemory = agents.data?.filter((a) => a.plugins.memory?.enabled) ?? [];
  const rows = (q.data ?? []).filter((m) => matches(keyword, m.content, m.factType));
  return (
    <Page>
      <PageHeader
        title="记忆"
        description="Agent 在对话中记住的事实与偏好（引擎记忆插件）。在 Agent 的「插件」里开启「记忆系统」后才会写入。"
      >
        <SearchBox value={keyword} onChange={setKeyword} placeholder="搜索记忆内容" />
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
      </PageHeader>
      <PageBody>
        <LoadState loading={q.isLoading} error={q.error} />
        {q.data && rows.length === 0 && (
          <Empty icon={<Brain />} title={q.data.length ? '没有匹配的记忆' : '还没有记忆'}>
            {!q.data.length &&
              (withMemory.length
                ? `已开启记忆的 Agent：${withMemory.map((a) => a.name).join('、')}。和它们对话后，这里会出现记下的内容。引擎默认只保留 50 字以上的事实，中文对话建议在插件配置里把「最小内容长度」调小。`
                : '还没有 Agent 开启记忆系统。')}
          </Empty>
        )}
        {rows.length > 0 && (
          <Table>
            <THead>
              <Tr>
                <Th className="pl-6">内容</Th>
                <Th>Agent</Th>
                <Th>类型</Th>
                <Th>重要度</Th>
                <Th>使用次数</Th>
                <Th>记下时间</Th>
                <Th className="w-12 pr-6" />
              </Tr>
            </THead>
            <TBody>
              {rows.map((m) => (
                <Tr key={m.id}>
                  <Td className="max-w-xl pl-6 text-[13px] leading-relaxed">{m.content}</Td>
                  <Td className="text-[12px] whitespace-nowrap">{agentName(m.agentId)}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="secondary" className="font-normal">
                        {layerLabel[m.layer] ?? m.layer}
                      </Badge>
                      {m.factType && (
                        <Badge variant="outline" className="font-normal">
                          {m.factType}
                        </Badge>
                      )}
                    </div>
                  </Td>
                  <Td className="tabular-nums">{m.importance.toFixed(2)}</Td>
                  <Td className="tabular-nums">{m.accessCount}</Td>
                  <Td className="text-[12px] whitespace-nowrap text-muted-foreground">
                    {formatTime(m.createdAt)}
                  </Td>
                  <Td className="pr-6">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="删除这条记忆"
                      onClick={() => setDeleting(m)}
                    >
                      <Trash2 />
                    </Button>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </PageBody>
      <Confirm
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title="删除这条记忆？"
        description={deleting?.content}
        onConfirm={() => remove.mutateAsync(deleting!)}
      />
    </Page>
  );
}
