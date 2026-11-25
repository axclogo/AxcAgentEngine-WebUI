// Acceptance run against an already running studio (real model provider configured in the UI).
// Each step is independent: failures are collected with a screenshot instead of aborting.
// 针对已启动的工坊（界面里已配置真实模型）逐项验收；单步失败记录截图后继续。
// Usage: node scripts/real-check.mjs [baseUrl]   (AXC_BROWSER_PATH optional, AXC_SHOTS default /tmp/shots/real)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const out = process.env.AXC_SHOTS ?? '/tmp/shots/real';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.AXC_BROWSER_PATH });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.setDefaultTimeout(30000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const results = [];
const stamp = Date.now().toString(36);
const nav = (label) =>
  page
    .getByRole('navigation', { name: '工坊导航' })
    .getByRole('button', { name: label, exact: true })
    .click();
const dlg = () => page.getByRole('dialog').last();
const shot = (n) => page.screenshot({ path: join(out, `${n}.png`) });
const LONG = 180000;
async function settled(before) {
  // A real run: a new assistant message appears and the header status leaves 运行中. / 新回复出现且状态离开运行中。
  if (before !== undefined)
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-message-id]').length >= n + 2,
      before,
      { timeout: LONG },
    );
  await page.waitForTimeout(500);
  await page.getByRole('status').filter({ hasNotText: '运行中' }).first().waitFor({ timeout: LONG });
  const s = await page.getByRole('status').first().innerText();
  if (!/已完成/.test(s)) throw new Error(`运行结束状态：${s}；${await lastAssistant()}`);
}
async function lastAssistant() {
  const t = await page
    .locator('[data-message-id]')
    .last()
    .innerText()
    .catch(() => '');
  return t.replace(/\s+/g, ' ').slice(0, 200);
}
async function step(name, fn) {
  const t = Date.now();
  try {
    const note = await fn();
    results.push(['✓', name, `${((Date.now() - t) / 1000).toFixed(1)}s`, note ?? '']);
  } catch (e) {
    results.push([
      '✗',
      name,
      `${((Date.now() - t) / 1000).toFixed(1)}s`,
      e.message.replace(/\s+/g, ' ').slice(0, 400),
    ]);
    await shot(`fail-${results.length}`).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  }
  console.log(results.at(-1).join('  '));
}
async function send(text) {
  const before = await page.locator('[data-message-id]').count();
  await page.getByLabel('消息').fill(text);
  await page.getByRole('button', { name: '发送' }).click();
  await settled(before);
  return lastAssistant();
}

await page.goto(base);

await step('模型：提供商可连通', async () => {
  await nav('模型');
  await page.getByRole('button', { name: /操作$/ }).first().click();
  await page.getByRole('menuitem', { name: '测试连接' }).click();
  await page
    .getByText(/连接成功/)
    .first()
    .waitFor();
});

const agentName = `验收助手-${stamp}`;
await step('Agent：新建并级联选择真实模型、绑定资源', async () => {
  await nav('Agent');
  await page.getByRole('button', { name: '新建 Agent' }).click();
  await dlg().getByLabel('名称').fill(agentName);
  await dlg().getByLabel('系统提示词').fill('你是验收助手，回答简洁，用中文。');
  await page.getByRole('tab', { name: '模型' }).click();
  await page.getByRole('combobox', { name: '主模型' }).click();
  await page.getByRole('option').first().click();
  await page.getByRole('tab', { name: '知识与技能' }).click();
  await page.getByRole('combobox', { name: '技能' }).click();
  await page.getByRole('option').first().click();
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: '知识库' }).click();
  await page.getByRole('option').first().click();
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: '图谱' }).click();
  await page.getByRole('option').last().click();
  await page.getByRole('button', { name: '校验并预览 YAML' }).click();
  await page.getByRole('heading', { name: '校验通过' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: `${agentName} 操作` }).waitFor();
});

await step('对话：真实模型多轮', async () => {
  await page
    .getByRole('button', { name: `${agentName} 操作` })
    .locator('xpath=..')
    .getByRole('button', { name: '对话' })
    .click();
  await page.getByRole('button', { name: '新会话' }).click();
  const a = await send('用一句话介绍你自己');
  const b = await send('把上一句翻译成英文');
  if (!/[A-Za-z]{4,}/.test(b)) throw new Error('第二轮没有英文：' + b);
  return a.slice(0, 60);
});

