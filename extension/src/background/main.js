/**
 * 后台总控：消息路由 + 下载任务编排。
 *
 * 核心难点（见 .PLAN-NOTES.md）：令牌注册的 302 跨域读不到 Location，
 * 所以 fid 必须靠**真实标签页导航**落地后从 URL 里读；拿到 fid 后
 * 所有 .29 请求都通过该标签页的 content script 桥接（同源、带会话 cookie）。
 */
import {
  api, broadcast, isFirefox, logEvent, openAppPage, readLog, clearLog, sleep,
} from '../lib/ext.js';
import { AppError, createHttp } from '../lib/http.js';
import {
  READER_ORIGIN, PORTAL_ORIGIN, REGISTER_PATH, INDEX_PATH, SEARCH_URL, GONE_RE,
  extractToken, quoteToken, decodeToken,
} from '../lib/protocol.js';
import { parseMeta, pageCount, titleOf } from '../lib/reader.js';
import { search as portalSearch, absoluteUrl, recordLinks } from '../lib/portal.js';
import { downloadDocument, mapPool } from '../lib/pipeline.js';
import { getSettings, setSettings, getLastKeyword, setLastKeyword } from '../lib/settings.js';
import * as tabs from './tabs.js';
import { createBrowserTransport, probeOrigins, setWorker } from './transport.js';
import { saveBytes } from './downloads.js';

const TASKS = new Map(); // id → {task, ctrl, readerTab}
let taskSeq = 0;

// ---------------------------------------------------------------- 存储小工具

const hasSessionStorage = Boolean(api.storage && api.storage.session);
const taskStore = hasSessionStorage ? api.storage.session : api.storage.local;
const TASK_PREFIX = 'task:';

async function writeTaskRecord(task) {
  try {
    await taskStore.set({ [`${TASK_PREFIX}${task.id}`]: { ...task } });
  } catch (err) {
    logEvent('warn', `写任务状态失败：${err.message}`);
  }
}

