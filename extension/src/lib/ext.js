/**
 * 浏览器 API 适配层：Chrome / Firefox 共用。
 *
 * - Chrome MV3 的 chrome.* 大部分 API 已返回 Promise；
 * - Firefox 用 browser.*（原生 Promise）；
 * - 统一取 `globalThis.browser ?? globalThis.chrome`。
 */
export const api = globalThis.browser ?? globalThis.chrome;
export const isFirefox = typeof globalThis.browser !== 'undefined';

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

export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(text) {
  const clean = String(text || '').replace(/[^A-Za-z0-9+/=]/g, '');
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