await step('对话：工具调用（图谱检索）并展示工具分段', async () => {
  await send('查一下图谱里有哪些实体，列出名称');
  await page
    .locator('[data-part-id]')
    .filter({ hasText: /graph_/ })
    .first()
    .waitFor();
});

await step('对话：知识库检索', async () => {
  const r = await send('请用 knowledge_search 在知识库里查“工作台”，告诉我查到了什么');
  await page
    .locator('[data-part-id]')
    .filter({ hasText: /knowledge_search/ })
    .first()
    .waitFor();
  return r.slice(0, 80);
});

await step('对话：文本附件', async () => {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加附件' }).click();
  await (
    await chooser
  ).setFiles({
    name: '周报.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('本周新增客户 17 家，流失 3 家。'),
  });
  const r = await send('附件里新增客户是多少家？只回答数字');
  if (!/17/.test(r)) throw new Error('没读到附件内容：' + r);
});

await step('对话：运行中插话', async () => {
  const before = await page.locator('[data-message-id]').count();
  await page.getByLabel('消息').fill('写一段 300 字左右的介绍，主题是知识图谱');
  await page.getByRole('button', { name: '发送' }).click();
  await page.getByRole('status').filter({ hasText: '运行中' }).waitFor({ timeout: 15000 });
  await page.getByLabel('消息').fill('结尾加一句“以上”');
  await page.getByRole('button', { name: '发送' }).click();
  await settled(before + 1);
  return await lastAssistant();
});

await step('对话：分叉后在分支里继续', async () => {
  await page.locator('[data-message-id]').last().hover();
  await page.getByRole('button', { name: '从这里开分支' }).last().click();
  await page.getByRole('heading', { name: /· 分支$/ }).waitFor();
  await send('在这个分支里，用一句话说你刚才在聊什么');
  const tree = page.getByRole('tree', { name: '会话' });
  await tree.getByRole('treeitem', { selected: true }).waitFor();
});

await step('对话：停止运行', async () => {
  await page.getByLabel('消息').fill('从 1 数到 200，每个数字一行');
  await page.getByRole('button', { name: '发送' }).click();
  await page.getByRole('button', { name: '停止运行' }).click({ timeout: 15000 });
  await page.getByRole('status').filter({ hasNotText: '运行中' }).first().waitFor({ timeout: 30000 });
  return await page.getByRole('status').first().innerText();
});
await shot('chat');

await step('分支：从较早的回复开分支（菜单里按回复选择）', async () => {
  await page.getByRole('button', { name: '新会话' }).click();
  await page.getByRole('heading', { name: '未命名会话' }).waitFor();
  await send(`第一问 ${stamp}：1+1 等于几？只答数字`);
  await send('第二问：2+2 等于几？只答数字');
  if ((await page.getByRole('button', { name: '从这里开分支' }).count()) < 2)
    throw new Error('不是每条回复都能开分支');
  await page.getByRole('button', { name: '会话操作' }).click();
  await page.getByRole('menuitem', { name: '开分支…' }).click();
  const list = page.getByRole('list', { name: '分叉位置' });
  await list.getByText(`问：第一问 ${stamp}：1+1 等于几？只答数字`).click();
  await page.getByRole('heading', { name: /· 分支$/ }).waitFor();
  const texts = await page.locator('[data-message-id]').allInnerTexts();
  if (texts.some((t) => t.includes('第二问'))) throw new Error('分支里不应包含第二问');
  const r = await send('刚才我问的数学题是什么？只复述题目');
  if (!/1\s*\+\s*1/.test(r)) throw new Error('分支丢了上下文：' + r);
  return r.slice(0, 60);
});