async function readTaskRecords() {
  try {
    const all = await taskStore.get(null);
    return Object.entries(all || {})
      .filter(([key]) => key.startsWith(TASK_PREFIX))
      .map(([, value]) => value)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function newTaskId() {
  return `t${Date.now().toString(36)}${(taskSeq++).toString(36)}`;
}

// ---------------------------------------------------------------- 下载历史

const HISTORY_KEY = 'history';
const HISTORY_LIMIT = 50;

async function recordHistory(task) {
  try {
    const got = await api.storage.local.get(HISTORY_KEY);
    const list = Array.isArray(got[HISTORY_KEY]) ? got[HISTORY_KEY] : [];
    list.unshift({
      id: task.id,
      title: task.title || '',
      fid: task.fid || '',
      filename: task.filename || '',
      bytes: task.bytes || 0,
      pageCount: task.total || 0,
      status: task.status,
      error: task.error || null,
      endedAt: Date.now(),
    });
    await api.storage.local.set({ [HISTORY_KEY]: list.slice(0, HISTORY_LIMIT) });
  } catch (err) {
    logEvent('warn', `写下载历史失败：${err.message}`);
  }
}

// ---------------------------------------------------------------- 任务编排

function makeHttp(settings, signal) {
  const { request } = createBrowserTransport(settings);
  return createHttp((spec) => {
    if (signal && signal.aborted) throw new AppError('已取消', 'CANCELLED');
    return request(spec);
  }, { retries: 2, timeoutMs: 60000 });
}

async function updateTask(entry, patch, { silent = false } = {}) {
  Object.assign(entry.task, patch, { updatedAt: Date.now() });
  await writeTaskRecord(entry.task);
  if (silent) return;
  const message = { type: 'task-update', task: { ...entry.task } };
  broadcast(message);
  if (entry.task.sourceTabId) {
    api.tabs.sendMessage(entry.task.sourceTabId, message).catch(() => {});
  }
}

/** 清掉 .29 的会话 cookie：注册失败重试时换一个新会话。 */
async function clearReaderCookies() {
  try {
    const cookies = await api.cookies.getAll({ domain: '202.201.7.29' });
    for (const cookie of cookies || []) {
      const scheme = cookie.secure ? 'https' : 'http';
      const url = `${scheme}://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`;
      await api.cookies.remove({ url, name: cookie.name });
    }
  } catch (err) {
    logEvent('warn', `清阅读器 cookie 失败：${err.message}`);
  }
}

async function tabLooksGone(tabId) {
  try {
    const reply = await tabs.sendToTab(tabId, { type: 'get-text' }, { tries: 3, timeoutMs: 4000 });
    return GONE_RE.test(String((reply && reply.text) || ''));
  } catch {
    return false;
  }
}

/** 用令牌注册：真实导航拿 fid；令牌原始形式、二次编码各试一次，共两轮。 */
async function registerViaTab(token, { signal }) {
  const variants = [token, quoteToken(token)];
  const attempts = [...variants, ...variants];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const url = `${READER_ORIGIN}${REGISTER_PATH}${attempts[i]}`;
    let tabId = null;
    try {
      tabId = await tabs.createHiddenTab(url);
      const { fid } = await tabs.waitForFid(tabId, { timeoutMs: 35000, signal });
      await tabs.waitComplete(tabId, { timeoutMs: 20000, signal }).catch(() => {});
      return { tabId, fid, created: true };
    } catch (err) {
      lastErr = err;
      const gone = tabId ? await tabLooksGone(tabId) : false;
      if (tabId) await tabs.closeTab(tabId);
      if (gone) {
        throw new AppError('这个令牌对应的文件已不存在，或令牌已过期（令牌有效期很短，请重新生成）。', 'GONE');
      }
      if (i >= variants.length - 1) await clearReaderCookies();
      await sleep(400 + 300 * (i % 2));
    }
  }
  throw lastErr instanceof Error ? lastErr : new AppError('注册失败：没拿到 fid', 'REGISTER_FAILED');
}

async function readMetaFromTab(tabId, fid) {
  let meta = null;
  try {
    const reply = await tabs.sendToTab(tabId, { type: 'get-meta' }, { tries: 8, timeoutMs: 15000 });
    meta = reply && reply.meta;
  } catch (err) {
    logEvent('warn', `页面脚本取 meta 失败：${err.message}`);
  }
  if (!meta || !pageCountOk(meta)) {
    try {
      const reply = await tabs.sendToTab(tabId, { type: 'get-html' }, { tries: 4, timeoutMs: 8000 });
      if (reply && reply.html) meta = parseMeta(reply.html);
    } catch {
      /* 页面不是 HTML 或脚本没注入 */
    }
  }
  if (!meta || !pageCountOk(meta)) {
    try {
      const { meta: viaHttp } = await readMetaByHttp(fid);
      if (viaHttp && pageCountOk(viaHttp)) meta = viaHttp;
    } catch {
      /* 兜底也失败就返回原样 */
    }
  }
  return meta || {};
}

function pageCountOk(meta) {
  try {
    pageCount(meta);
    return true;
  } catch {
    return false;
  }
}

async function readMetaByHttp(fid) {
  const settings = await getSettings();
  const { request } = createBrowserTransport(settings);
  const http = createHttp(request, { retries: 1, timeoutMs: 30000 });
  const html = await http.text(`${READER_ORIGIN}${INDEX_PATH}${encodeURIComponent(fid)}`);
  return { meta: parseMeta(html), html };
}

/**
 * 把各种入口统一成 {fid, meta, tabId, created}。
 * spec 支持：{token} | {link} | {fid, pageTabId, meta} | {fid}
 */
async function resolveTarget(spec, { signal }) {
  if (spec.fid && spec.pageTabId) {
    return {
      fid: String(spec.fid).toLowerCase(),
      meta: spec.meta || null,
      tabId: spec.pageTabId,
      created: false,
      fromPage: true,
    };
  }

  if (spec.token) {
    const token = extractToken(spec.token) || String(spec.token);
    const { tabId, fid, created } = await registerViaTab(token, { signal });
    return { fid, tabId, created, meta: null };
  }

  if (spec.link) {
    const link = String(spec.link);
    if (link.includes('personaliiifServlet')) {
      const token = extractToken(link);
      if (!token) throw new AppError('链接里没有可用的令牌。', 'NO_TOKEN');
      const { tabId, fid, created } = await registerViaTab(token, { signal });
      return { fid, tabId, created, meta: null };
    }
    const url = absoluteUrl(link, PORTAL_ORIGIN);
    const tabId = await tabs.createHiddenTab(url);
    try {
      const { fid } = await tabs.waitForFid(tabId, { timeoutMs: 35000, signal });
      await tabs.waitComplete(tabId, { timeoutMs: 20000, signal }).catch(() => {});
      const gone = await tabLooksGone(tabId);
      if (gone) throw new AppError('这篇文章的全文已下架，或当前会话没有权限。', 'GONE');
      return { fid, tabId, created: true, meta: null };
    } catch (err) {
      await tabs.closeTab(tabId);
      throw err;
    }
  }

  if (spec.fid) {
    const fid = String(spec.fid).toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(fid)) throw new AppError('fid 必须是 32 位十六进制。', 'BAD_FID');
    const tabId = await tabs.createHiddenTab(`${READER_ORIGIN}${INDEX_PATH}${fid}`);
    try {
      await tabs.waitComplete(tabId, { timeoutMs: 30000, signal });
      const gone = await tabLooksGone(tabId);
      if (gone) throw new AppError('这个 fid 在当前会话里没有注册过，或文件已不存在。', 'GONE');
      return { fid, tabId, created: true, meta: null };
    } catch (err) {
      await tabs.closeTab(tabId);
      throw err;
    }
  }

  throw new AppError('没有可用的输入（令牌 / 链接 / fid 至少要有一个）。', 'NO_INPUT');
}

