/**
 * Firefox 端到端测试（在装有 Firefox 的机器/容器里跑）。
 *
 * Playwright 不支持给 Firefox 装扩展，所以这里直接用 Firefox 自带的
 * Marionette 协议：临时安装未签名 XPI → 打开扩展页 → 真实点击/发消息 → 校验下载。
 *
 * 运行前提（由 scripts/e2e-firefox.mjs 在容器里准备）：
 *   - 当前目录 = extension/，dist/firefox 已构建，XPI 已打好（LZU_FIREFOX_XPI 指定路径）
 *   - mock 门户/阅读器能用 127.0.0.1:80 提供，且 202.201.7.17 / .29 已能解析到本机
 *     （用 Firefox 的 network.dns.localDomains，由本脚本写进临时 profile）
 *
 * 环境变量：
 *   LZU_FIREFOX_BIN  Firefox 可执行文件路径（默认自动探测 /ms-playwright/firefox-*）
 *   LZU_FIREFOX_XPI  XPI 路径（默认 tests/e2e/out/lzu-fulltext-firefox.xpi）
 *   LZU_E2E_OUT      报告/下载产物目录（默认 tests/e2e/out/firefox）
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { startMockWorld } from '../mock/servers.mjs';
import { Marionette } from './lib/marionette.mjs';

const execFileAsync = promisify(execFile);
const extRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = process.env.LZU_E2E_OUT || path.join(import.meta.dirname, 'out', 'firefox');
const XPI = process.env.LZU_FIREFOX_XPI || path.join(import.meta.dirname, 'out', 'lzu-fulltext-firefox.xpi');

const GEO_ID = 'lzu-fulltext@oceaniaslazycat.heiyu.space';
const PAGE_COUNT = 3;
const TOKEN_PREFIX = 'KsAbQ';

let passed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`);
  } else {
    console.log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`);
    throw new Error(`检查失败：${name}`);
  }
}

async function findFirefox() {
  if (process.env.LZU_FIREFOX_BIN) return process.env.LZU_FIREFOX_BIN;
  const base = '/ms-playwright';
  if (existsSync(base)) {
    const dirs = (await readdir(base)).filter((d) => d.startsWith('firefox-')).sort();
    for (const d of dirs.reverse()) {
      const bin = path.join(base, d, 'firefox', 'firefox');
      if (existsSync(bin)) return bin;
    }
  }
  for (const bin of ['/usr/bin/firefox', '/usr/bin/firefox-esr']) if (existsSync(bin)) return bin;
  throw new Error('找不到 Firefox（设 LZU_FIREFOX_BIN）');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 轮询执行一段脚本，直到返回值满足条件。
 * 不用一次 ExecuteScript 等 promise：MV3 后台首次唤醒/网络超时可能超过默认 30s 命令超时。
 */
async function waitForScript(mc, script, predicate, { timeoutMs = 120000, intervalMs = 500, label = '条件' } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    last = await js(mc, script);
    if (predicate(last)) return last;
    if (Date.now() - start > timeoutMs) throw new Error(`等待${label}超时（最后结果：${JSON.stringify(last).slice(0, 300)}）`);
    await sleep(intervalMs);
  }
}

/** Marionette 的脚本结果是 WebDriver 的 {value} 包一层，这里统一拆掉。 */
async function js(mc, script) {
  const result = await mc.executeScript(script);
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'value')) {
    return result.value;
  }
  return result;
}

