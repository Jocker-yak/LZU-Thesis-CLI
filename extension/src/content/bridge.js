/**
 * content script 公共部分：
 * 1) 消息桥：background 让我们在**本页同源**发请求（带真实 cookie），
 *    这是整条链路能跑通的关键（见 .PLAN-NOTES.md「传输：bridge 优先」）。
 * 2) 页面上隐藏域元信息的读取。
 */
import { api } from '../lib/ext.js';
import { parseMeta, fidFromHtml, pageCount } from '../lib/reader.js';

const CHUNK = 0x8000;

/** Uint8Array → base64（分块，避免 apply 参数过长）。 */
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function doFetch(spec) {
  try {
    const res = await fetch(spec.url, {
      method: spec.method || 'GET',
      headers: spec.headers || {},
      body: spec.body == null ? undefined : spec.body,
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
    });
    const body = new Uint8Array(await res.arrayBuffer());
    const headers = {};
    res.headers.forEach((value, key) => { headers[key] = value; });
    return {
      ok: true,
      status: res.status,
      url: res.url || spec.url,
      headers,
      bodyBase64: bytesToBase64(body),
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function pageHtml() {
  return document.documentElement ? document.documentElement.outerHTML : '';
}

function pageText() {
  return document.body ? (document.body.innerText || '') : '';
}

/** 读取本页的 pdfindex1.jsp 元信息（隐藏域 id/name 顺序不定，交给 parseMeta）。 */
export function readPageMeta() {
  return parseMeta(pageHtml());
}

/** 本页的 fid：隐藏域优先，其次 URL。 */
export function readPageFid() {
  return fidFromHtml(pageHtml()) || fidFromUrlSafe(location.href);
}

function fidFromUrlSafe(url) {
  const m = /\bfid=([0-9a-fA-F]{32})/.exec(String(url || ''));
  return m ? m[1].toLowerCase() : null;
}

/** 本页是不是“已注册的阅读器页”（能读到页数）。 */
export function isReaderPage() {
  try {
    const meta = readPageMeta();
    return Boolean(pageCount(meta) > 0 && readPageFid());
  } catch {
    return false;
  }
}

/**
 * 装消息桥；返回 true 表示装上了。
 * 只处理给 content script 的消息，其余放行。
 */
export function installBridge() {
  if (window.__lzuBridgeInstalled) return false;
  window.__lzuBridgeInstalled = true;

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    switch (message.type) {
      case 'ping':
        sendResponse({ ok: true, url: location.href });
        return false;
      case 'http':
        doFetch(message).then(sendResponse);
        return true;
      case 'get-html':
        sendResponse({ ok: true, html: pageHtml(), url: location.href });
        return false;
      case 'get-text':
        sendResponse({ ok: true, text: pageText(), url: location.href });
        return false;
      case 'get-meta':
        sendResponse({ ok: true, meta: readPageMeta(), fid: readPageFid(), url: location.href });
        return false;
      case 'get-links': {
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map((a) => a.getAttribute('href'))
          .filter((href) => href && /onlinePDF/i.test(href));
        sendResponse({ ok: true, links });
        return false;
      }
      default:
        return false;
    }
  });
  return true;
}
