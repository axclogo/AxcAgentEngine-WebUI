import { it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown, SafeLink } from '../src/markdown';
it('supports Chinese, tables, cross-block references and authorized business links', () => {
  render(
    <Markdown
      text={
        '中文\n\n|标题|值|\n|---|---|\n|甲|乙|\n\n[跨块][ref]\n\n[ref]: https://example.com\n\n[业务](https://example.com/entities/2)'
      }
      Link={({ href, children }) => <button data-href={href}>{children}</button>}
    />,
  );
  expect(screen.getByText('中文')).toBeTruthy();
  expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.getByText('跨块').getAttribute('data-href')).toBe('https://example.com/');
  expect(screen.getByText('业务').getAttribute('data-href')).toContain('https://example.com/entities/');
});
it('unsafe links retain text and unopened fences retain source', () => {
  const view = render(
    <>
      <SafeLink href="javascript:alert(1)">禁止</SafeLink>
      <SafeLink href="https://example.com">正常</SafeLink>
      <Markdown text={'```ts\nconst 中文 = 1;'} streaming />
    </>,
  );
  expect(screen.getByText('禁止').tagName).toBe('SPAN');
  expect(screen.getByText('正常').tagName).toBe('A');
  expect(screen.getByText('查看 Markdown 源码')).toBeTruthy();
  view.unmount();
});

it('lazy Mermaid renderer exposes parse failure with original source', async () => {
  const view = render(<Markdown text={'```mermaid\nnot-a-diagram\n```'} />);
  await screen.findByText('重试图表', {}, { timeout: 15000 });
  expect(screen.getAllByText('not-a-diagram').length).toBeGreaterThan(0);
  view.unmount();
});
