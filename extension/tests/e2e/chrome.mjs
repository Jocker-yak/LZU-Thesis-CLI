/**
 * Chrome E2E：在真实 Chromium 里加载 dist/chrome，配合本地 mock 门户/阅读器跑完整流程。
 *
 * 这个脚本设计成「容器内运行」（mcr.microsoft.com/playwright 或任何带 Chromium+Xvfb 的 Linux）：
 *   xvfb-run -a node tests/e2e/chrome.mjs --extension=dist/chrome --out=tests/e2e/out
 *
 * 流程：
 *   1. mock：门户 127.0.0.2:80、阅读器 127.0.0.3:80（Chromium 用 --host-resolver-rules 把
 *      202.201.7.17 / 202.201.7.29 指到这两个回环地址）；
 *   2. 加载扩展，从 service worker URL 拿扩展 ID；
 *   3. 场景 A：打开阅读器页面（带注册令牌的 302 链）→ 点浮层「获取全文」→ 等到下载完成 → 校验 PDF；
 *   4. 场景 B：打开 popup → 检索 → 等后台补全全文链接 → 点「下载全文」→ 等下载 → 校验 PDF；
 *   5. 结果写 out/report.json。
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import {
  mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { startMockWorld, MOCK_FID } from '../mock/servers.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const extensionDir = path.resolve(opt('extension', 'dist/chrome'));
const outDir = path.resolve(opt('out', 'tests/e2e/out'));
const PORTAL_IP = '127.0.0.2';
const READER_IP = '127.0.0.3';
const JOURNAL = [];
const report = { startedAt: new Date().toISOString(), extensionDir, checks: [] };

function record(name, ok, detail, ms) {
  const entry = { name, ok, detail, ms };
  report.checks.push(entry);
  JOURNAL.push(`${ok ? '✓' : '✗'} ${name}${ms !== undefined ? ` (${ms}ms)` : ''}${detail ? ` — ${detail}` : ''}`);
  console.log(JOURNAL[JOURNAL.length - 1]);
  if (!ok) throw new Error(`${name} 失败：${detail}`);
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '', Date.now() - t0);
    return detail;
  } catch (err) {
    record(name, false, err && err.message ? err.message : String(err), Date.now() - t0);
    throw err;
  }
}

/** 等 service worker 出现并从 URL 里取扩展 ID。 */
async function waitServiceWorker(context, timeout = 30000) {
  const existing = context.serviceWorkers();
  if (existing.length) return existing[0];
  return context.waitForEvent('serviceworker', { timeout });
}

/** 轮询 chrome.downloads.search 直到有 count 个 complete 的下载。 */
async function waitDownloads(sw, count, { timeout = 90000 } = {}) {
  const deadline = Date.now() + timeout;
  let items = [];
  while (Date.now() < deadline) {
    try {
      items = await sw.evaluate(() => new Promise((resolve) => chrome.downloads.search({}, resolve)));
    } catch (err) {
      // SW 可能在下载过程中被暂停，重试即可
      items = [];
    }
    const interrupted = items.filter((i) => i.state === 'interrupted');
    if (interrupted.length) {
      throw new Error(`下载被浏览器中断：${interrupted.map((i) => i.error || i.filename).join(', ')}`);
    }
    // 注意：Playwright 会拦截浏览器下载，落盘文件名是 GUID（没有 .pdf 后缀），
    // 所以这里不能按扩展名过滤，PDF 真假交给 pdfjs 校验。
    const complete = items.filter((i) => i.state === 'complete' && i.filename);
    if (complete.length >= count) return complete;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`等下载超时（期望 ${count} 个文件，实际 ${items.length} 条：${items.map((i) => `${i.state}:${i.filename}`).join(' | ')}）`);
}

