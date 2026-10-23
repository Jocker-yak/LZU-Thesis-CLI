/**
 * 浏览器 API 适配层：Chrome / Firefox 共用。
 *
 * - Chrome MV3 的 chrome.* 大部分 API 已返回 Promise；
 * - Firefox 用 browser.*（原生 Promise）；
 * - 统一取 `globalThis.browser ?? globalThis.chrome`。
 */
export const api = globalThis.browser ?? globalThis.chrome;

/**
 * 判断是不是 Firefox。
 *
 * 注意：**不能**再用 `typeof globalThis.browser !== 'undefined'` —— Chromium 156 开始
 * 也提供了 `browser` 命名空间（跨浏览器兼容层），拿它判断会把 Chrome 误认成 Firefox，
 * 进而在 Chrome 里走 Firefox 的下载/probe 分支。改用 Firefox 独有的
 * `runtime.getBrowserInfo`（Chrome 里是 undefined），再用 UA 兜底。
 */
const navUserAgent = (() => {
  try {
    return String((typeof navigator !== 'undefined' && navigator.userAgent) || '');
  } catch {
    return '';
  }
})();
export const isFirefox = typeof (api && api.runtime && api.runtime.getBrowserInfo) === 'function'
  || navUserAgent.includes('Firefox/');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function runtimeURL(path) {
  return api.runtime.getURL(path);
}

/** 向所有扩展页面广播（popup / 工作台）；没有接收者时的报错要吞掉。 */
export async function broadcast(message) {
  try {
    await api.runtime.sendMessage(message);
  } catch {
    /* 没有打开的扩展页面 */
  }
}

/** 当前窗口的活动标签页（url 只有在 host_permissions 覆盖时可见）。 */
export async function activeTab() {
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  } catch {
    return null;
  }
}

export async function getTab(tabId) {
  try {
    return await api.tabs.get(tabId);
  } catch {
    return null;
  }
}

const LOG_KEY = 'log';
const LOG_LIMIT = 200;

/** 追加一条本地日志（环形，最多 200 条）。 */
export async function logEvent(level, message, extra) {
  try {
    const got = await api.storage.local.get(LOG_KEY);
    const list = Array.isArray(got[LOG_KEY]) ? got[LOG_KEY] : [];
    list.push({
      t: Date.now(),
      level: String(level || 'info'),
      message: String(message || ''),
      extra: extra ? JSON.parse(JSON.stringify(extra)) : undefined,
    });
    await api.storage.local.set({ [LOG_KEY]: list.slice(-LOG_LIMIT) });
  } catch {
    /* 日志失败不影响主流程 */
  }
  if (level === 'error') console.warn('[LZU]', message, extra || '');
}

export async function readLog() {
  const got = await api.storage.local.get(LOG_KEY);
  return Array.isArray(got[LOG_KEY]) ? got[LOG_KEY] : [];
}

export async function clearLog() {
  await api.storage.local.set({ [LOG_KEY]: [] });
}

/** 打开工作台页面。 */
export async function openAppPage(hash = '') {
  const url = runtimeURL('app.html') + (hash ? `#${hash}` : '');
  try {
    const existing = await api.tabs.query({ url: runtimeURL('app.html') + '*' });
    if (existing && existing.length) {
      await api.tabs.update(existing[0].id, { active: true, url });
      return existing[0].id;
    }
  } catch {
    /* query by url 需要 tabs 权限；没有就新开 */
  }
  const tab = await api.tabs.create({ url });
  return tab.id;
}

// base64 的纯 JS 实现在 protocol.js（同一份代码要进 content script 沙箱，见那里的注释）。
export { bytesToBase64, base64ToBytes } from './protocol.js';