async function makeProfile(profileDir, downloadDir) {
  const prefs = [
    // 把两个校内域名指到本机：Firefox 只改解析结果，不改端口，所以 mock 用 80 端口。
    'user_pref("network.dns.localDomains", "202.201.7.17,202.201.7.29");',
    // 容器里常继承 http(s)_proxy，这里强制直连。
    'user_pref("network.proxy.type", 0);',
    'user_pref("marionette.port", 2828);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.page", 0);',
    'user_pref("browser.startup.homepage", "about:blank");',
    'user_pref("browser.tabs.warnOnClose", false);',
    'user_pref("browser.sessionstore.resume_from_crash", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("browser.uitour.enabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("app.update.auto", false);',
    'user_pref("app.update.enabled", false);',
    // 未签名扩展：临时安装 + 允许旧机制（Nightly 通道生效）
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("extensions.autoDisableScopes", 0);',
    // 下载不弹框、直接落盘
    'user_pref("browser.download.folderList", 2);',
    `user_pref("browser.download.dir", ${JSON.stringify(downloadDir)});`,
    'user_pref("browser.download.useDownloadDir", true);',
    'user_pref("browser.download.always_ask_before_handling_new_types", false);',
    'user_pref("browser.helperApps.neverAsk.saveToDisk", "application/pdf;application/octet-stream");',
    'user_pref("pdfjs.disabled", true);',
    // 让扩展的 console.log 也进 stdout，排错用
    'user_pref("devtools.console.stdout.content", true);',
    'user_pref("browser.dom.window.dump.enabled", true);',
  ];
  await writeFile(path.join(profileDir, 'user.js'), `${prefs.join('\n')}\n`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const startedAt = Date.now();
  const report = { ok: false, checks: [], downloads: [], logs: [], startedAt };

  const downloadDir = path.join(outDir, 'downloads');
  await rm(downloadDir, { recursive: true, force: true });
  await mkdir(downloadDir, { recursive: true });
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'lzu-fx-profile-'));

  console.log(`Firefox E2E：profile=${profileDir}`);
  console.log(`            xpi=${XPI}`);
  check('XPI 存在', existsSync(XPI), XPI);

  const mock = await startMockWorld({ singlePort: true, port: 80, host: '127.0.0.1', pages: PAGE_COUNT });
  report.mock = { portalUrl: mock.portalUrl, readerUrl: mock.readerUrl };
  console.log(`  mock 门户 ${mock.portalUrl} / 阅读器 ${mock.readerUrl}（127.0.0.1:80）`);

  await makeProfile(profileDir, downloadDir);
  const bin = await findFirefox();
  console.log(`  firefox ${bin}`);
  const proc = execFile(bin, [
    '-marionette',
    // Firefox 138+ 默认禁止 chrome 上下文（我们靠它读扩展 uuid），要显式开。
    '-remote-allow-system-access',
    '-headless',
    '-no-remote',
    '-profile', profileDir,
    'about:blank',
  ], {
    maxBuffer: 8 * 1024 * 1024,
  });
  let ffLog = '';
  proc.stdout.on('data', (d) => { ffLog += d; });
  proc.stderr.on('data', (d) => { ffLog += d; });

  const mc = new Marionette();
  let session = null;
  try {
    await Marionette.waitForPort({ timeoutMs: 60000 });
    const handshake = await mc.connect();
    check('Marionette 已连接', handshake.applicationType === 'gecko');
    session = await mc.newSession({});
    check('浏览器会话已建立', Boolean(session.sessionId));

    const installed = await mc.installAddon(XPI, true);
    const addonId = installed && (installed.value || installed.addon_id || installed.id);
    check('扩展已临时安装', addonId === GEO_ID, JSON.stringify(installed));
    report.addon = installed;

    // 取 moz-extension:// 的 uuid（Firefox 给每个扩展分配随机 uuid）
    await mc.setContext('chrome');
    let uuid = null;
    for (let i = 0; i < 40 && !uuid; i++) {
      const raw = await js(mc, 'return Services.prefs.getStringPref("extensions.webextensions.uuids", "{}")');
      const map = JSON.parse(raw || '{}');
      if (map[GEO_ID]) uuid = map[GEO_ID];
      else await sleep(150);
    }
    check('拿到扩展 uuid', Boolean(uuid), uuid || '');
    const base = `moz-extension://${uuid}`;
    // ---- 场景 1：门户检索（走 bridge 通道，用户报错就发生在这条路径上）
    await mc.setContext('content');
    await mc.navigate(`${base}/app.html#/help`);
    await sleep(300);
    await js(mc, `
      window.__lzuSearch = null;
      browser.runtime.sendMessage({ type: 'search', keyword: '侯扶江' })
        .then((r) => { window.__lzuSearch = { ok: Boolean(r && r.ok), rows: (r && r.rows || []).length, error: r && r.error }; })
        .catch((e) => { window.__lzuSearch = { error: String(e) }; });
      return 'started';
    `);
    const searchOut = await waitForScript(mc, 'return window.__lzuSearch || null;', (v) => v !== null, {
      label: '门户检索', timeoutMs: 120000,
    });
    const logsOut = await js(mc, 'return browser.runtime.sendMessage({ type: "log:get" });');
    report.search = searchOut;
    report.logs = (logsOut && logsOut.entries || []).slice(-40);
    if (searchOut && searchOut.error) console.log(`  检索失败详情：${searchOut.error}`);
    for (const entry of report.logs) {
      if (entry.level === 'error' || entry.level === 'warn') {
        console.log(`  [${entry.level}] ${entry.message} ${entry.extra ? JSON.stringify(entry.extra) : ''}`);
      }
    }
    check('门户检索返回 20 行', report.search.rows === 20, `rows=${report.search.rows}`);
    const bridgeWarns = report.logs.filter((e) => String(e.message || '').includes('桥接失败'));
    check('桥接通道无失败', bridgeWarns.length === 0, bridgeWarns
      .map((e) => `${e.message} @@ ${JSON.stringify(e.extra || {})}`)
      .join(' | ').slice(0, 500));

    // ---- 场景 2：阅读器页面浮层 → 点「获取全文」→ 下载 PDF
    const token = await readToken();
    await mc.navigate(`http://202.201.7.29/personaliiifServlet?path=${encodeURIComponent(token)}`);
    await sleep(500);
    const clicked = await js(mc, `
      const host = document.getElementById('lzu-thesis-helper-host');
      if (!host || !host.shadowRoot) return 'no-panel';
      const btn = [...host.shadowRoot.querySelectorAll('button')].find((b) => b.textContent.includes('获取全文'));
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    `);
    check('阅读器页面浮层出现并可点击', clicked === 'clicked', String(clicked));

    const pdf = await waitForDownload(downloadDir, 90000);
    check('下载到 PDF', Boolean(pdf), pdf ? path.basename(pdf) : '超时');
    const bytes = await readFile(pdf);
    check('下载内容是 PDF', bytes.subarray(0, 5).toString('latin1') === '%PDF-', `${bytes.length} 字节`);
    const pageHit = bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || [];
    check(`PDF 有 ${PAGE_COUNT} 页`, pageHit.length === PAGE_COUNT, `找到 ${pageHit.length} 页`);
    report.downloads.push({ file: path.basename(pdf), bytes: bytes.length, pages: pageHit.length });

    // 点完按钮后页面还是阅读器页，扩展 API 只在扩展页里可用，切回工作台再查状态。
    await mc.navigate(`${base}/app.html#/workspace`);
    await sleep(300);
    await js(mc, `
      window.__lzuAfter = null;
      Promise.all([
        browser.runtime.sendMessage({ type: 'list-tasks' }),
        browser.runtime.sendMessage({ type: 'log:get' }),
      ]).then(([tasks, logs]) => { window.__lzuAfter = { tasks, logs }; })
        .catch((e) => { window.__lzuAfter = { error: String(e) }; });
      return 'started';
    `);
    const after = await waitForScript(mc, 'return window.__lzuAfter || null;', (v) => v !== null, { label: '任务列表', timeoutMs: 30000 });
    report.tasks = after.tasks;
    report.logs2 = (after.logs && after.logs.entries || []).slice(-40);
    const errs = report.logs2.filter((e) => e.level === 'error');
    check('任务无错误日志', errs.length === 0, errs.map((e) => e.message).join(' | ').slice(0, 300));

    report.ok = true;
    console.log(`\nFirefox E2E 通过：${passed} 项检查，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await writeFile(path.join(outDir, 'firefox.log'), ffLog);
    await mc.quit().catch(() => {});
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    await mock.close().catch(() => {});
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readToken() {
  const fixture = path.join(extRoot, 'tests', 'fixtures', 'portal', 'token.json');
  const parsed = JSON.parse(await readFile(fixture, 'utf8'));
  if (!String(parsed.token || '').startsWith(TOKEN_PREFIX)) {
    throw new Error(`token.json 里的令牌看起来不对：${String(parsed.token).slice(0, 12)}`);
  }
  return parsed.token;
}

async function waitForDownload(dir, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      if (name.endsWith('.part') || name.endsWith('.pdf.part')) continue;
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info && info.size > 1024) {
        const head = await readFile(file, { encoding: null });
        if (head.subarray(0, 5).toString('latin1') === '%PDF-') return file;
      }
    }
    if (Date.now() - start > timeoutMs) return null;
    await sleep(300);
  }
}

const report = await main().catch((err) => {
  console.error(`\nFirefox E2E 失败：${err && err.message}`);
  if (err && err.remoteStack) console.error(err.remoteStack);
  process.exitCode = 1;
  return null;
});
if (report) process.exit(0);