function chooseTitle(meta, fid, settings) {
  const infoname = meta && meta.infoname;
  const filename = meta && meta.filename;
  const source = settings.filenameSource || 'infoname';
  if (source === 'filename' && filename) return filename.replace(/\.pdf$/i, '');
  if (source === 'infoname' && infoname) return infoname;
  if (filename) return filename.replace(/\.pdf$/i, '');
  return titleOf(meta, fid);
}

async function runTask(entry, spec) {
  const { signal } = entry.ctrl;
  const http = makeHttp(await getSettings(), signal);
  let target = null;
  try {
    await updateTask(entry, { phase: 'resolve', msg: '正在打开阅读器页面…' });
    target = await resolveTarget(spec, { signal });
    entry.readerTab = target.tabId;
    setWorker(READER_ORIGIN, target.tabId);

    const meta = target.meta || await readMetaFromTab(target.tabId, target.fid);
    const total = pageCount(meta);
    const title = chooseTitle(meta, target.fid, await getSettings());
    await updateTask(entry, { fid: target.fid, title, total, phase: 'urls', msg: `共 ${total} 页，准备下载` });

    const result = await downloadDocument({
      http,
      fid: target.fid,
      meta: { ...meta, infoname: title },
      resolution: (await getSettings()).resolution,
      concurrency: (await getSettings()).concurrency,
      signal,
      onProgress: (p) => {
        updateTask(entry, {
          phase: p.phase,
          done: p.done,
          total: p.total,
          msg: p.msg || '',
          title: p.title || entry.task.title,
        });
      },
    });

    await updateTask(entry, { phase: 'save', msg: '交给浏览器下载…', total: result.pageCount });
    const settings = await getSettings();
    const saved = await saveBytes(result.pdf, result.filename, { saveAs: settings.saveAs });
    await updateTask(entry, {
      status: 'done',
      phase: 'done',
      done: result.pageCount,
      total: result.pageCount,
      filename: saved.filename,
      bytes: result.pdf.length,
      msg: `已保存 ${saved.filename}（${(result.pdf.length / 1024 / 1024).toFixed(1)} MB）`,
    });
    await recordHistory(entry.task);
    logEvent('info', `下载完成：${saved.filename}（${result.pageCount} 页，${(result.pdf.length / 1024).toFixed(0)} KB，via ${saved.via}）`);
  } catch (err) {
    const aborted = signal.aborted || (err && err.code === 'CANCELLED');
    const message = aborted ? '已取消' : ((err && err.message) || String(err));
    await updateTask(entry, {
      status: aborted ? 'cancelled' : 'error',
      phase: aborted ? 'cancelled' : 'error',
      error: message,
      errorCode: (err && err.code) || null,
    });
    if (!aborted) {
      await recordHistory(entry.task);
      logEvent('error', `任务失败（${entry.task.title || entry.task.fid || '未知文档'}）：${message}`);
    }
  } finally {
    setWorker(READER_ORIGIN, null);
    const readerTab = entry.readerTab;
    if (readerTab && target && target.created) await tabs.closeTab(readerTab);
    setTimeout(() => TASKS.delete(entry.task.id), 15 * 60 * 1000);
  }
}

