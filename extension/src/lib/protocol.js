/**
 * 协议层：与 lzu_fulltext/drm.py 的常量 / 令牌编解码逐字对齐。
 *
 * 令牌格式（实测 501 字符）：
 *   <5 个随机 base64 字符><base64(quote(path, safe="") + "&startpage=..&endpage=..&down=..&watermark=..&filename=..&infoname=..")>
 * 其中 path 是服务器上的 PDF 存储路径（如 D:\DRM\read\WebRoot\store/xxx.pdf），
 * 其余字段值也做过一次 quote。fid = 原始 PDF 的 md5，是文档身份；store 文件名每次请求都会变。
 */

export const READER_ORIGIN = 'http://202.201.7.29';
export const PORTAL_ORIGIN = 'http://202.201.7.17';

export const REGISTER_PATH = '/personaliiifServlet?path=';
export const INDEX_PATH = '/pdfindex1.jsp?fid=';
export const JUMP_PATH = '/jumpServlet?page=%d&fid=%s';

export const SEARCH_URL = PORTAL_ORIGIN +
  '/simpsearch.action?ffieldname=xkcode&ffieldkey=07*&dbid=72';
export const SEARCH_POST_PATH = '/zjresult_two.action';
export const RESULT_URLS = ['/zjresult_two.action', '/resultlist.jsp'];
export const DOCINFO_PATH = '/docinfo.action';

/** fid 出现的位置（302 的 Location 或落地页 URL）。 */
export const FID_RE = /\bfid=([0-9a-fA-F]{32})/;
/** 服务端明确说“文件不在”的特征，重试没有意义（与 drm.py 同）。 */
export const GONE_RE = /FileNotFoundException|系统找不到指定的文件|NoSuchFile/i;
/** docinfo 页里的令牌直链（与 portal.py 同）。 */
export const TOKEN_RE = /personaliiifServlet\?path=([A-Za-z0-9+/=%]+)/g;

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 -> Uint8Array（宽容：忽略非法字符、自动补 padding）。 */
export function base64ToBytes(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '').replace(/=+$/, '');
  if (!clean) return new Uint8Array(0);
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Uint8Array -> base64。 */
export function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * urllib.parse.unquote 的等价实现：按 %XX 还原字节，再按 UTF-8 解码，
 * 非法序列替换成 U+FFFD（Python 的 errors="replace"）。
 */
export function unquote(text) {
  const src = String(text);
  const bytes = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = src.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else {
        for (const b of new TextEncoder().encode(src[i])) bytes.push(b);
      }
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
}

/**
 * urllib.parse.quote(s, safe="") 的等价实现。
 * encodeURIComponent 不转义 !'()*，而 Python 会，这里补齐差异。
 */
export function quote(text, safe = '') {
  let out = encodeURIComponent(String(text)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  for (const ch of String(safe)) {
    if (ch.charCodeAt(0) > 0x7f) continue;
    const enc = '%' + ch.charCodeAt(0).toString(16).toUpperCase();
    out = out.split(enc).join(ch);
  }
  return out;
}

/** 从一段文本（链接 / 页面 HTML / 用户粘贴内容）里取出 DRM 令牌。 */
export function extractToken(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  const m = /personaliiifServlet\?path=([A-Za-z0-9+/=%]+)/.exec(text);
  if (m) return m[1];
  if (/^[A-Za-z0-9+/=%]{20,}$/.test(text)) return text;
  return '';
}

/**
 * 解码令牌。
 * @param {string} token
 * @returns {{prefix:string, path:string, storeName:string, startpage:number|null,
 *            endpage:number|null, down:number|null, watermark:string,
 *            filename:string, infoname:string, fields:Record<string,string>}}
 */
export function decodeToken(token) {
  const raw = String(token || '').trim();
  if (raw.length < 6) throw new Error('令牌太短，无法解析');
  const prefix = raw.slice(0, 5);
  const body = raw.slice(5).replace(/%3[dD]/g, '=');
  // 服务端把 path 与每个字段值都单独做过 percent 编码（如 filename=...%E8%91%A3...），
  // 所以必须「先按 & 切分、再逐段 unquote」；先整体 unquote 会把值里的 %26 变成 & 而切错。
  let payload;
  try {
    payload = new TextDecoder('utf-8', { fatal: false }).decode(base64ToBytes(body));
  } catch (err) {
    throw new Error(`令牌 base64 解码失败：${err.message}`);
  }
  const parts = payload.split('&');
  const path = unquote(parts.shift() || '');
  const fields = Object.create(null);
  for (const kv of parts) {
    const idx = kv.indexOf('=');
    if (idx > 0) fields[kv.slice(0, idx)] = unquote(kv.slice(idx + 1));
  }
  const num = (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  const storeName = path.split(/[\\/]/).pop() || path;
  return {
    prefix,
    path,
    storeName,
    startpage: num(fields.startpage),
    endpage: num(fields.endpage),
    down: num(fields.down),
    watermark: fields.watermark || '',
    filename: fields.filename || '',
    infoname: fields.infoname || '',
    fields: Object.freeze({ ...fields }),
  };
}

function randomPrefix() {
  const bytes = new Uint8Array(5);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => B64_ALPHABET[b % 64]).join('');
}

/**
 * 生成令牌（对应 drm.encode_token，用于自检 / 与 Python 交叉验证）。
 * @param {{path:string, startpage?:number|string, endpage?:number|string,
 *          down?:number|string, watermark?:string, filename?:string,
 *          infoname?:string, prefix?:string}} spec
 */
export function encodeToken(spec) {
  const payload = [
    quote(spec.path, ''),
    `startpage=${quote(spec.startpage ?? 1, '')}`,
    `endpage=${quote(spec.endpage ?? 1, '')}`,
    `down=${quote(spec.down ?? 50, '')}`,
    `watermark=${quote(spec.watermark ?? '', '')}`,
    `filename=${quote(spec.filename ?? 'doc.pdf', '')}`,
    `infoname=${quote(spec.infoname ?? 'doc', '')}`,
  ].join('&');
  return (spec.prefix || randomPrefix()) + bytesToBase64(new TextEncoder().encode(payload));
}

/** 令牌出现在 query 里时 '+' 会被当成空格，所以整体再 quote 一次（net.quote_token）。 */
export function quoteToken(token) {
  return quote(token, '');
}

/** 从 URL 里找 fid。 */
export function fidFromUrl(url) {
  const m = FID_RE.exec(String(url || ''));
  return m ? m[1].toLowerCase() : null;
}

/** 规范化来源：'http://202.201.7.29' / '202.201.7.29' / 完整 URL → origin。 */
export function originOf(input) {
  try {
    return new URL(input).origin;
  } catch {
    const s = String(input).replace(/\/+$/, '');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return `http://${s}`;
    return s;
  }
}
