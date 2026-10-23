/**
 * 统一的 HTTP 客户端（浏览器 / Node 通用）。
 *
 * 真正的传输由注入的 `request(spec)` 完成：
 *   spec = {url, method, headers, body, timeoutMs}
 *   -> {status, headers, body: Uint8Array, url}
 * 浏览器里是「后台 fetch 或 content-script 同源桥接」，Node 测试里是全局 fetch。
 *
 * 重试策略与 lzu_fulltext/net.py 对齐：网络异常 / 5xx 重试（间隔 1.5s * n），
 * 4xx 与「文件不存在」类确定性错误不重试。
 */
import { GONE_RE } from './protocol.js';

export class HttpError extends Error {
  constructor(message, { status = null, url = '', body = '', cause = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.cause = cause;
  }
}

/** 服务端明确表示文件不在（令牌过期 / 路径不存在）。 */
export class GoneError extends HttpError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'GoneError';
  }
}

/** 非 HTTP 的失败（没有页面、字段全 null、超时……）。 */
export class AppError extends Error {
  constructor(message, code = 'APP_ERROR') {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

const CHARSET_RE = /charset\s*=\s*["']?([\w-]+)/i;
const META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i;

/** 根据 Content-Type / <meta charset> 选字符集解码；默认 UTF-8（与 CLI 一致）。 */
export function decodeText(bytes, contentType = '') {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let charset = '';
  const m = CHARSET_RE.exec(contentType || '');
  if (m) charset = m[1].toLowerCase();
  if (!charset) {
    const head = new TextDecoder('latin1').decode(buf.subarray(0, 4096));
    const mm = META_CHARSET_RE.exec(head);
    if (mm) charset = mm[1].toLowerCase();
  }
  if (charset === 'gb2312' || charset === 'gbk' || charset === 'gb18030') {
    try {
      return new TextDecoder('gb18030', { fatal: false }).decode(buf);
    } catch {
      /* 环境不支持就退回 UTF-8 */
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {(spec:{url:string,method?:string,headers?:Record<string,string>,
 *                body?:string|null,timeoutMs?:number}) => Promise<{status:number,
 *                headers:Record<string,string>, body:Uint8Array, url?:string}>} request
 * @param {{retries?:number, timeoutMs?:number, delay?:number}} [opts]
 */
export function createHttp(request, { retries = 3, timeoutMs = 45000, delay = 1.5 } = {}) {
  const headersOf = (res) => {
    const out = {};
    for (const [k, v] of Object.entries(res.headers || {})) out[k.toLowerCase()] = v;
    return out;
  };

  async function raw(url, opts = {}) {
    const tries = Math.max(1, opts.retries ?? retries);
    const baseDelay = opts.delay ?? delay;
    let last = null;
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const res = await request({
          url,
          method: opts.method || 'GET',
          headers: opts.headers || {},
          body: opts.body ?? null,
          timeoutMs: opts.timeoutMs ?? timeoutMs,
        });
        return {
          status: res.status,
          url: res.url || url,
          headers: headersOf(res),
          body: res.body || new Uint8Array(0),
        };
      } catch (err) {
        last = err;
        const isAbort = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
        if (isAbort) throw err;
        if (attempt + 1 < tries) await sleep(baseDelay * 1000 * (attempt + 1));
      }
    }
    throw new HttpError(`网络请求失败：${last && last.message}`, { url, cause: last });
  }

  function check(res, { asText = true } = {}) {
    if (res.status >= 200 && res.status < 400) return res;
    const text = asText ? decodeText(res.body, res.headers['content-type']) : '';
    const snippet = text.slice(0, 400);
    if (res.status >= 500 && GONE_RE.test(text)) {
      throw new GoneError(
        `服务端找不到该文件（HTTP ${res.status}）。令牌可能已过期，或文件已不在服务器上。`,
        { status: res.status, url: res.url, body: snippet },
      );
    }
    throw new HttpError(`HTTP ${res.status}：${snippet.slice(0, 160) || res.url}`,
      { status: res.status, url: res.url, body: snippet });
  }

  async function withStatus(url, opts = {}) {
    const res = await raw(url, opts);
    return check(res, { asText: opts.asText !== false });
  }

  async function text(url, opts = {}) {
    const res = await withStatus(url, { ...opts, asText: true });
    return decodeText(res.body, res.headers['content-type']);
  }

  async function bytes(url, opts = {}) {
    const res = await withStatus(url, { ...opts, asText: false });
    return res.body;
  }

  async function json(url, opts = {}) {
    const rawText = await text(url, opts);
    try {
      return JSON.parse(rawText);
    } catch (err) {
      throw new AppError(`返回的不是 JSON：${rawText.slice(0, 120)}`, 'BAD_JSON');
    }
  }

  /** application/x-www-form-urlencoded POST，跟随后端 302。 */
  async function postForm(url, fields, opts = {}) {
    const body = new URLSearchParams(fields).toString();
    return text(url, {
      ...opts,
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(opts.headers || {}),
      },
    });
  }

  return { raw, text, bytes, json, postForm, request, check };
}