async function startTask(spec) {
  const id = newTaskId();
  const entry = {
    task: {
      id,
      status: 'running',
      phase: 'queued',
      done: 0,
      total: 0,
      title: '',
      fid: String(spec.fid || '').toLowerCase(),
      filename: '',
      error: null,
      errorCode: null,
      msg: '',
      source: spec.source || (spec.pageTabId ? 'page' : spec.token ? 'token' : spec.link ? 'link' : 'fid'),
      sourceTabId: spec.sourceTabId ?? (spec.pageTabId || null),
      startedAt: Date.now(),
      updatedAt: Date.now(),
    },
    ctrl: new AbortController(),
    readerTab: null,
  };
  TASKS.set(id, entry);
  await updateTask(entry, {}, { silent: true });
  runTask(entry, spec).catch((err) => logEvent('error', `任务线程异常：${err && err.message}`));
  return entry.task;
}

function findTask(id) {
  const entry = TASKS.get(id);
  if (entry) return entry;
  return null;
}

// ---------------------------------------------------------------- 门户侧（.17）

/** 用 .17 的隐藏工作页发检索请求（带真实会话 cookie）。 */
async function withPortalWorker(fn) {
  const worker = await tabs.ensureWorker(PORTAL_ORIGIN, { url: SEARCH_URL });
  setWorker(PORTAL_ORIGIN, worker.tabId);
  try {
    const settings = await getSettings();
    return await fn(makeHttp(settings, null), worker);
  } finally {
    setWorker(PORTAL_ORIGIN, null);
    if (worker.created) await tabs.closeTab(worker.tabId);
  }
}

/** 一批门户请求共用一个门户标签页/会话。 */
async function withPortalBatch(fn) {
  const worker = await tabs.ensureWorker(PORTAL_ORIGIN, { url: SEARCH_URL });
  setWorker(PORTAL_ORIGIN, worker.tabId);
  try {
    const settings = await getSettings();
    return await fn(makeHttp(settings, null), worker);
  } finally {
    setWorker(PORTAL_ORIGIN, null);
    if (worker.created) await tabs.closeTab(worker.tabId);
  }
}

async function doSearch(keyword) {
  const rows = await withPortalWorker((http) => portalSearch(http, keyword));
  await setLastKeyword(keyword);
  return rows;
}

/** 解析单条记录的全文链接（docinfo 页 → onlinePDF 链接）。 */
async function doRecordLinks(record) {
  return withPortalWorker((http) => recordLinks(http, record));
}

/** 打开一个 onlinePDF 链接，拿 fid（真实导航）。 */
async function resolveLinkToFid(link, { signal } = {}) {
  const target = await resolveTarget({ link }, { signal });
  const meta = target.meta || await readMetaFromTab(target.tabId, target.fid);
  let title = '';
  try {
    title = titleOf(meta, target.fid);
  } catch {
    title = '';
  }
  if (target.created) await tabs.closeTab(target.tabId);
  setWorker(READER_ORIGIN, null);
  return { fid: target.fid, meta, title };
}

// ---------------------------------------------------------------- 消息路由

