// Radix overlays. Portals render into the SDK root so scoped styles and theme still apply.
// Radix 浮层：Portal 渲染到 SDK 根节点内，作用域样式与主题继续生效。
import * as React from 'react';
import {
  Dialog as D,
  AlertDialog as AD,
  DropdownMenu as DM,
  Popover as P,
  Tooltip as T,
  Tabs as TabsPrimitive,
  Collapsible as C,
} from 'radix-ui';
import { Command as CommandPrimitive } from 'cmdk';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './primitives';

export const PortalContext = React.createContext<HTMLElement | null>(null);
export const usePortal = () => React.useContext(PortalContext) ?? undefined;

const overlayCls =
  'fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0';
const popCls =
  'z-50 rounded-lg border bg-popover text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95';

// ---------- Dialog ----------
export const Dialog = D.Root;
export function DialogContent({
  className,
  children,
  title,
  description,
  footer,
  size = 'md',
  ...props
}: React.ComponentProps<typeof D.Content> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  return (
    <D.Portal container={usePortal()}>
      <D.Overlay className={overlayCls} />
      <D.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-card shadow-xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size],
          className,
        )}
        {...props}
      >
        <div className="flex items-start gap-3 border-b px-5 py-4">
          <div className="min-w-0 flex-1">
            <D.Title className="text-base font-semibold">{title}</D.Title>
            {description ? (
              <D.Description className="mt-0.5 text-sm text-muted-foreground">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{title}</D.Description>
            )}
          </div>
          <D.Close asChild>
            <Button variant="ghost" size="icon-sm" aria-label="关闭">
              <X />
            </Button>
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t px-5 py-3">{footer}</div>}
      </D.Content>
    </D.Portal>
  );
}

/** Right-side sheet, used for editors and details. / 右侧抽屉，用于编辑与详情。 */
export function SheetContent({
  className,
  children,
  title,
  description,
  footer,
  width = 'max-w-2xl',
  ...props
}: React.ComponentProps<typeof D.Content> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  return (
    <D.Portal container={usePortal()}>
      <D.Overlay className={overlayCls} />
      <D.Content
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-card shadow-xl outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right',
          width,
          className,
        )}
        {...props}
      >
        <div className="flex items-start gap-3 border-b px-5 py-4">
          <div className="min-w-0 flex-1">
            <D.Title className="truncate text-base font-semibold">{title}</D.Title>
            <D.Description className={description ? 'mt-0.5 text-sm text-muted-foreground' : 'sr-only'}>
              {description ?? title}
            </D.Description>
          </div>
          <D.Close asChild>
            <Button variant="ghost" size="icon-sm" aria-label="关闭">
              <X />
            </Button>
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t px-5 py-3">{footer}</div>}
      </D.Content>
    </D.Portal>
  );
}

// ---------- Confirm ----------
export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  confirmText = '删除',
  destructive = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmText?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  return (
    <AD.Root open={open} onOpenChange={onOpenChange}>
      <AD.Portal container={usePortal()}>
        <AD.Overlay className={overlayCls} />
        <AD.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-card p-5 shadow-xl data-[state=open]:animate-in data-[state=open]:zoom-in-95">
          <AD.Title className="text-base font-semibold">{title}</AD.Title>
          <AD.Description className="mt-2 text-sm text-muted-foreground">
            {description ?? '此操作无法撤销。'}
          </AD.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AD.Cancel asChild>
              <Button variant="outline">取消</Button>
            </AD.Cancel>
            <Button
              variant={destructive ? 'destructive' : 'default'}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  onOpenChange(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmText}
            </Button>
          </div>
        </AD.Content>
      </AD.Portal>
    </AD.Root>
  );
}

// ---------- Dropdown menu ----------
export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
export function MenuContent({ className, align = 'end', ...props }: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal container={usePortal()}>
      <DM.Content align={align} sideOffset={4} className={cn(popCls, 'min-w-40 p-1', className)} {...props} />
    </DM.Portal>
  );
}
export function MenuItem({
  className,
  destructive,
  ...props
}: React.ComponentProps<typeof DM.Item> & { destructive?: boolean }) {
  return (
    <DM.Item
      className={cn(
        'relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted [&_svg]:size-4 [&_svg]:text-muted-foreground',
        destructive && 'text-destructive data-[highlighted]:bg-destructive/10 [&_svg]:text-destructive',
        className,
      )}
      {...props}
    />
  );
}
export const MenuSeparator = () => <DM.Separator className="-mx-1 my-1 h-px bg-border" />;

