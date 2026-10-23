/**
 * 一次性抓取真实门户（202.201.7.17）页面，存成测试 fixture。
 *
 *   node tests/fixtures/capture.mjs [关键字]
 *
 * 只读操作：检索 + 打开论文信息页 + 取一次 onlinePDF 的 302 Location（不下载正文）。
 * 需要能直连校园门户（本环境 .17 可达，.29 不可达）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PORTAL_ORIGIN, SEARCH_URL, SEARCH_POST_PATH, RESULT_URLS, DOCINFO_PATH,
  decodeToken, extractToken,
} from '../../src/lib/protocol.js';
import {
  parseRows, parseTotal, onlineLinks, absoluteUrl,
} from '../../src/lib/portal.js';
import { createHttp } from '../../src/lib/http.js';
import { makeNodeRequest } from '../mock/node-request.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'portal');
const KEYWORD = process.argv[2] || '侯扶江';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT, { recursive: true });
  const node = makeNodeRequest();
  const http = createHttp(node.request, { retries: 2, timeoutMs: 30000 });

  // 1) 检索（与 CLI 同顺序：暖场 → POST → 结果页）
  console.log('搜索：', KEYWORD);
  const searchRes = await http.raw(SEARCH_URL);
  console.log('warm', searchRes.status);
  await http.postForm(`${PORTAL_ORIGIN}${SEARCH_POST_PATH}`, {
    searchkeyword: KEYWORD,
    searchstrs: `all:${KEYWORD}:and`,
    ffields: '',
    ffieldstr: '',
  });

  let html = '';
  let source = '';
  for (const path of RESULT_URLS) {
    try {
      const text = await http.text(`${PORTAL_ORIGIN}${path}`);
      const rows = parseRows(text);
      console.log('result', path, 'len=', text.length, 'rows=', rows.length);
      if (rows.length) {
        html = text;
        source = path;
        break;
      }
    } catch (err) {
      console.log('result', path, 'failed:', err.message);
    }
  }
  if (!html) throw new Error('没有拿到检索结果页');
  await writeFile(join(OUT, 'resultlist.html'), html);
  const rows = parseRows(html);
  console.log(`fixture: resultlist.html ${html.length}B  rows=${rows.length}  total=${parseTotal(html)} source=${source}`);

  const imgs = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  console.log('result page images:', imgs.slice(0, 6));

  // 2) 找一份“有全文链接”和一份“没有”的 docinfo 页
  let withLink = null;
  let emptySaved = false;
  for (const row of rows) {
    if (withLink && emptySaved) break;
    let info;
    try {
      info = await http.postForm(`${PORTAL_ORIGIN}${DOCINFO_PATH}`, { id1: row.id1, id2: row.id2 });
    } catch (err) {
      console.log('docinfo failed:', err.message);
      continue;
    }
    const links = onlineLinks(info);
    if (links.length && !withLink) {
      await writeFile(join(OUT, 'docinfo-link.html'), info);
      withLink = { row, links, html: info };
      console.log('fixture: docinfo-link.html links=', links);
    } else if (!links.length && !emptySaved) {
      await writeFile(join(OUT, 'docinfo-empty.html'), info);
      emptySaved = true;
      console.log('fixture: docinfo-empty.html');
    }
    await sleep(350);
  }

  // 3) 解析一条真实令牌（只读 302，不访问阅读器）
  if (withLink) {
    const link = absoluteUrl(withLink.links[0], PORTAL_ORIGIN);
    const res = await node.request({ url: link, redirect: 'manual' });
    const location = res.headers.location || res.headers.Location || '';
    const token = extractToken(location) || extractToken(link);
    console.log('onlinePDF status=', res.status, 'location=', String(location).slice(0, 100));
    let decoded = null;
    let error = null;
    if (token) {
      try {
        decoded = decodeToken(token);
      } catch (err) {
        error = err.message;
      }
    }
    await writeFile(join(OUT, 'token.json'), JSON.stringify({
      keyword: KEYWORD,
      row: withLink.row,
      linkHref: withLink.links[0],
      linkUrl: link,
      status: res.status,
      token,
      location,
      decoded,
      error,
      capturedAt: new Date().toISOString(),
    }, null, 2));
    console.log('fixture: token.json token.length=', token ? token.length : 0, 'decoded.ok=', !!decoded);
  } else {
    console.log('这个关键字下没找到带 onlinePDF 的记录，换关键字再试');
  }

  // 4) 顺手存一张真实 JPEG（若结果页有封面图）
  const jpeg = imgs.find((u) => /\.jpe?g(\?|$)/i.test(u));
  if (jpeg) {
    const url = absoluteUrl(jpeg, PORTAL_ORIGIN);
    try {
      const res = await node.request({ url });
      const type = res.headers['content-type'] || '';
      if (res.status === 200 && /image\/(jpe?g)/i.test(type)) {
        await writeFile(join(OUT, 'sample.jpg'), res.body);
        console.log(`fixture: sample.jpg ${res.body.length}B`);
      } else {
        console.log('sample image skipped', res.status, type);
      }
    } catch (err) {
      console.log('sample image failed:', err.message);
    }
  }

  console.log('done →', OUT);
}

main().catch((err) => {
  console.error('capture failed:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
