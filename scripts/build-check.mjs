import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const manifest = JSON.parse(readFileSync('app-dist/.vite/manifest.json', 'utf8'));
const initial = new Set();
function visit(key) {
  if (initial.has(key)) return;
  initial.add(key);
  for (const child of manifest[key].imports ?? []) visit(child);
}
visit('index.html');
// Dynamic imports can live on any chunk of the static graph (the SDK is bundled into shared chunks).
// 动态导入可能挂在静态图里任意一个分块上。
const lazy = [...new Set([...initial].flatMap((key) => manifest[key].dynamicImports ?? []))];
assert.ok(lazy.some((key) => key.includes('@streamdown/code')));
for (const key of lazy) assert.ok(!initial.has(key), `${key} leaked into the initial static graph`);
const initialFiles = [...initial].map((key) => readFileSync(`app-dist/${manifest[key].file}`));
// Check contents, not chunk names: Rollup may name a shared chunk after a small wrapper module.
// 按内容而非分块名检查：Rollup 可能用一个小包装模块的名字命名共享分块。
for (const marker of ['mermaidAPI', 'createHighlighter'])
  assert.ok(!initialFiles.some((f) => f.includes(marker)), `${marker} must stay out of the initial bundle`);
console.log(
  JSON.stringify(
    {
      libraryJavaScriptBytes: readdirSync('dist')
        .filter((name) => name.endsWith('.js'))
        .reduce((size, name) => size + statSync(`dist/${name}`).size, 0),
      libraryCssBytes: statSync('dist/styles.css').size,
      initialApplicationJavaScriptBytes: initialFiles.reduce((size, file) => size + file.length, 0),
      initialApplicationGzipBytes: initialFiles.reduce((size, file) => size + gzipSync(file).length, 0),
      deferredEntryFiles: lazy.map((key) => manifest[key].file),
    },
    null,
    2,
  ),
);