// ---------- Popover / Tooltip ----------
export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export function PopoverContent({
  className,
  align = 'start',
  ...props
}: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Portal container={usePortal()}>
      <P.Content align={align} sideOffset={4} className={cn(popCls, 'p-0', className)} {...props} />
    </P.Portal>
  );
}
export function Tip({ content, children }: { content: React.ReactNode; children: React.ReactElement }) {
  return (
    <T.Root delayDuration={300}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal container={usePortal()}>
        <T.Content
          sideOffset={4}
          className="z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
export const TooltipProvider = T.Provider;

// ---------- Combobox (cmdk), supports grouped/cascading options ----------
export interface ComboGroup {
  label: string;
  options: { value: string; label: string; hint?: string; keywords?: string[] }[];
}
export function Combobox({
  value,
  onChange,
  groups,
  placeholder = '请选择',
  searchPlaceholder = '搜索…',
  empty = '没有匹配项',
  clearable = true,
  id,
  'aria-label': ariaLabel,
  className,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  groups: ComboGroup[];
  placeholder?: string;
  searchPlaceholder?: string;
  empty?: React.ReactNode;
  clearable?: boolean;
  id?: string;
  'aria-label'?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = groups
    .flatMap((g) => g.options.map((o) => ({ ...o, group: g.label })))
    .find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          className={cn(
            'flex h-9 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-left text-[12.5px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20',
            className,
          )}
        >
          {selected ? (
            <span className="min-w-0 truncate">
              {groups.length > 1 && <span className="text-muted-foreground">{selected.group} / </span>}
              {selected.label}
            </span>
          ) : value ? (
            <span className="truncate text-destructive">{value}（不可用）</span>
          ) : (
            <span className="truncate text-muted-foreground">{placeholder}</span>
          )}
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[max(var(--radix-popover-trigger-width),18rem)]">
        <CommandPrimitive className="flex flex-col">
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 text-muted-foreground" />
            <CommandPrimitive.Input
              placeholder={searchPlaceholder}
              className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <CommandPrimitive.List className="max-h-72 overflow-auto p-1">
            <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground">
              {empty}
            </CommandPrimitive.Empty>
            {clearable && value && (
              <CommandPrimitive.Item
                value="__clear__"
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
                className="cursor-pointer rounded-md px-2 py-1.5 text-sm text-muted-foreground data-[selected=true]:bg-muted"
              >
                清除选择
              </CommandPrimitive.Item>
            )}
            {groups.map((g) => (
              <CommandPrimitive.Group
                key={g.label}
                heading={g.label}
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {g.options.map((o) => (
                  <CommandPrimitive.Item
                    key={o.value}
                    value={`${g.label} ${o.label} ${o.value}`}
                    keywords={o.keywords}
                    onSelect={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-muted"
                  >
                    <Check className={cn('size-4', o.value === value ? 'opacity-100' : 'opacity-0')} />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            ))}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </PopoverContent>
    </Popover>
  );
}

/** Multi-select with search. / 可搜索的多选。 */
export function MultiCombobox({
  value,
  onChange,
  options,
  placeholder = '请选择',
  'aria-label': ariaLabel,
  id,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  options: { value: string; label: string; hint?: string }[];
  placeholder?: string;
  'aria-label'?: string;
  id?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const labels = value.map((v) => options.find((o) => o.value === v)?.label ?? v);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          className="flex min-h-9 w-full min-w-0 cursor-pointer flex-wrap items-center gap-1 rounded-md border border-input bg-card px-2 py-1 text-left text-[12.5px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20"
        >
          {labels.length ? (
            labels.map((l, i) => (
              <span key={value[i]} className="rounded bg-muted px-1.5 text-[12px]">
                {l}
              </span>
            ))
          ) : (
            <span className="px-1 text-muted-foreground">{placeholder}</span>
          )}
          <ChevronDown className="ml-auto size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[max(var(--radix-popover-trigger-width),16rem)]">
        <CommandPrimitive>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 text-muted-foreground" />
            <CommandPrimitive.Input
              placeholder="搜索…"
              className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <CommandPrimitive.List className="max-h-72 overflow-auto p-1">
            <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground">
              暂无可选项
            </CommandPrimitive.Empty>
            {options.map((o) => {
              const on = value.includes(o.value);
              return (
                <CommandPrimitive.Item
                  key={o.value}
                  value={`${o.label} ${o.value}`}
                  onSelect={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-muted"
                >
                  <span
                    className={cn(
                      'flex size-4 items-center justify-center rounded-[4px] border',
                      on && 'border-primary bg-primary text-primary-foreground',
                    )}
                  >
                    {on && <Check className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
                </CommandPrimitive.Item>
              );
            })}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </PopoverContent>
    </Popover>
  );
}

// ---------- Tabs ----------
export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex h-9 items-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        className,
      )}
      {...props}
    />
  );
}
export const TabsContent = TabsPrimitive.Content;

// ---------- Collapsible ----------
export const Collapsible = C.Root;
export const CollapsibleTrigger = C.Trigger;
export const CollapsibleContent = C.Content;
