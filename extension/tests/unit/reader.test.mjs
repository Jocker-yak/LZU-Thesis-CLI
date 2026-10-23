/** 阅读器解析（pdfindex1.jsp 隐藏域 / jumpServlet / 页面地址）。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  META_FIELDS, hiddenValue, parseMeta, pageCount, isRegistered, titleOf,
  fidFromHtml, parseJumpPayload, absolutePageUrl, validateJpeg,
  collectPageUrls, fetchPageBytes, loadMeta,
} from '../../src/lib/reader.js';
import { AppError } from '../../src/lib/http.js';
import { READER_ORIGIN } from '../../src/lib/protocol.js';
import { fixtureBuffer } from '../fixtures/load.mjs';

const FID = '0f86d523cf98c2e7d4a8416c4d6bd7ee';

const INDEX_HTML = `<!doctype html><html><body>
<input type="hidden" id="fid" value="${FID}">
<input type="hidden" id="sum" value="null">
<input type="hidden" id="pageCount" value="12">
<input type="hidden" id="startpage" value="1">
<input type="hidden" id="endpage" value="12">
<input type="hidden" name="filename" value="262010_220220931930_示例作者_free.pdf">
<input type="hidden" value="补播白刺花" name="infoname">
<input type="hidden" value="" name="watermark">
</body></html>`;

test('hiddenValue：id 在前 / value 在前 / name 在前 / value+name 都能取到', () => {
  assert.equal(hiddenValue(INDEX_HTML, 'fid'), FID);
  assert.equal(hiddenValue(INDEX_HTML, 'pageCount'), '12');
  assert.equal(hiddenValue(INDEX_HTML, 'filename'), '262010_220220931930_示例作者_free.pdf');
  assert.equal(hiddenValue(INDEX_HTML, 'infoname'), '补播白刺花');
  assert.equal(hiddenValue(INDEX_HTML, 'watermark'), null, '空值应当作没取到');
});

test("hiddenValue：'null' / 'NULL' / '' 都当没取到（等价 drm._hidden）", () => {
  const html = '<input id="pageCount" value="null"><input id="sum" value="NULL"><input name="fid" value="">';
  assert.equal(hiddenValue(html, 'pageCount'), null);
  assert.equal(hiddenValue(html, 'sum'), null);
  assert.equal(hiddenValue(html, 'fid'), null);
});

test('parseMeta：按 META_FIELDS 收集；未注册页 pageCount/sum 为 null', () => {
  const meta = parseMeta(INDEX_HTML);
  assert.deepEqual(Object.keys(meta), META_FIELDS);
  assert.equal(meta.pageCount, '12');
  assert.equal(meta.sum, null);
  assert.equal(isRegistered(meta), true);

  const unregistered = parseMeta('<input id="fid" value="' + FID + '"><input id="pageCount" value="null">');
  assert.equal(isRegistered(unregistered), false);
});

test('pageCount：pageCount → sum → endpage 优先级，取不到抛 NO_META', () => {
  assert.equal(pageCount({ pageCount: '12', sum: '99', endpage: '12' }), 12);
  assert.equal(pageCount({ pageCount: null, sum: '20', endpage: '7' }), 20);
  assert.equal(pageCount({ pageCount: null, sum: null, endpage: '7' }), 7);
  assert.equal(pageCount({ pageCount: '0', sum: null, endpage: '5' }), 5, '0 不算有效页数');
  assert.throws(() => pageCount({ pageCount: null, sum: null, endpage: null }),
    (err) => err instanceof AppError && err.code === 'NO_META');
});

test('titleOf / fidFromHtml', () => {
  assert.equal(titleOf({ infoname: '题名', filename: 'a.pdf' }, FID), '题名');
  assert.equal(titleOf({ infoname: null, filename: 'a.pdf' }, FID), 'a.pdf');
  assert.equal(titleOf({}, FID), FID);
  assert.equal(fidFromHtml(INDEX_HTML), FID);
  assert.equal(fidFromHtml(`<a href="/pdfindex1.jsp?fid=${FID.toUpperCase()}">x</a>`), FID);
  assert.equal(fidFromHtml('<html></html>'), null);
});

test('parseJumpPayload：正常 JSON / 坏 JSON / 缺字段', () => {
  assert.deepEqual(parseJumpPayload('{"list":[{"id":0,"src":"/pdfboxServlet?id=1"},{"id":"1","src":"/x"}]}'),
    [{ id: 0, src: '/pdfboxServlet?id=1' }, { id: '1', src: '/x' }]);
  assert.deepEqual(parseJumpPayload('not json'), []);
  assert.deepEqual(parseJumpPayload('{"list":[{"id":1}]}'), []);
  assert.deepEqual(parseJumpPayload(''), []);
});

test('absolutePageUrl：相对 / 绝对 / 协议相对', () => {
  assert.equal(absolutePageUrl('/pdfboxServlet?id=1'), `${READER_ORIGIN}/pdfboxServlet?id=1`);
  assert.equal(absolutePageUrl('pdfboxServlet?id=1'), `${READER_ORIGIN}/pdfboxServlet?id=1`);
  assert.equal(absolutePageUrl('http://202.201.7.29/a'), 'http://202.201.7.29/a');
  assert.equal(absolutePageUrl('//202.201.7.29/a'), 'http://202.201.7.29/a');
});

test('validateJpeg：真实 1024×750 JPEG 通过；太小或非 JPEG 抛错', async () => {
  const jpeg = await fixtureBuffer('images/school.jpg');
  assert.equal(validateJpeg(jpeg).length, jpeg.length);
  assert.throws(() => validateJpeg(new Uint8Array(10)), (e) => e.code === 'BAD_PAGE');
  // 服务端“文件不存在”页面 → GONE（而不是笼统的 NOT_JPEG）
  const gone = new TextEncoder().encode('<html>java.io.FileNotFoundException: /x</html>');
  const goneBytes = new Uint8Array(2048);
  for (let i = 0; i < goneBytes.length; i++) goneBytes[i] = gone[i % gone.length];
  assert.throws(() => validateJpeg(goneBytes), (e) => e.code === 'GONE');
  // 普通 HTML 错误页 → NOT_JPEG
  const html = new TextEncoder().encode('<html>系统维护中，请稍后再试</html>');
  const htmlBytes = new Uint8Array(2048);
  for (let i = 0; i < htmlBytes.length; i++) htmlBytes[i] = html[i % html.length];
  assert.throws(() => validateJpeg(htmlBytes), (e) => e.code === 'NOT_JPEG');
});

test('collectPageUrls：按 n+2 循环取页，取满即停', async () => {
  const seen = [];
  const http = {
    async text(url) {
      const m = /page=(\d+)/.exec(url);
      const p = m ? Number(m[1]) : 0;
      seen.push(p);
      if (p >= 3) return '{"list":[]}';
      return JSON.stringify({ list: [{ id: p, src: `/pdfboxServlet?id=${p + 1}` }] });
    },
  };
  const { pages, missing, attempts } = await collectPageUrls(http, FID, 3);
  assert.deepEqual([...pages.keys()], [0, 1, 2]);
  assert.equal(pages.get(1), `${READER_ORIGIN}/pdfboxServlet?id=2`);
  assert.deepEqual(missing, []);
  assert.equal(attempts, 3);
  assert.deepEqual(seen, [0, 1, 2]);
});

test('collectPageUrls：缺页时补抓（模拟偶发空响应）', async () => {
  const counts = new Map();
  const http = {
    async text(url) {
      const p = Number(/page=(\d+)/.exec(url)[1]);
      const c = (counts.get(p) || 0) + 1;
      counts.set(p, c);
      // 第 1 页第一次故意返回空，之后正常；第 4 页永远空（超出页数范围）
      if (p === 1 && c === 1) return '{"list":[]}';
      if (p >= 2) return '{"list":[]}';
      return JSON.stringify({ list: [{ id: p, src: `/p${p}` }] });
    },
  };
  const progress = [];
  const { pages, missing } = await collectPageUrls(http, FID, 2, {
    onProgress: (p) => progress.push(p.msg),
  });
  assert.deepEqual([...pages.keys()], [0, 1]);
  assert.deepEqual(missing, []);
  assert.ok(progress.some((m) => m.includes('补抓')), '应报告补抓进度');
});

test('collectPageUrls：确实缺页时返回 missing 列表（不静默丢页）', async () => {
  const http = {
    async text(url) {
      const p = Number(/page=(\d+)/.exec(url)[1]);
      if (p === 1) return '{"list":[]}';
      return JSON.stringify({ list: [{ id: p, src: `/p${p}` }] });
    },
  };
  // range(0, n+2) 循环：p=0 拿到 0 页；p=1 空；p=2 拿到「id=2」→ size 达到 n=2 就停，
  // 于是缺的是 1（与 CLI 的循环语义一致），补抓仍拿不到 → missing=[1]。
  const { pages, missing } = await collectPageUrls(http, FID, 2, { extraRounds: 1 });
  assert.deepEqual([...pages.keys()], [0, 2]);
  assert.deepEqual(missing, [1]);
});

test('fetchPageBytes 走 bytes() 并做 JPEG 校验', async () => {
  const jpeg = await fixtureBuffer('images/school.jpg');
  const http = { async bytes() { return jpeg; } };
  assert.equal((await fetchPageBytes(http, 'x')).length, jpeg.length);
});

test('loadMeta：直接 GET pdfindex1.jsp?fid=… 并解析', async () => {
  let seen = '';
  const http = {
    async text(url) {
      seen = url;
      return INDEX_HTML;
    },
  };
  const { meta } = await loadMeta(http, FID);
  assert.equal(seen, `${READER_ORIGIN}/pdfindex1.jsp?fid=${FID}`);
  assert.equal(pageCount(meta), 12);
});
