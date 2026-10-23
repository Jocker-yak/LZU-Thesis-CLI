/**
 * 阅读器（http://202.201.7.29）解析，对应 lzu_fulltext/drm.py 的 Reader。
 *
 * 重要事实（来自 CLI 与实测）：
 *  - 令牌先 GET /personaliiifServlet?path=.. 注册到会话，302 落到 /pdfindex1.jsp?fid=<md5>；
 *  - pdfindex1.jsp 用隐藏域携带元信息（pageCount/filename/infoname…），未注册时全是 null；
 *  - 页面地址要一页一页问 /jumpServlet?page=N&fid=..，返回 {"list":[{"id","src"}]}；
 *  - 图片在 /pdfboxServlet?…（src 可能是相对路径），只有图片流，没有文字层。
 */
import { INDEX_PATH, JUMP_PATH, READER_ORIGIN, GONE_RE } from './protocol.js';
import { AppError } from './http.js';

/** 与 drm.META_FIELDS 同（按 Python 的 dict.fromkeys 去重后的顺序）。 */
export const META_FIELDS = [
  'fid', 'sum', 'pageCount', 'startpage', 'endpage',
  'filename', 'infoname', 'watermark', 'pdfchange',
  'pagewidth', 'pageheight',
];

const NULLISH = new Set(['', 'null', 'NULL', 'Null', 'undefined']);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 从 pdfindex1.jsp 抠隐藏域的值；'null' 当没取到（等价 drm._hidden）。
 * 四种写法都要试：id 在前 / value 在前 / name 在前 / value 在前。
 */
export function hiddenValue(html, name) {
  const n = escapeRe(name);
  const patterns = [
    new RegExp(`id="${n}"[^>]*?value="([^"]*)"`),
    new RegExp(`value="([^"]*)"[^>]*?id="${n}"`),
    new RegExp(`name="${n}"[^>]*?value="([^"]*)"`),
    new RegExp(`value="([^"]*)"[^>]*?name="${n}"`),
  ];
  const src = String(html || '');
  for (const re of patterns) {
    const m = re.exec(src);
    if (m && !NULLISH.has(m[1])) return m[1];
  }
  return null;
}

/**
 * 解析 pdfindex1.jsp 的元信息。
 * @returns {Record<string,string|null>}
 */
export function parseMeta(html) {
  const meta = {};
  for (const key of META_FIELDS) meta[key] = hiddenValue(html, key);
  return meta;
}

/** pageCount → sum → endpage，取第一个可解析的正整数（等价 Reader.page_count）。 */
export function pageCount(meta) {
  for (const key of ['pageCount', 'sum', 'endpage']) {
    const v = meta && meta[key];
    if (v !== null && v !== undefined && /^\d+$/.test(String(v))) {
      const n = Number.parseInt(v, 10);
      if (n > 0) return n;
    }
  }
  throw new AppError(
    '读不到页数：这个会话里可能没有该文档（pdfindex1.jsp 字段全是 null）。'
    + ' fid 必须先在当前浏览器会话里注册过。',
    'NO_META',
  );
}

/** 元信息是否“已注册”（pageCount/sum 至少有一个）。 */
export function isRegistered(meta) {
  return Boolean(meta && (meta.pageCount || meta.sum));
}

/** 阅读器页面上的标题：infoname → filename → fid。 */
export function titleOf(meta, fid = '') {
  return (meta && (meta.infoname || meta.filename)) || fid;
}

/**
 * 从 pdfindex1.jsp 的 HTML 里拿 fid（隐藏域优先，其次看 URL）。
 * @returns {string|null}
 */
export function fidFromHtml(html) {
  const v = hiddenValue(html, 'fid');
  if (v && /^[0-9a-fA-F]{32}$/.test(v)) return v.toLowerCase();
  const m = /\bfid=([0-9a-fA-F]{32})/.exec(String(html || ''));
  return m ? m[1].toLowerCase() : null;
}