async function handleMessage(message, sender) {
  const type = message && message.type;
  const settings = await getSettings();

  switch (type) {
    case 'ping':
      return { ok: true, isFirefox, version: api.runtime.getManifest().version };

    case 'probe': {
      const result = await probeOrigins();
      return { ok: true, ...result };
    }

    case 'settings:get':
      return { ok: true, settings, lastKeyword: await getLastKeyword() };

    case 'settings:set': {
      const next = await setSettings(message.patch || {});
      return { ok: true, settings: next };
    }

    case 'log:get':
      return { ok: true, entries: await readLog().catch(() => []) };

    case 'log:clear': {
      await clearLog().catch(() => {});
      return { ok: true };
    }

    case 'history:get': {
      const got = await api.storage.local.get(HISTORY_KEY);
      return { ok: true, entries: Array.isArray(got[HISTORY_KEY]) ? got[HISTORY_KEY] : [] };
    }

    case 'history:clear': {
      await api.storage.local.remove(HISTORY_KEY);
      return { ok: true };
    }

    case 'open-app':
      await openAppPage(message.hash || '');
      return { ok: true };

    case 'search': {
      const keyword = String(message.keyword || '').trim();
      if (!keyword) throw new AppError('请输入检索词。', 'NO_KEYWORD');
      const result = await doSearch(keyword);
      // 结果行先返回，链接（docinfo → onlinePDF）在后台补齐并逐条广播；
      // 这样 popup 一打开就能看到列表，不必等 20 次 docinfo 往返。
      enrichRowsInBackground(result.rows, sender, { resolveFid: settings.resolveFidOnSearch }).catch(() => {});
      return { ok: true, ...result, keyword };
    }

    case 'record-links': {
      const found = await doRecordLinks(message.record);
      return { ok: true, links: found.links, absLinks: found.absLinks };
    }

    case 'resolve-link': {
      const info = await resolveLinkToFid(message.link);
      return { ok: true, ...info };
    }

    case 'start': {
      const spec = {
        token: message.token,
        link: message.link,
        fid: message.fid,
        pageTabId: message.pageTabId,
        meta: message.meta || null,
        sourceTabId: sender && sender.tab ? sender.tab.id : null,
      };
      if (!spec.token && !spec.link && !spec.fid) {
        throw new AppError('没有可用的输入。', 'NO_INPUT');
      }
      const task = await startTask(spec);
      return { ok: true, task };
    }

    case 'start-from-page': {
      if (!sender || !sender.tab || sender.tab.id === undefined) {
        throw new AppError('只能从阅读器页面里发起。', 'NOT_IN_PAGE');
      }
      const task = await startTask({
        fid: message.fid,
        meta: message.meta || null,
        pageTabId: sender.tab.id,
        source: 'page',
      });
      return { ok: true, task };
    }

    case 'cancel-task': {
      const entry = findTask(message.id);
      if (!entry) return { ok: false, error: '任务不存在或已结束' };
      entry.ctrl.abort();
      return { ok: true };
    }

    case 'get-task': {
      const entry = findTask(message.id);
      if (entry) return { ok: true, task: { ...entry.task } };
      const records = await readTaskRecords();
      const found = records.find((t) => t.id === message.id);
      return found ? { ok: true, task: found } : { ok: false, error: '任务不存在' };
    }

    case 'list-tasks': {
      const memory = Array.from(TASKS.values()).map((e) => ({ ...e.task }));
      const stored = await readTaskRecords();
      const byId = new Map();
      for (const task of [...stored, ...memory]) byId.set(task.id, task);
      const list = Array.from(byId.values()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      return { ok: true, tasks: list.slice(0, 20) };
    }

    case 'get-fid-info': {
      const token = extractToken(message.token || '');
      if (!token) throw new AppError('没找到令牌。', 'NO_TOKEN');
      return { ok: true, info: decodeToken(token) };
    }

    case 'resolve-fids': {
      const rows = Array.isArray(message.rows) ? message.rows : [];
      enrichRowsInBackground(rows, sender, { resolveFid: true }).catch(() => {});
      return { ok: true, started: true };
    }

    default:
      return undefined;
  }
}

/**
 * 后台补全检索结果行的全文链接（docinfo → onlinePDF），逐条广播 row-link；
 * opts.resolveFid 为真时继续解析 fid（默认关闭，因为每条都要开一次阅读器标签页）。
 */
async function enrichRowsInBackground(rows, sender, opts = {}) {
  const list = (rows || []).filter((r) => r && r.id1 && r.id2);
  if (!list.length) return;
  const sourceTabId = sender && sender.tab ? sender.tab.id : null;
  const notify = (payload) => {
    broadcast(payload);
    if (sourceTabId) api.tabs.sendMessage(sourceTabId, payload).catch(() => {});
  };

  const pending = list.filter((r) => !r.link);
  if (pending.length) {
    try {
      await withPortalBatch(async (http) => {
        await mapPool(pending, 4, async (row) => {
          try {
            const found = await recordLinks(http, row);
            const link = (found.absLinks && found.absLinks[0]) || '';
            if (link) row.link = link;
            notify({ type: 'row-link', id1: row.id1, id2: row.id2, link, title: row.title });
          } catch (err) {
            notify({ type: 'row-link', id1: row.id1, id2: row.id2, link: '', error: (err && err.message) || String(err) });
          }
        });
      });
    } catch (err) {
      logEvent('warn', `补全全文链接失败：${err && err.message}`);
    }
  }

  if (opts.resolveFid) await resolveFidsInBackground(list, sender);
}

/** 后台逐个解析检索结果行的 fid，把结果广播给界面。 */
async function resolveFidsInBackground(rows, sender) {
  const list = (rows || []).filter((r) => r && r.link);
  if (!list.length) return;
  const sourceTabId = sender && sender.tab ? sender.tab.id : null;
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    let info = null;
    try {
      info = await resolveLinkToFid(row.link);
    } catch (err) {
      info = { fid: null, error: err && err.message };
    }
    const payload = {
      type: 'row-fid',
      index: i,
      id1: row.id1,
      id2: row.id2,
      link: row.link,
      fid: info.fid || null,
      title: info.title || '',
      error: info.error || null,
    };
    broadcast(payload);
    if (sourceTabId) api.tabs.sendMessage(sourceTabId, payload).catch(() => {});
    if (i < list.length - 1) await sleep(250);
  }
  broadcast({ type: 'row-fid-done', count: list.length });
}

