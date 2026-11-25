import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Streamdown, type PluginConfig, type MermaidErrorComponentProps } from 'streamdown';
function MermaidError({ error, chart, retry }: MermaidErrorComponentProps) {
  return (
    <div role="alert">
      <p>{error}</p>
      <button type="button" onClick={retry}>
        重试图表
      </button>
      <pre>{chart}</pre>
    </div>
  );
}
export interface LinkProps {
  href: string;
  children: ReactNode;
}
export interface MarkdownProps {
  text: string;
  streaming?: boolean;
  Link?: ComponentType<LinkProps>;
}
export function SafeLink({ href, children }: LinkProps) {
  return /^(https?:|mailto:|\/|#)/i.test(href) && !href.startsWith('//') ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}
export function Markdown({ text, streaming = false, Link = SafeLink }: MarkdownProps) {
  const [plugins, setPlugins] = useState<PluginConfig>({});
  const [error, setError] = useState('');
  const code = /(```|~~~)/.test(text),
    diagram = /(```|~~~)mermaid/.test(text);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const next: PluginConfig = {};
      if (code) next.code = (await import('@streamdown/code')).code;
      if (diagram)
        next.mermaid = (await import('@streamdown/mermaid')).createMermaidPlugin({
          config: { securityLevel: 'strict' },
        });
      if (live) setPlugins(next);
    };
    void load().catch((e) => {
      if (live) setError(String(e));
    });
    return () => {
      live = false;
    };
  }, [code, diagram]);
  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: ReactNode }) => (
        <Link href={href ?? ''}>{children}</Link>
      ),
    }),
    [Link],
  );
  return (
    <div className="axc-md">
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        isAnimating={streaming}
        plugins={plugins}
        components={components}
        controls={{
          table: false,
          code: { copy: true, download: false },
          mermaid: { copy: true, download: false, fullscreen: false, panZoom: false },
        }}
        mermaid={{ config: { securityLevel: 'strict' }, errorComponent: MermaidError }}
      >
        {text}
      </Streamdown>
      {error && <p role="alert">{error}</p>}
      {code && (
        <details className="mt-1 text-xs text-muted-foreground [&_pre]:mt-1.5 [&_pre]:max-h-80 [&_pre]:whitespace-pre-wrap [&>summary]:w-fit [&>summary]:cursor-pointer">
          <summary>查看 Markdown 源码</summary>
          <pre>{text}</pre>
        </details>
      )}
    </div>
  );
}
