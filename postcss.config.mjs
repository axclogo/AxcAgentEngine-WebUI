// Tailwind v4, then scope every selector under .axc-root so the SDK never styles the host page.
// Tailwind v4 编译后统一加 .axc-root 作用域，SDK 样式不外溢到宿主页面。
import tailwind from '@tailwindcss/postcss';
import prefixer from 'postcss-prefix-selector';
const ROOT = '.axc-root';
export default {
  plugins: [
    tailwind(),
    prefixer({
      prefix: ROOT,
      // Only the SDK stylesheet is scoped; host/demo CSS passes through. / 只限定 SDK 样式。
      includeFiles: [/src[\\/]styles\.css$/],
      transform(prefix, selector, prefixed) {
        if (selector.startsWith(ROOT)) return selector;
        if (/^(:root|:host|html|body)\b/.test(selector)) return selector.replace(/^(:root|:host|html|body)/, ROOT);
        if (selector.startsWith('.dark')) return selector.replace(/^\.dark/, `${ROOT}.dark`);
        // Utilities must also match the root element itself (e.g. className on <StudioProvider>).
        if (selector.startsWith('.')) return `${ROOT}${selector}, ${prefixed}`;
        return prefixed;
      },
    }),
    // Unwrap cascade layers: host pages ship unlayered CSS, which would otherwise always win.
    // 去掉 @layer：宿主页面的非分层样式否则总会压过 SDK。
    {
      postcssPlugin: 'axc-unlayer',
      OnceExit(root) {
        if (!/src[\\/]styles\.css$/.test(root.source?.input.file ?? '')) return;
        root.walkAtRules('layer', (rule) => {
          if (rule.nodes) rule.replaceWith(rule.nodes);
          else rule.remove();
        });
      },
    },
  ],
};
