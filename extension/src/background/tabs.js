/**
 * 标签页工具：隐藏标签页 = 浏览器里的“会话载体”。
 *
 * 关键点：跨域 302 的 Location 用 fetch 读不到，但标签页导航会真实跟随，
 * 最终 URL 里就带着 fid；而且该页面上的 content script 能做同源请求（带真实 cookie）。
 * 参考计划：「bridge 优先 / 隐藏标签页识别 fid」。
 */
import { api, sleep, getTab } from '../lib/ext.js';
import { AppError } from '../lib/http.js';
import { FID_RE } from '../lib/protocol.js';

export const TAB_CLOSED = new AppError('标签页已被关闭', 'TAB_CLOSED');
export const NAV_ERROR = new AppError('页面打不开（连接失败）', 'NAV_ERROR');

const ERROR_URL_PREFIXES = ['chrome-error://', 'about:neterror', 'about:blocked', 'edge-error://'];

export function isErrorPageUrl(url) {
  const s = String(url || '');
  return ERROR_URL_PREFIXES.some((p) => s.startsWith(p));
}

/** 轮询等待标签页满足条件；check(tab) 返回真值即结束。 */
export async function waitForTab(tabId, check, {
  timeoutMs = 30000, pollMs = 350, signal = null, what = '页面',
} = {}) {
  const start = Date.now();
  for (;;) {
    if (signal && signal.aborted) throw new AppError('已取消', 'CANCELLED');
    const tab = await getTab(tabId);
    if (!tab) throw TAB_CLOSED;
    const url = tab.url || tab.pendingUrl || '';
    if (isErrorPageUrl(url)) {
      throw new AppError(`打不开${what}：连接失败（阅读器 202.201.7.29 可能只在校内网可达）`, 'NAV_ERROR');
    }
    const value = await check(tab);
    if (value) return value;
    if (Date.now() - start > timeoutMs) {
      throw new AppError(`等待${what}超时（${Math.round(timeoutMs / 1000)} 秒）`, 'TIMEOUT');
    }
    await sleep(pollMs);
  }
}

/** 等标签页加载完成（status === 'complete'）。 */
export async function waitComplete(tabId, opts = {}) {
  return waitForTab(tabId, (tab) => (tab.status === 'complete' ? tab : null), { what: '页面加载', ...opts });
}

/** 等 URL 里出现 fid（32 位 hex）。 */
export async function waitForFid(tabId, opts = {}) {
  return waitForTab(tabId, (tab) => {
    const url = tab.url || '';
    const m = FID_RE.exec(url);
    return m ? { fid: m[1].toLowerCase(), url } : null;
  }, { what: '阅读器初始化（fid）', ...opts });
}

export async function createHiddenTab(url) {
  const tab = await api.tabs.create({ url, active: false });
  return tab.id;
}

export async function navigate(tabId, url) {
  await api.tabs.update(tabId, { url });
  return tabId;
}

export async function closeTab(tabId) {
  try {
    await api.tabs.remove(tabId);
  } catch {
    /* 已经关了 */
  }
}

/** 找出所有落在指定 origin 的标签页（需要 host_permissions 才能看到 url）。 */
export async function findTabsByOrigin(origin) {
  try {
    const tabs = await api.tabs.query({});
    return (tabs || []).filter((t) => (t.url || '').startsWith(origin));
  } catch {
    return [];
  }
}

/**
 * 向 content script 发消息；content script 可能还没注入，自动重试。
 */
export async function sendToTab(tabId, message, { tries = 14, interval = 250, timeoutMs = 20000 } = {}) {
  const start = Date.now();
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    if (Date.now() - start > timeoutMs) break;
    try {
      const reply = await api.tabs.sendMessage(tabId, message);
      if (reply !== undefined) return reply;
    } catch (err) {
      lastErr = err;
    }
    if (!(await getTab(tabId))) throw TAB_CLOSED;
    await sleep(interval);
  }
  throw new AppError(`页面脚本无响应：${lastErr ? lastErr.message : '超时'}`, 'NO_CONTENT_SCRIPT');
}

/** 确认 content script 已就绪（用于“这个标签页能不能当桥接工作页”）。 */
export async function waitForBridge(tabId, { timeoutMs = 8000 } = {}) {
  return sendToTab(tabId, { type: 'ping' }, { tries: Math.ceil(timeoutMs / 250), timeoutMs });
}

/**
 * 确保某个 origin 上有一个可用的桥接工作页。
 * 优先复用用户已经打开的该站标签页；否则开一个隐藏页（会短暂出现在标签栏）。
 */
export async function ensureWorker(origin, {
  url = '', timeoutMs = 30000, signal = null,
} = {}) {
  for (const tab of await findTabsByOrigin(origin)) {
    try {
      const pong = await waitForBridge(tab.id, { timeoutMs: 2500 });
      if (pong && pong.ok) return { tabId: tab.id, created: false, url: tab.url || '' };
    } catch {
      /* 这个页面可能不是 HTML（如图片），换下一个 */
    }
  }
  const tabId = await createHiddenTab(url || `${origin}/`);
  await waitComplete(tabId, { timeoutMs, signal });
  await waitForBridge(tabId, { timeoutMs: 12000 });
  return { tabId, created: true, url: url || `${origin}/` };
}
