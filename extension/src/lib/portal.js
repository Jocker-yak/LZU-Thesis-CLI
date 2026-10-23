/**
 * 门户（http://202.201.7.17）解析，对应 lzu_fulltext/portal.py。
 *
 * 门户只负责“找到全文链接”：/onlinePDF?dbid=72&objid=<...>&flag=online
 * 该链接 302 到阅读器 http://202.201.7.29/personaliiifServlet?path=<令牌>。
 */
import {
  PORTAL_ORIGIN, SEARCH_URL, SEARCH_POST_PATH, RESULT_URLS, DOCINFO_PATH,
} from './protocol.js';

/** 结果行：docinfo('id1','id2')">标题</a>，标题里可能夹标签（等价 re.S）。 */
const ROW_RE = /docinfo\('([0-9a-fA-F]+)','([^']+)'\)">([\s\S]*?)<\/a>/g;
const ONLINE_RE = /href="(onlinePDF[^"]+)"/g;
const TOTAL_RE = /共\s*(?:<[^>]*>\s*)*([0-9]+)/;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–',
  hellip: '…', times: '×', bull: '•',
};

/** 解 HTML 实体（含数字实体）；用于纠正 &amp; 之类的链接与标题。 */
export function decodeEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return all;
      try {
        return String.fromCodePoint(code);
      } catch {
        return all;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? all : named;
  });
}

/** 去标签 + 折叠空白（等价 portal.py 的 re.sub(r"<[^>]*>", "") + \s+）。 */
export function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析检索结果行。
 * @returns {{id1:string,id2:string,title:string}[]}
 */
export function parseRows(html) {
  const src = String(html || '');
  const rows = [];
  const seen = new Set();
  for (const m of src.matchAll(ROW_RE)) {
    const id1 = m[1].toLowerCase();
    const id2 = m[2];
    const key = `${id1}|${id2}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ id1, id2, title: stripTags(m[3]) });
  }
  return rows;
}

/** 页面上标注的命中总数（“共 77 条记录”），拿不到返回 null。 */
export function parseTotal(html) {
  const m = TOTAL_RE.exec(String(html || ''));
  return m ? Number.parseInt(m[1], 10) : null;
}

/** docinfo 页里的 onlinePDF 链接（去重排序，等价 portal.online_links）。 */
export function onlineLinks(html) {
  const src = decodeEntities(String(html || ''));
  const links = new Set();
  for (const m of src.matchAll(ONLINE_RE)) links.add(m[1]);
  return Array.from(links).sort();
}

/** 相对链接 → 绝对 URL。 */
export function absoluteUrl(link, base = PORTAL_ORIGIN) {
  const s = String(link || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `http:${s}`;
  return `${base}/${s.replace(/^\/+/, '')}`;
}

/** objid 是 ASCII 码用下划线连起来：'55_55_55_57_56_49' -> '777981'。 */
export function objidToText(objid) {
  try {
    return String(objid).split('_').filter(Boolean).map((x) => String.fromCharCode(Number(x))).join('');
  } catch {
    return String(objid);
  }
}

/**
 * 按关键词检索。
 * 顺序与 portal.search 一致：先访问检索页暖场 → POST zjresult_two.action →
 * 依次 GET RESULT_URLS，取第一个有记录行的页面。
 *
 * @param {ReturnType<import('./http.js').createHttp>} http
 * @param {string} keyword
 * @param {{signal?:AbortSignal, onStep?:(msg:string)=>void}} [opts]
 * @returns {Promise<{rows:Array<{id1:string,id2:string,title:string}>, total:number|null, source:string}>}
 */
export async function search(http, keyword, opts = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('请输入检索关键词');
  const onStep = opts.onStep || (() => {});
  onStep('打开检索页…');
  await http.text(SEARCH_URL, { signal: opts.signal });
  onStep('提交检索…');
  await http.postForm(PORTAL_ORIGIN + SEARCH_POST_PATH, {
    searchkeyword: kw,
    searchstrs: `all:${kw}:and`,
    ffields: '',
    ffieldstr: '',
  }, { signal: opts.signal });

  let total = null;
  for (const path of RESULT_URLS) {
    let html;
    try {
      html = await http.text(PORTAL_ORIGIN + path, { signal: opts.signal });
    } catch (err) {
      if (opts.onStep) opts.onStep(`结果页 ${path} 不可用（${err.message}）`);
      continue;
    }
    const rows = parseRows(html);
    const t = parseTotal(html);
    if (t !== null && total === null) total = t;
    if (rows.length) {
      return { rows, total: total ?? rows.length, source: path };
    }
  }
  return { rows: [], total: total ?? 0, source: '' };
}

/** docinfo 页 HTML（POST id1/id2，与 portal.docinfo_html 同）。 */
export async function docinfoHtml(http, id1, id2, opts = {}) {
  return http.postForm(PORTAL_ORIGIN + DOCINFO_PATH, { id1, id2 }, { signal: opts.signal });
}

/**
 * 一条记录的全文入口：docinfo → onlinePDF 链接。
 * @returns {Promise<{links:string[], absLinks:string[], html:string}>}
 */
export async function recordLinks(http, record, opts = {}) {
  const html = await docinfoHtml(http, record.id1, record.id2, opts);
  const links = onlineLinks(html);
  return { links, absLinks: links.map((l) => absoluteUrl(l)), html };
}
