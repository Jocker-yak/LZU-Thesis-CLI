/**
 * 流水线（与运行环境无关）：注册后的 fid → 抓页面地址 → 抓 JPEG → 合成 PDF。
 * 浏览器里由 background 调用；Node 测试里用注入的 http 直接跑。
 */
import { AppError, GoneError } from './http.js';
import {
  pageCount, collectPageUrls, fetchPageBytes, titleOf,
} from './reader.js';
import { jpegInfo, buildPdf, safeName } from './pdf.js';
import { REGISTER_PATH, READER_ORIGIN, GONE_RE, FID_RE } from './protocol.js';

/**
 * 并发池：按顺序返回结果，支持取消。
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, index:number)=>Promise<R>} worker
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function mapPool(items, limit, worker, opts = {}) {
  const results = new Array(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  const checkAbort = () => {
    if (opts.signal && opts.signal.aborted) {
      throw new AppError('已取消', 'CANCELLED');
    }
  };
  const run = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      checkAbort();
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: lanes }, run));
  return results;
}

/**
 * 用令牌注册（仅 Node 侧测试 / 诊断用）。
 * 浏览器里必须走隐藏标签页：302 的 Location 是跨域，fetch 读不到。
 *
 * @returns {Promise<{fid:string|null, status:number|null, location:string, body:string}>}
 */
export async function registerByFetch(http, token) {
  const res = await http.raw(`${READER_ORIGIN}${REGISTER_PATH}${token}`, { retries: 1 });
  const location = res.headers.location || '';
  const m = FID_RE.exec(location);
  const body = new TextDecoder('utf-8', { fatal: false }).decode(res.body);
  return { fid: m ? m[1].toLowerCase() : null, status: res.status, location, body };
}

/**
 * 抓一本全文并合成 PDF。
 *
 * @param {{http:ReturnType<import('./http.js').createHttp>,
 *          fid:string, meta:Record<string,string|null>,
 *          resolution?:number, concurrency?:number, pageRetries?:number,
 *          signal?:AbortSignal,
 *          onProgress?:(p:{phase:string,done:number,total:number,msg?:string,title?:string})=>void}} spec
 * @returns {Promise<{pdf:Uint8Array, filename:string, title:string,
 *                    pageCount:number, meta:object, pageSizes:number[][]}>}
 */
export async function downloadDocument(spec) {
  const {
    http, fid, meta, resolution = 150, concurrency = 2, pageRetries = 2,
  } = spec;
  const signal = spec.signal;
  const emit = spec.onProgress || (() => {});
  if (!fid) throw new AppError('缺少 fid', 'NO_FID');

  const n = pageCount(meta);
  const title = titleOf(meta, fid);
  emit({ phase: 'meta', done: 0, total: n, title });

  emit({ phase: 'urls', done: 0, total: n, msg: `共 ${n} 页，获取页面地址…`, title });
  const { pages: urlMap, missing } = await collectPageUrls(http, fid, n, {
    signal,
    onProgress: (p) => emit({ phase: 'urls', done: p.done, total: p.total, msg: p.msg, title }),
  });
  if (missing.length) {
    throw new AppError(
      `有 ${missing.length} 页拿不到图片地址（第 ${missing.slice(0, 10).map((i) => i + 1).join('、')}${missing.length > 10 ? '…' : ''} 页）。`
      + ' 阅读器服务可能不稳定，请稍后重试。',
      'MISSING_PAGES',
    );
  }

  const indices = Array.from({ length: n }, (_, i) => i);
  let done = 0;
  const pages = await mapPool(indices, concurrency, async (i) => {
    const url = urlMap.get(i);
    let lastErr = null;
    for (let attempt = 0; attempt <= pageRetries; attempt++) {
      if (signal && signal.aborted) throw new AppError('已取消', 'CANCELLED');
      try {
        const bytes = await fetchPageBytes(http, url, { signal });
        const info = jpegInfo(bytes);
        done++;
        emit({ phase: 'pages', done, total: n, msg: `第 ${i + 1}/${n} 页`, title });
        return { jpeg: bytes, info };
      } catch (err) {
        lastErr = err;
        // 服务端明确说“文件不存在”时不再重试这一页（GoneError / AppError('GONE') 都算）
        if (err && (err.code === 'GONE' || err instanceof GoneError)) break;
        if (attempt < pageRetries) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
    }
    throw new AppError(`第 ${i + 1} 页下载失败：${lastErr && lastErr.message}`, 'PAGE_FAILED');
  }, { signal });

  emit({ phase: 'build', done: n, total: n, msg: '合成 PDF…', title });
  const pdf = buildPdf(pages, { title, resolution });

  const filename = `${safeName(title, { fallback: fid.slice(0, 8) })}.pdf`;
  return {
    pdf,
    filename,
    title,
    pageCount: n,
    meta,
    pageSizes: pages.map((p) => [p.info.width, p.info.height]),
  };
}

/** 判断一段文本是不是“文件不存在”类错误（供 UI 给更准的文案）。 */
export function looksGone(text) {
  return GONE_RE.test(String(text || ''));
}