await step('归档：列表一键归档（含分支），归档页按 Agent 树形查看、恢复、删除', async () => {
  const title = `第一问 ${stamp}：1+1 等于几？只答数字`;
  const tree = page.getByRole('tree', { name: '会话' });
  const row = tree.getByRole('treeitem').filter({ hasText: title }).first();
  await row.hover();
  await page
    .getByRole('button', { name: `归档 ${title}`, exact: true })
    .first()
    .click();
  await tree.getByRole('treeitem').filter({ hasText: title }).first().waitFor({ state: 'detached' });
  await nav('归档');
  const archive = page.locator('[role=tree][aria-label=已归档会话]');
  const parent = archive.getByRole('treeitem').filter({ hasText: title }).first();
  await parent.waitFor();
  if (!(await parent.innerText()).includes('分支')) throw new Error('归档页没有保留分支关系');
  await shot('archive');
  await page
    .getByRole('button', { name: `恢复 ${title}`, exact: true })
    .first()
    .click();
  await parent.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '去对话' }).click();
  await page
    .getByRole('tree', { name: '会话' })
    .getByRole('treeitem')
    .filter({ hasText: title })
    .first()
    .waitFor();
  const again = page
    .getByRole('tree', { name: '会话' })
    .getByRole('treeitem')
    .filter({ hasText: title })
    .first();
  await again.hover();
  await page
    .getByRole('button', { name: `归档 ${title}`, exact: true })
    .first()
    .click();
  await nav('归档');
  await page
    .getByRole('button', { name: `删除 ${title}`, exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: '永久删除' }).click();
  await page
    .getByRole('tree', { name: '已归档会话' })
    .getByRole('treeitem')
    .filter({ hasText: new RegExp(`^${title}\\n`) })
    .waitFor({ state: 'detached' })
    .catch(() => {});
});

await step('推演：真实模型群聊 + 采访 + 报告', async () => {
  await nav('推演');
  await page.getByRole('button', { name: '新建推演' }).click();
  await page.getByLabel('任务名称').fill(`验收推演-${stamp}`);
  await page.getByLabel('模式').selectOption('group_chat');
  await page.getByLabel('目标').fill('讨论小团队是否应该引入知识图谱，给出结论');
  await page.getByRole('checkbox', { name: '通用助手' }).click();
  await page.getByRole('checkbox', { name: agentName }).click();
  await page.getByLabel('最大轮次').fill('1');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: `验收推演-${stamp}`, exact: true }).click();
  await page.getByRole('button', { name: '启动' }).click();
  await page
    .getByRole('status')
    .filter({ hasText: /已完成|失败|已取消/ })
    .waitFor({ timeout: LONG });
  const st = await page.getByRole('status').first().innerText();
  if (!/已完成/.test(st)) throw new Error('推演状态：' + st);
  await page.getByLabel('问题').fill('一句话：你的最终立场？');
  await page.getByRole('button', { name: '提交采访' }).click();
  await page.getByText('问：一句话：你的最终立场？').waitFor({ timeout: LONG });
  await shot('simulation-process');
  await page.getByRole('button', { name: '生成报告' }).click();
  await page.getByRole('heading', { name: `验收推演-${stamp}`, level: 1 }).waitFor();
  await shot('simulation');
});

await step('评估：真实模型裁判', async () => {
  await nav('评估');
  await page.getByRole('button', { name: '新建评估' }).click();
  await dlg().getByLabel('名称').fill(`验收评估-${stamp}`);
  await dlg()
    .getByLabel('Agent')
    .selectOption({ label: `🤖 ${agentName}` });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: `验收评估-${stamp} —`, exact: true }).click();
  await page.getByRole('button', { name: '添加用例' }).click();
  await dlg().getByLabel('输入').fill('1+1 等于几？');
  await dlg().getByLabel('期望输出').fill('2');
  await page.getByRole('button', { name: '保存并继续' }).click();
  await page.getByRole('button', { name: '完成' }).click();
  await page.getByRole('button', { name: '运行评估' }).click();
  await page.getByText(/平均 \d/).waitFor({ timeout: LONG });
  return await page.getByText(/平均 \d/).innerText();
});
await page.keyboard.press('Escape');

await step('嵌入抽屉 390px：真实对话', async () => {
  await page.goto(base + '/embed.html');
  await page.getByLabel('抽屉宽度').selectOption('390');
  await page.getByRole('button', { name: 'AI 分析' }).click();
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  await page.getByRole('button', { name: '新会话' }).click();
  await send('你好，一句话');
  await shot('drawer-390');
  await page.getByRole('button', { name: '关闭抽屉' }).click();
});

await browser.close();
console.log('\n' + results.map((r) => r.join('  ')).join('\n'));
console.log(errors.length ? 'pageerror:\n' + errors.join('\n') : 'no page errors');
process.exit(results.some((r) => r[0] === '✗') || errors.length ? 1 : 0);
