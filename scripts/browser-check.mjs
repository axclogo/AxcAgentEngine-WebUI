// End-to-end check on the real engine (fixture model): every studio section, chat with attachment, fork tree,
// simulation/interview/report, evaluation, embedded drawer at 390px. Screenshots go to docs/evidence/.
// 真实引擎（夹具模型）端到端：各分区、附件对话、分支树、推演/采访/报告、评估、390px 抽屉。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const temp = mkdtempSync(join(tmpdir(), 'axc-browser-'));
const out = process.env.AXC_SHOTS ?? 'docs/evidence';
mkdirSync(out, { recursive: true });
const processes = [];
let browser;
let page;
let logs = '';
function start(cmd, args, env = {}) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => (logs += d));
  p.stderr.on('data', (d) => (logs += d));
  processes.push(p);
}
async function ready(url) {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务未就绪 ' + url + '\n' + logs);
}
try {
  for (const port of [5173, 8765]) {
    const busy = await fetch(`http://127.0.0.1:${port}`).then(
      () => true,
      () => false,
    );
    if (busy) throw new Error(`端口 ${port} 已占用`);
  }
  start(
    process.env.AXC_PYTHON || 'python3',
    ['-m', 'uvicorn', 'server.app:app', '--host', '127.0.0.1', '--port', '8765'],
    {
      AXC_MODEL_MODE: 'fixture',
      AXC_DATA: join(temp, 'data'),
      AXC_SECRET_KEY: '',
    },
  );
  start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--strictPort']);
  await ready('http://127.0.0.1:8765/api/agents');
  await ready('http://127.0.0.1:5173');
  browser = await chromium.launch({ headless: true, executablePath: process.env.AXC_BROWSER_PATH });
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const pending = new Set();
  page.on('request', (r) => r.url().includes('/api/') && pending.add(r.url()));
  page.on('requestfinished', (r) => pending.delete(r.url()));
  page.on('requestfailed', (r) => pending.delete(r.url()));
  const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
  const nav = (label) =>
    page
      .getByRole('navigation', { name: '工坊导航' })
      .getByRole('button', { name: label, exact: true })
      .click();
  await page.addInitScript(() => {
    const ES = window.EventSource;
    window.__open = new Set();
    window.EventSource = class extends ES {
      constructor(...a) {
        super(...a);
        window.__open.add(this);
        const close = this.close.bind(this);
        this.close = () => (window.__open.delete(this), close());
      }
    };
  });
  const dlg = () => page.getByRole('dialog').last();
  await page.goto('http://127.0.0.1:5173');

  // ---- 模型：添加提供商，密钥只回显掩码 ----
  await nav('模型');
  await page.getByRole('button', { name: '添加提供商' }).click();
  await dlg().getByLabel('名称').fill('本地中转');
  await dlg().getByLabel('API 地址').fill('https://llm.example.com/v1');
  await dlg()
    .getByLabel(/API Key/)
    .fill('sk-test-1234567890abcd');
  await page.getByRole('button', { name: '添加模型' }).click();
  await dlg().getByLabel('模型 1 ID').fill('chat-pro');
  await page.getByRole('button', { name: '添加模型' }).click();
  await dlg().getByLabel('模型 2 ID').fill('vision-pro');
  await dlg().getByLabel('模型 2 支持视觉').click();
  await shot('provider-editor');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('sk-••••abcd').waitFor();
  assert.equal(await page.getByText('sk-test-1234567890abcd').count(), 0, '明文密钥不得出现在页面');
  await shot('providers');

  // ---- Agent：新建，级联选择模型，绑定资源，开启插件 ----
  await nav('Agent');
  await page.getByRole('button', { name: '新建 Agent' }).click();
  await dlg().getByLabel('名称').fill('情报分析助手');
  await dlg().getByLabel('描述').fill('基于知识库与图谱回答问题');
  await dlg().getByLabel('系统提示词').fill('你是情报分析助手，回答时引用来源。');
  await page.getByRole('tab', { name: '模型' }).click();
  await page.getByRole('combobox', { name: '主模型' }).click();
  await page.getByRole('option', { name: /chat-pro/ }).click();
  await page.getByRole('combobox', { name: '视觉模型' }).click();
  assert.equal(await page.getByRole('option', { name: /chat-pro/ }).count(), 0, '视觉槽位只列视觉模型');
  await page.getByRole('option', { name: /vision-pro/ }).click();
  await shot('agent-models');
  await page.getByRole('tab', { name: '知识与技能' }).click();
  await page.getByRole('combobox', { name: '知识库' }).click();
  await page.getByRole('option').first().click();
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: '图谱' }).click();
  await page.getByRole('option').last().click();
  await page.getByRole('tab', { name: '插件' }).click();
  await page
    .getByRole('switch', { name: /启用插件 .*反思|启用插件 reflexion/ })
    .first()
    .click();
  await shot('agent-plugins');
  await page.getByRole('button', { name: '校验并预览 YAML' }).click();
  await page.getByRole('heading', { name: '校验通过' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '情报分析助手 操作' }).waitFor();
  await shot('agents');

  // ---- 评估：建任务、加用例、运行 ----
  await nav('评估');
  await page.getByRole('button', { name: '新建评估' }).click();
  await dlg().getByLabel('名称').fill('冒烟评估');
  await dlg().getByLabel('Agent').selectOption({ label: '🤖 通用助手' });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '冒烟评估 —', exact: true }).click();
  await page.getByRole('button', { name: '添加用例' }).click();
  await dlg().getByLabel('输入').fill('你好');
  await page.getByRole('button', { name: '保存并继续' }).click();
  await page.getByRole('button', { name: '完成' }).click();
  await page.getByRole('button', { name: '运行评估' }).click();
  await page.getByText(/平均 \d/).waitFor({ timeout: 40000 });
  await shot('evals');
  await page.keyboard.press('Escape');

  // ---- Skills / 知识库 / 图谱 / 工具目录 ----
  await nav('Skills');
  await page.getByRole('button', { name: '新建技能' }).click();
  await dlg().getByLabel('名称').fill('weekly-report');
  await dlg().getByLabel('描述', { exact: true }).fill('整理周报');
  await dlg().getByLabel('指令').fill('# 周报\n1. 汇总本周进展\n2. 列出风险');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('weekly-report').waitFor();
  await shot('skills');
  await nav('知识库');
  await page.getByRole('button', { name: '文档' }).first().click();
  await page.getByLabel('上传文档').setInputFiles({
    name: '说明.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 说明\n网关切换阈值为 90 秒。'),
  });
  await page.getByText('说明.md').waitFor();
  await shot('knowledge');
  await page.keyboard.press('Escape');
  await nav('图谱');
  await page.getByRole('button', { name: '查看' }).first().click();
  await page.getByRole('button', { name: '添加实体' }).click();
  await dlg().getByLabel('名称').fill('网关');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('heading', { name: '网关' }).waitFor();
  await shot('graph');
  await nav('工具目录');
  await page.getByText('plugins.graph').waitFor();
  await shot('tools');

  // ---- 对话：新会话、附件、发送、分叉树 ----
  await nav('对话');
  await page.getByRole('combobox', { name: 'Agent' }).click();
  await page.getByRole('option', { name: /情报分析助手/ }).click();
  await page.getByRole('button', { name: '新会话' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加附件' }).click();
  await (
    await chooser
  ).setFiles({ name: '数据.txt', mimeType: 'text/plain', buffer: Buffer.from('本周流量上升 38%') });
  await page.getByText('数据.txt').waitFor();
  await page.getByLabel('消息').fill('结合附件总结一下');
  await page.getByRole('button', { name: '发送' }).click();
  await page.getByRole('status').filter({ hasText: '已完成' }).waitFor();
  await page.locator('[data-message-id] a', { hasText: '数据.txt' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '回到底部' }).count(), 0, '在底部时不显示回到底部');
  await page.locator('[data-message-id]').last().hover();
  await page.getByRole('button', { name: '从这里开分支' }).last().click();
  await page.getByRole('heading', { name: /· 分支$/ }).waitFor();
  await page.getByLabel('消息').fill('在分支里换个角度');
  await page.getByRole('button', { name: '发送' }).click();
  await page.getByRole('status').filter({ hasText: '已完成' }).waitFor();
  await page.locator('[data-message-id]').last().hover();
  await page.getByRole('button', { name: '从这里开分支' }).last().click();
  await page.getByRole('heading', { name: /· 分支 · 分支$/ }).waitFor();
  const tree = page.getByRole('tree', { name: '会话' });
  await tree.getByRole('treeitem', { selected: true }).filter({ hasText: '分支 · 分支' }).waitFor();
  assert.equal(await tree.getByRole('treeitem').count(), 3, '三层分支嵌套在同一棵树里');
  await shot('chat-fork-tree');
  await page.getByRole('button', { name: '会话操作' }).click();
  await page.getByRole('menuitem', { name: '归档会话' }).waitFor();
  assert.equal(await page.getByRole('menuitem', { name: '删除会话' }).count(), 0, '未归档会话不提供删除');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '深色' }).click();
  await page.waitForTimeout(300);
  await shot('chat-dark');
  await page.getByRole('button', { name: '浅色' }).click();

  // ---- 推演：新建、启动、采访、报告 ----
  await nav('推演');
  await page.getByRole('button', { name: '新建推演' }).click();
  await page.getByLabel('任务名称').fill('网关可靠性群聊');
  await page.getByLabel('模式').selectOption('group_chat');
  await page.getByLabel('目标').fill('找出优先修复项');
  await page.getByRole('checkbox', { name: '通用助手' }).click();
  await page.getByRole('checkbox', { name: '情报分析助手' }).click();
  await page.getByLabel('最大轮次').fill('2');
  await shot('simulation-new');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '网关可靠性群聊', exact: true }).click();
  await page.getByRole('button', { name: '启动' }).click();
  await page.getByRole('status').filter({ hasText: '已完成' }).waitFor();
  await shot('simulation-run');
  await page.getByLabel('问题').fill('最该先修哪一项？');
  await page.getByRole('button', { name: '提交采访' }).click();
  await page.getByText('问：最该先修哪一项？').waitFor();
  await page.getByRole('button', { name: '生成报告' }).click();
  await page.getByRole('heading', { name: '网关可靠性群聊', level: 1 }).waitFor();
  await shot('simulation-report');

  // ---- 宿主页面里的窄抽屉 ----
  await page.goto('http://127.0.0.1:5173/embed.html');
  for (const width of ['720', '390']) {
    await page.getByLabel('抽屉宽度').selectOption(width);
    await page.getByRole('button', { name: 'AI 分析' }).click();
    {
      await page.getByRole('button', { name: '会话列表', exact: true }).click();
      await page.getByRole('navigation', { name: '会话列表' }).waitFor();
    }
    await page.getByRole('button', { name: '新会话' }).click();
    await page.getByLabel('消息').fill(`专题运行 ${width}`);
    await page.getByRole('button', { name: '发送' }).click();
    await page.getByRole('status').filter({ hasText: '已完成' }).waitFor();
    const overflow = await page.evaluate(() => {
      const d = document.querySelector('[role=dialog]').getBoundingClientRect();
      return [...document.querySelectorAll('[role=dialog] header *, [role=dialog] form button')]
        .map((e) => e.getBoundingClientRect())
        .some((r) => r.width > 0 && (r.right > d.right + 0.5 || r.left < d.left - 0.5));
    });
    assert.equal(overflow, false, `${width}px 抽屉内控件不应越界`);
    await shot(`drawer-${width}`);
    await page.getByRole('button', { name: '关闭抽屉' }).click();
  }
  await page.getByRole('button', { name: 'AI 分析' }).click();
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  await page.getByRole('tree', { name: '会话' }).getByText('专题运行 720', { exact: true }).click();
  await page.getByRole('heading', { name: /专题运行 720/ }).waitFor();
  await page.getByRole('button', { name: '关闭抽屉' }).click();

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    'Browser: providers(masked key)/agents(cascade, plugins, validate)/skills/knowledge upload/graph/tools, chat attachment + nested forks, dark theme, simulation interview/report, eval run, 720/390 drawer passed',
  );
} catch (error) {
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  console.error(
    'SIDEBAR',
    JSON.stringify(
      await page
        ?.locator('#axc-conversation-list')
        .evaluateAll((es) =>
          es.map((e) => {
            const c = getComputedStyle(e);
            return [
              c.position,
              c.left,
              c.translate,
              c.display,
              e.getBoundingClientRect().x,
              e.offsetParent?.className?.slice(0, 80),
              e.offsetParent?.getBoundingClientRect().x,
            ];
          }),
        )
        .catch((x) => x.message),
    ),
  );
  writeFileSync(join(temp, 'logs.txt'), logs);
  console.error(logs.slice(-5000));
  throw error;
} finally {
  if (browser) await browser.close();
  for (const p of processes) p.kill('SIGTERM');
  await Promise.all(
    processes.map((p) => new Promise((r) => (p.exitCode !== null ? r() : p.once('exit', r)))),
  );
  rmSync(temp, { recursive: true, force: true });
}
