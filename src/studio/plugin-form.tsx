// Renders an engine PluginConfigSchema as a form. Values not set stay out of agent.yaml (engine defaults apply).
// 按引擎插件 config_schema 渲染配置表单；未设置的值不写入 agent.yaml，沿用引擎默认。
import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import type { PluginField } from './schema';
import { Input, Switch, Textarea, TagInput, NativeSelect, Label } from '../ui/primitives';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/overlay';
import { cn } from '../lib/utils';

type Config = Record<string, unknown>;
const show = (v: unknown) =>
  v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

function FieldControl({
  field,
  value,
  onChange,
  id,
}: {
  field: PluginField;
  value: unknown;
  onChange: (v: unknown) => void;
  id: string;
}) {
  const placeholder =
    field.default === undefined || field.default === null ? '' : `默认 ${show(field.default)}`;
  if (field.type === 'boolean')
    return (
      <Switch
        id={id}
        checked={(value ?? field.default ?? false) as boolean}
        onCheckedChange={(v) => onChange(v === (field.default ?? false) ? undefined : v)}
      />
    );
  if (field.enum.length)
    return (
      <NativeSelect id={id} value={show(value)} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{placeholder || '默认'}</option>
        {field.enum.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </NativeSelect>
    );
  if (field.type === 'integer' || field.type === 'number')
    return (
      <Input
        id={id}
        type="number"
        step={field.type === 'integer' ? 1 : 'any'}
        placeholder={placeholder}
        value={show(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    );
  if (field.type === 'array' && (!field.itemSchema || field.itemSchema.type === 'string'))
    return (
      <TagInput
        id={id}
        value={Array.isArray(value) ? (value as string[]) : []}
        onChange={(v) => onChange(v.length ? v : undefined)}
        placeholder={placeholder || '回车添加'}
      />
    );
  if (field.type === 'object' || field.type === 'array')
    return <JsonControl id={id} value={value} onChange={onChange} placeholder={placeholder} />;
  return (
    <Input
      id={id}
      placeholder={placeholder}
      value={show(value)}
      onChange={(e) => onChange(e.target.value || undefined)}
    />
  );
}
function JsonControl({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: unknown;
  onChange: (v: unknown) => void;
  placeholder: string;
}) {
  const [text, setText] = React.useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [bad, setBad] = React.useState(false);
  return (
    <>
      <Textarea
        id={id}
        className="font-mono text-[12px]"
        rows={4}
        aria-invalid={bad}
        placeholder={placeholder || 'JSON'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!text.trim()) {
            setBad(false);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(text));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <p className="text-xs text-destructive">JSON 格式不正确</p>}
    </>
  );
}

export function PluginConfigForm({
  plugin,
  fields,
  value,
  onChange,
}: {
  plugin: string;
  fields: PluginField[];
  value: Config;
  onChange: (v: Config) => void;
}) {
  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  const basic = fields.filter((f) => !f.advanced && f.key !== 'enabled');
  const advanced = fields.filter((f) => f.advanced && f.key !== 'enabled');
  const render = (list: PluginField[]) => (
    <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
      {list.map((f) => {
        const id = `${plugin}-${f.key}`;
        const wide = f.type === 'object' || f.type === 'array';
        return (
          <div key={f.key} className={cn('flex min-w-0 flex-col gap-1.5', wide && 'sm:col-span-2')}>
            <Label htmlFor={id} title={f.key}>
              {f.label || f.key}
              <code className="ml-1 font-mono text-[10px] font-normal text-muted-foreground">{f.key}</code>
            </Label>
            <FieldControl field={f} value={value[f.key]} onChange={(v) => set(f.key, v)} id={id} />
            {f.description && (
              <p className="text-xs leading-relaxed text-muted-foreground">{f.description}</p>
            )}
          </div>
        );
      })}
    </div>
  );
  if (!basic.length && !advanced.length)
    return <p className="text-sm text-muted-foreground">该插件没有可配置项。</p>;
  return (
    <div className="flex flex-col gap-4">
      {basic.length > 0 && render(basic)}
      {advanced.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
            高级配置（{advanced.length}）
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">{render(advanced)}</CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