/** 用 pdfjs-dist（独立解析器）校验 PDF 页数与页面尺寸。 */
async function inspectPdf(file, expectedPages = 3) {
  const bytes = await readFile(file);
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`不是 PDF（文件 ${file}，前 8 字节 ${bytes.subarray(0, 8).toString('hex')}）`);
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;
  const pages = doc.numPages;
  const view = (await doc.getPage(1)).getViewport({ scale: 1 });
  await doc.destroy();
  if (pages !== expectedPages) {
    throw new Error(`PDF 页数 ${pages}，期望 ${expectedPages}（文件 ${file}）`);
  }
  if (Math.abs(view.width - 491.52) > 0.5 || Math.abs(view.height - 360) > 0.5) {
    throw new Error(`页面尺寸 ${view.width.toFixed(2)}×${view.height.toFixed(2)}pt，期望 491.52×360`);
  }
  return { file: path.basename(file), bytes: bytes.length, pages, pageWidthPt: view.width, pageHeightPt: view.height };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  if (!existsSync(path.join(extensionDir, 'manifest.json'))) {
    throw new Error(`扩展目录没有 manifest.json：${extensionDir}（先 npm run build）`);
  }
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'lzu-e2e-profile-'));
  const downloadsPath = await mkdtemp(path.join(os.tmpdir(), 'lzu-e2e-downloads-'));

  const world = await startMockWorld({
    portalHost: PORTAL_IP,
    readerHost: READER_IP,
    portalPort: 80,
    readerPort: 80,
    pages: 3,
  });

  let context = null;
  try {
    const commonArgs = [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // 容器里可能带着宿主 docker 的 http(s)_proxy 环境变量，会把 202.201.7.x 的请求
      // 送去一个不存在的代理；E2E 全部走本地 mock，必须直连。
      '--no-proxy-server',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      `--host-resolver-rules=MAP 202.201.7.17 ${PORTAL_IP}, MAP 202.201.7.29 ${READER_IP}`,
    ];

    const launch = (headless) => chromium.launchPersistentContext(userDataDir, {
      headless,
      acceptDownloads: true,
      downloadsPath,
      args: commonArgs,
      viewport: { width: 1280, height: 900 },
      timeout: 60000,
    });

    await step('启动 Chromium 并加载扩展', async () => {
      try {
        context = await launch(false); // 有扩展要求有头模式；容器里用 xvfb-run 提供显示
        return '有头模式（xvfb）';
      } catch (err) {
        context = await launch(true); // 兜底：新版 headless 也支持 MV3 扩展
        return `headless 兜底（${err.message.split('\n')[0]}）`;
      }
    });

    const sw = await waitServiceWorker(context, 30000);
    const extId = new URL(sw.url()).host;
    report.extensionId = extId;
    record('拿到 MV3 service worker', true, `${extId}`);

    await step('manifest 与实际运行一致', async () => {
      // 期望值从构建产物 dist/<target>/manifest.json 读，避免发版改版本号后这里写成硬编码。
      const expected = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
      const info = await sw.evaluate(() => {
        const m = chrome.runtime.getManifest();
        return { name: m.name, version: m.version, mv: m.manifest_version, permissions: m.permissions };
      });
      if (info.mv !== 3) throw new Error(`manifest_version=${info.mv}`);
      if (info.version !== expected.version) throw new Error(`version=${info.version}（期望 ${expected.version}）`);
      if (info.name !== expected.name) throw new Error(`name=${info.name}`);
      return `${info.name} v${info.version}（MV${info.mv}，权限 ${info.permissions.join(',')}）`;
    });

    // ------------------------------------------------ 场景 A：阅读器页面浮层
    const readerPage = await context.newPage();
    await step('打开阅读器页面（302 注册链）并出现浮层', async () => {
      await readerPage.goto(`http://202.201.7.29/personaliiifServlet?path=${world.state.token}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      const host = readerPage.locator('#lzu-thesis-helper-host');
      await host.waitFor({ state: 'attached', timeout: 25000 });
      // 浮层是 shadow DOM，innerText 取不到里面的文案，必须用能穿透 shadow root 的 locator
      const label = await host.getByRole('button', { name: '获取全文' }).first();
      await label.waitFor({ timeout: 20000 });
      return `落地页 ${readerPage.url().replace(/path=.*/, 'path=…')}；浮层按钮「${await label.innerText()}」已出现`;
    });

    await step('阅读页浮层「获取全文」→ 浏览器下载 PDF', async () => {
      const button = readerPage.locator('#lzu-thesis-helper-host').getByRole('button', { name: '获取全文' });
      await button.click({ timeout: 15000 });
      const complete = await waitDownloads(sw, 1, { timeout: 120000 });
      const item = complete[0];
      return `下载完成 ${item.filename}（${item.fileSize || item.bytesReceived || '?'} B）`;
    });

    await step('校验阅读页下载的 PDF（pdfjs 独立解析）', async () => {
      const items = await waitDownloads(sw, 1, { timeout: 30000 });
      report.readerPdf = await inspectPdf(items[0].filename, 3);
      return `pdfjs 解析通过：${report.readerPdf.pages} 页 ${report.readerPdf.pageWidthPt}×${report.readerPdf.pageHeightPt}pt`;
    });

    // ------------------------------------------------ 场景 B：popup 检索下载
    const popup = await context.newPage();
    await step('打开 popup 并执行检索', async () => {
      await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const input = popup.locator('input').first();
      await input.waitFor({ timeout: 15000 });
      await input.fill('侯扶江');
      // 顶部页签也叫「检索」，这里要点 main 里的提交按钮
      await popup.locator('main').getByRole('button', { name: '检索', exact: true }).click();
      await popup.locator('.row').first().waitFor({ timeout: 45000 });
      const count = await popup.locator('.row').count();
      return `结果行 ${count} 条`;
    });

    await step('后台补全「有全文入口」并点「下载全文」', async () => {
      const row = popup.locator('.row').filter({ hasText: '有全文入口' }).first();
      await row.waitFor({ timeout: 45000 });
      const download = row.getByRole('button', { name: '下载全文' });
      await download.waitFor({ timeout: 15000 });
      await download.click({ timeout: 15000 });
      const complete = await waitDownloads(sw, 2, { timeout: 120000 });
      return `累计 ${complete.length} 个 PDF 下载完成`;
    });

    await step('校验 popup 下载的 PDF（pdfjs 独立解析）', async () => {
      const items = await waitDownloads(sw, 2, { timeout: 30000 });
      const latest = items[items.length - 1];
      report.popupPdf = await inspectPdf(latest.filename, 3);
      return `pdfjs 解析通过：${report.popupPdf.pages} 页 ${report.popupPdf.pageWidthPt}×${report.popupPdf.pageHeightPt}pt`;
    });

    await step('阅读器故障文案：后台 probe 能识别门户可达', async () => {
      const probe = await popup.evaluate(() => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'probe' }, resolve);
      })).catch(() => null);
      if (!probe || probe.ok !== true) throw new Error(`probe 返回 ${JSON.stringify(probe)}`);
      if (!probe.portal || probe.portal.ok !== true) throw new Error(`门户探测失败：${JSON.stringify(probe.portal)}`);
      return `门户 ${probe.portal.status || 'ok'} / 阅读器 ${JSON.stringify(probe.reader)}`;
    });

    report.ok = true;
  } finally {
    if (context) await context.close().catch(() => {});
    await world.close();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    report.finishedAt = new Date().toISOString();
    report.journal = JOURNAL;
    await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
}

main().then(() => {
  console.log('\nE2E 全部通过。');
  process.exit(0);
}).catch((err) => {
  console.error(`\nE2E 失败：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
