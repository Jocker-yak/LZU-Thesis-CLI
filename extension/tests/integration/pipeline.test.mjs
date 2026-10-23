/**
 * 集成测试：真实 src/lib 代码 + 本地 mock 门户/阅读器，跑完整链路：
 *   检索 → docinfo → onlinePDF 302 → 令牌注册 → pdfindex1.jsp → jumpServlet → JPEG → PDF
 * PDF 再用 pdfjs-dist（独立解析器）验证页数与尺寸。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { startMockWorld, MOCK_FID } from '../mock/servers.mjs';
import { createLocalRequest } from '../mock/local-request.mjs';
import { createHttp, AppError } from '../../src/lib/http.js';
import {
  search, recordLinks,
} from '../../src/lib/portal.js';
import {
  loadMeta, pageCount, isRegistered, titleOf,
} from '../../src/lib/reader.js';
import { downloadDocument, mapPool } from '../../src/lib/pipeline.js';
import {
  fidFromUrl, extractToken, decodeToken,
} from '../../src/lib/protocol.js';

const world = await startMockWorld({ host: '127.0.0.1' });

/** 在阅读器会话里“注册”一次（等价隐藏标签页访问 personaliiifServlet?path=令牌）。 */
async function registerSession(http) {
  const res = await http.raw(`http://202.201.7.29/personaliiifServlet?path=${world.state.token}`);
  assert.equal(res.status, 200);
}

function makeHttp() {
  const local = createLocalRequest({
    'http://202.201.7.17': world.portalUrl,
    'http://202.201.7.29': world.readerUrl,
  });
  return { http: createHttp(local.request, { retries: 2, delay: 0.01 }), local };
}

after(async () => {
  await world.close();
});

test('检索：mock 门户返回真实结果页，解析出 20 行 / 总数 77', async () => {
  const { http } = makeHttp();
  const found = await search(http, '侯扶江', { onStep: () => {} });
  assert.equal(found.rows.length, 20);
  assert.equal(found.total, 77);
  assert.equal(found.source, '/resultlist.jsp');
});

test('整条链路：链接 302 到阅读器 → 注册出 fid → 取 meta（带会话 cookie）', async () => {
  const { http, local } = makeHttp();
  const found = await search(http, '侯扶江');
  const row = found.rows.find((r) => r.id1 === '7815c9317d244061ff7d26d8d79863c1');
  assert.ok(row, '结果页里应有抓包记录');

  const { absLinks } = await recordLinks(http, row);
  assert.equal(absLinks.length, 1);
  assert.equal(extractToken(absLinks[0]), '', 'onlinePDF 链接本身不带令牌');

  // 跟 302：门户 → 阅读器 personaliiifServlet → pdfindex1.jsp?fid=…
  const res = await http.raw(absLinks[0]);
  assert.equal(res.status, 200);
  const fid = fidFromUrl(res.url);
  assert.equal(fid, MOCK_FID);

  // 注册后阅读器应该种下 JSESSIONID，index 页才有完整元信息
  assert.ok(local.cookieHeader('http://202.201.7.29/').includes('JSESSIONID='));

  const { meta } = await loadMeta(http, fid);
  assert.equal(isRegistered(meta), true);
  assert.equal(pageCount(meta), 3);
  assert.equal(titleOf(meta, fid), '补播白刺花和施厩肥对两种暖季型草地土壤理化性质和生产力的影响');
});

test('没注册过的会话：index 页字段全 null → NO_META（不会误拼出空 PDF）', async () => {
  const { http } = makeHttp();
  await assert.rejects(loadMeta(http, MOCK_FID).then(({ meta }) => {
    assert.equal(isRegistered(meta), false);
    return downloadDocument({ http, fid: MOCK_FID, meta });
  }), (err) => err instanceof AppError && err.code === 'NO_META');
});

test('下载全文：3 页 JPEG → 图片版 PDF，pdfjs 独立验证页数与尺寸', async () => {
  const { http } = makeHttp();
  const progress = [];
  const { absLinks } = await recordLinks(http, { id1: '7815c9317d244061ff7d26d8d79863c1', id2: 'm6Mz4VdaxFE%253D' });
  void absLinks;

  // 直接走注册 + meta + 下载（等价 background 里的编排）
  const found = await search(http, '侯扶江');
  const row = found.rows.find((r) => r.id1 === '7815c9317d244061ff7d26d8d79863c1');
  const { absLinks: links } = await recordLinks(http, row);
  const res = await http.raw(links[0]);
  const fid = fidFromUrl(res.url);
  const { meta } = await loadMeta(http, fid);
  const result = await downloadDocument({
    http,
    fid,
    meta,
    resolution: 150,
    concurrency: 2,
    onProgress: (p) => progress.push(p),
  });

  assert.equal(result.pageCount, 3);
  assert.equal(result.filename, '补播白刺花和施厩肥对两种暖季型草地土壤理化性质和生产力的影响.pdf');
  assert.equal(result.pageSizes.length, 3);
  assert.deepEqual(result.pageSizes[0], [1024, 750]);
  assert.ok(progress.some((p) => p.phase === 'pages' && p.done === 3), '应报告 3 页进度');
  assert.ok(progress.some((p) => p.phase === 'build'));

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(result.pdf),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;
  assert.equal(doc.numPages, 3);
  const view = (await doc.getPage(1)).getViewport({ scale: 1 });
  assert.ok(Math.abs(view.width - 491.52) < 0.01);
  assert.ok(Math.abs(view.height - 360) < 0.01);
  await doc.destroy();
});

test('某页偶发空列表：补抓一轮后仍能拿到全部 3 页', async () => {
  world.state.readerFault = 'empty-once';
  world.state.emptyOnceUsed = false;
  const { http } = makeHttp();
  await registerSession(http);
  const { meta: meta2 } = await loadMeta(http, MOCK_FID);
  const result = await downloadDocument({ http, fid: MOCK_FID, meta: meta2 });
  assert.equal(result.pageCount, 3);
  assert.equal(new TextDecoder().decode(result.pdf.subarray(0, 8)), '%PDF-1.4');
  assert.equal(pageCount(meta2), 3);
  world.state.readerFault = null;
});

test('服务端说文件不存在：抛 GONE/PAGE_FAILED，不产出坏 PDF', async () => {
  world.state.readerFault = 'gone';
  const { http } = makeHttp();
  await registerSession(http);
  const { meta } = await loadMeta(http, MOCK_FID);
  await assert.rejects(
    downloadDocument({ http, fid: MOCK_FID, meta, pageRetries: 1 }),
    (err) => err instanceof AppError && err.code === 'PAGE_FAILED' && /找不到|不存在|GONE|失败/.test(err.message),
  );
  world.state.readerFault = null;
});

test('mapPool：遵守并发上限、保持顺序、可取消', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
  assert.ok(peak <= 2, `并发峰值 ${peak} 应 <= 2`);

  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(mapPool([1, 2], 1, async () => 1, { signal: ctrl.signal }),
    (err) => err.code === 'CANCELLED');
});