/** 解析一次 jumpServlet 的 JSON：{"list":[{"id":..,"src":..}]}。 */
export function parseJumpPayload(text) {
  let data;
  try {
    data = JSON.parse(String(text || '').trim());
  } catch {
    return [];
  }
  const list = (data && data.list) || [];
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list) {
    if (!it || it.src === undefined || it.id === undefined) continue;
    out.push({ id: it.id, src: String(it.src) });
  }
  return out;
}

/** 相对页面地址 → 绝对 URL。 */
export function absolutePageUrl(src) {
  const s = String(src || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `http:${s}`;
  return `${READER_ORIGIN}/${s.replace(/^\/+/, '')}`;
}

/**
 * 逐页取图片地址（完全复刻 Reader.page_urls 的 range(0, n+2) 语义），
 * 再对缺失页做最多两轮补抓。缺页时抛错而不是静默丢页。
 *
 * @param {ReturnType<import('./http.js').createHttp>} http
 * @param {string} fid
 * @param {number} n
 * @param {{signal?:AbortSignal,onProgress?:(p:{done:number,total:number,msg:string})=>void,
 *          extraRounds?:number}} [opts]
 * @returns {Promise<{pages: Map<number,string>, missing:number[], attempts:number}>}
 */
export async function collectPageUrls(http, fid, n, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const pages = new Map();
  let attempts = 0;

  const fetchOne = async (p) => {
    attempts++;
    let text;
    try {
      text = await http.text(`${READER_ORIGIN}${JUMP_PATH.replace('%d', p).replace('%s', fid)}`, {
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      return;
    }
    for (const it of parseJumpPayload(text)) {
      const id = Number.parseInt(it.id, 10);
      if (!Number.isFinite(id)) continue;
      pages.set(id, absolutePageUrl(it.src));
    }
  };

  for (let p = 0; p < n + 2; p++) {
    await fetchOne(p);
    if (pages.size >= n) break;
  }

  const rounds = Math.max(0, opts.extraRounds ?? 2);
  for (let round = 0; round < rounds; round++) {
    const missing = [];
    for (let i = 0; i < n; i++) if (!pages.has(i)) missing.push(i);
    if (!missing.length) break;
    onProgress({ done: pages.size, total: n, msg: `补抓 ${missing.length} 个缺失页（第 ${round + 1} 轮）` });
    for (const p of missing) await fetchOne(p);
  }

  const missing = [];
  for (let i = 0; i < n; i++) if (!pages.has(i)) missing.push(i);
  return { pages, missing, attempts };
}

/** 取一页 JPEG（重试交给 http 层；这里再补一次字节级校验）。 */
export async function fetchPageBytes(http, url, opts = {}) {
  const bytes = await http.bytes(url, { signal: opts.signal });
  return validateJpeg(bytes, url);
}

/** 校验是否是像样的 JPEG（CLI 只跳过 <1KB 的坏页，这里更严格一点）。 */
export function validateJpeg(bytes, url = '') {
  if (!bytes || bytes.length < 1024) {
    throw new AppError(`第 ${url} 页返回的数据太小（${bytes ? bytes.length : 0} B）`, 'BAD_PAGE');
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 300));
    if (GONE_RE.test(head)) {
      throw new AppError('服务端返回“文件不存在”，令牌或会话可能已失效。', 'GONE');
    }
    throw new AppError(`返回的不是 JPEG（开头 ${Array.from(bytes.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' ')}）`, 'NOT_JPEG');
  }
  return bytes;
}

/** 直接解析 index 页 HTML（用于浏览器拿到的落地页 / 或自己 fetch）。 */
export async function loadMeta(http, fid, opts = {}) {
  const html = await http.text(`${READER_ORIGIN}${INDEX_PATH}${encodeURIComponent(fid)}`, {
    signal: opts.signal,
  });
  return { meta: parseMeta(html), html };
}
