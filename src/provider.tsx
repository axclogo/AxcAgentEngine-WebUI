import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import type { StudioClient } from './client';
import type { LinkProps } from './markdown';
import type { Message } from './core';
import { PortalContext, TooltipProvider } from './ui/overlay';
import { cn } from './lib/utils';

export type Theme = 'light' | 'dark' | 'system';
export interface StudioConfig {
  client: StudioClient;
  /** Host-side link renderer for message links (permissions, in-app drawers). / 宿主链接渲染。 */
  Link?: React.ComponentType<LinkProps>;
  /** Override message rendering; return null/undefined for the default Markdown. */
  renderMessage?: (message: Message) => React.ReactNode;
}
const StudioContext = React.createContext<StudioConfig | null>(null);
export function useStudio(): StudioConfig {
  const value = React.useContext(StudioContext);
  if (!value) throw new Error('Agent Studio 组件需要放在 <StudioProvider> 内');
  return value;
}

function useResolvedTheme(theme: Theme) {
  const [system, setSystem] = React.useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches,
  );
  React.useEffect(() => {
    if (theme !== 'system' || typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystem(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [theme]);
  return theme === 'system' ? (system ? 'dark' : 'light') : theme;
}

export interface StudioProviderProps extends StudioConfig {
  theme?: Theme;
  className?: string;
  style?: React.CSSProperties;
  /** Share a QueryClient with the host app; one is created otherwise. */
  queryClient?: QueryClient;
  children: React.ReactNode;
}
/**
 * Root of every SDK surface: scopes styles (.axc-root), theme, portals, data cache and toasts.
 * 所有 SDK 界面的根：样式作用域、主题、浮层容器、数据缓存与通知。
 */
export function StudioProvider({
  client,
  Link,
  renderMessage,
  theme = 'light',
  className,
  style,
  queryClient,
  children,
}: StudioProviderProps) {
  const [qc] = React.useState(
    () =>
      queryClient ??
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
      }),
  );
  const [portal, setPortal] = React.useState<HTMLDivElement | null>(null);
  const resolved = useResolvedTheme(theme);
  const config = React.useMemo(() => ({ client, Link, renderMessage }), [client, Link, renderMessage]);
  return (
    <div
      className={cn('axc-root', resolved === 'dark' && 'dark', className)}
      style={style}
      data-theme={resolved}
    >
      <QueryClientProvider client={qc}>
        <StudioContext.Provider value={config}>
          <PortalContext.Provider value={portal}>
            <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
          </PortalContext.Provider>
        </StudioContext.Provider>
      </QueryClientProvider>
      <div ref={setPortal} className="contents" />
      <Toaster
        theme={resolved}
        position="top-center"
        richColors
        closeButton
        toastOptions={{ style: { fontFamily: 'inherit' } }}
      />
    </div>
  );
}
