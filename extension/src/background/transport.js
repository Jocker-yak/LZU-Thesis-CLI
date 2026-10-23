/**
 * 后台 HTTP 传输：
 *   1) 优先走 content script 桥接（同源、带真实 cookie、无 CORS / mixed content / SameSite 问题）；
 *   2) 桥接失败再退回 service worker / 后台页自己的 fetch（有 host_permissions，可读跨域响应）。
 *
 * 详见 .PLAN-NOTES.md 「bridge 优先」的理由。
 */
import { AppError } from '../lib/http.js';
import { originOf, READER_ORIGIN, PORTAL_ORIGIN } from '../lib/protocol.js';
import { base64ToBytes, bytesToBase64, logEvent } from '../lib/ext.js';
import { sendToTab, ensureWorker } from './tabs.js';
import { getSettings } from '../lib/settings.js';

const WORKER_URLS = {
  [PORTAL_ORIGIN]: PORTAL_ORIGIN + '/simpsearch.action?ffieldname=xkcode&ffieldkey=07*&dbid=72',
  [READER_ORIGIN]: READER_ORIGIN + '/',
};

/** origin -> 可当桥接工作页的标签页 id。 */
const workers = new Map();

export function setWorker(origin, tabId) {
  if (tabId) workers.set(origin, tabId);
  else workers.delete(origin);
}

export function getWorker(origin) {
  return workers.get(origin) || null;
}

async function bridgeRequest(spec) {
  const origin = originOf(spec.url) || '';
  let tabId = workers.get(origin);
  if (!tabId) {
    const worker = await ensureWorker(origin, { url: WORKER_URLS[origin] || `${origin}/` });
    tabId = worker.tabId;
    workers.set(origin, tabId);
  }
  const reply = await sendToTab(tabId, {
    type: 'http',
    url: spec.url,
    method: spec.method || 'GET',
    headers: spec.headers || {},
    body: spec.body == null ? null : String(spec.body),
    responseType: spec.responseType || 'bytes',
  }, { tries: 8, timeoutMs: spec.timeoutMs || 45000 });
  if (!reply || !reply.ok) {
    throw new AppError(`页面内请求失败：${(reply && reply.error) || '无响应'}`, 'BRIDGE_FAIL');
  }
  return {
    status: reply.status,
    url: reply.url || spec.url,
    headers: reply.headers || {},
    body: reply.bodyBase64 ? base64ToBytes(reply.bodyBase64) : new Uint8Array(0),
  };
}

async function bgRequest(spec) {
  const { url, method = 'GET', headers = {}, body = null, timeoutMs = 45000 } = spec;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body == null ? undefined : body,
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    const outHeaders = {};
    res.headers.forEach((value, key) => { outHeaders[key] = value; });
    return { status: res.status, url: res.url || url, headers: outHeaders, body: buf };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 组装给 lib 层用的 http（createHttp 的 request 参数）。
 * @returns {{request:(spec:object)=>Promise<{status:number,headers:object,body:Uint8Array,url:string}>, mode:string}}
 */
export function createBrowserTransport(settings = { transport: 'auto' }) {
  const mode = settings.transport || 'auto';
  const request = async (spec) => {
    const origin = originOf(spec.url);
    let bridgeErr = null;
    if (mode !== 'bg' && origin) {
      try {
        return await bridgeRequest(spec);
      } catch (err) {
        bridgeErr = err;
        if (mode === 'bridge') throw err;
        logEvent('warn', `桥接失败，改用后台 fetch：${err.message}`, { url: spec.url });
      }
    }
    try {
      return await bgRequest(spec);
    } catch (err) {
      if (bridgeErr) {
        throw new AppError(
          `请求失败（桥接：${bridgeErr.message}；后台：${err.message}）`,
          'REQUEST_FAIL',
        );
      }
      throw err;
    }
  };
  return { request, mode };
}

/** 探测两个站点是否可达（后台 fetch，不开标签页）。 */
export async function probeOrigins() {
  const check = async (origin) => {
    const started = Date.now();
    try {
      const res = await bgRequest({ url: `${origin}/`, timeoutMs: 8000 });
      return { ok: true, status: res.status, ms: Date.now() - started };
    } catch (err) {
      return { ok: false, error: err && err.message, ms: Date.now() - started };
    }
  };
  const [portal, reader] = await Promise.all([check(PORTAL_ORIGIN), check(READER_ORIGIN)]);
  return { portal, reader };
}

export async function loadTransport() {
  const settings = await getSettings();
  return createBrowserTransport(settings);
}

export { bytesToBase64 };