// ---------------------------------------------------------------- 生命周期

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // offscreen 文档的消息由它自己的监听器处理，后台不要抢答
  if (message && message.target === 'offscreen') return false;
  let promise;
  try {
    promise = handleMessage(message, sender);
  } catch (err) {
    sendResponse({ ok: false, error: err && err.message, code: err && err.code });
    return false;
  }
  if (!promise || typeof promise.then !== 'function') {
    if (promise !== undefined) sendResponse(promise);
    return false;
  }
  promise
    .then((reply) => sendResponse(reply === undefined ? { ok: false, error: '未知消息类型' } : reply))
    .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err), code: err && err.code }));
  return true; // 异步回复
});

api.runtime.onInstalled.addListener((details) => {
  logEvent('info', `插件${details.reason === 'install' ? '安装' : details.reason === 'update' ? '更新' : '启用'}（v${api.runtime.getManifest().version}）`);
  if (details.reason === 'install') openAppPage('#/help').catch(() => {});
});

api.runtime.onStartup?.addListener(() => {
  recoverInterruptedTasks().catch(() => {});
});

/** Service worker 被回收后，把“运行中”的任务标为中断，避免界面永远转圈。 */
async function recoverInterruptedTasks() {
  for (const task of await readTaskRecords()) {
    if (task.status === 'running') {
      const patched = {
        ...task,
        status: 'interrupted',
        phase: 'interrupted',
        error: '后台被浏览器回收，任务已中断，请重新下载。',
        updatedAt: Date.now(),
      };
      try {
        await taskStore.set({ [`${TASK_PREFIX}${task.id}`]: patched });
      } catch {
        /* ignore */
      }
    }
  }
}

recoverInterruptedTasks().catch(() => {});
logEvent('info', `后台就绪（${isFirefox ? 'Firefox' : 'Chrome'} v${api.runtime.getManifest().version}）`).catch(() => {});
