/**
 * 门户解析：全部用真实抓包 HTML（tests/fixtures/portal/*.html），
 * 确保解析器对门户当前的真实标记仍然有效。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeEntities, stripTags, parseRows, parseTotal, onlineLinks,
  absoluteUrl, objidToText, search, docinfoHtml, recordLinks,
} from '../../src/lib/portal.js';
import { PORTAL_ORIGIN, SEARCH_URL } from '../../src/lib/protocol.js';
import { fixtureText, fixtureJson } from '../fixtures/load.mjs';

const resultlist = await fixtureText('portal/resultlist.html');
const docinfoWithLink = await fixtureText('portal/docinfo-link.html');
const docinfoEmpty = await fixtureText('portal/docinfo-empty.html');
const captured = await fixtureJson('portal/token.json');

test('真实结果页：解析出 20 行，字段与抓包一致', () => {
  const rows = parseRows(resultlist);
  assert.equal(rows.length, 20);
  // 抓包那条（docinfo 有全文的）应在这一页里
  const hit = rows.find((r) => r.id1 === captured.row.id1 && r.id2 === captured.row.id2);
  assert.ok(hit, '结果页里应能找到抓包记录');
  assert.equal(hit.title, captured.row.title);
  assert.match(rows[0].id1, /^[0-9a-f]{32}$/);
});

test('真实结果页：总数 77（标记里夹着 <span> 标签）', () => {
  assert.equal(parseTotal(resultlist), 77);
});

test('真实结果页：所有行 id1 都是 32 位十六进制、id2 非空、标题非空', () => {
  for (const row of parseRows(resultlist)) {
    assert.match(row.id1, /^[0-9a-f]{32}$/);
    assert.ok(row.id2.length > 0);
    assert.ok(row.title.length > 0);
    assert.ok(!row.title.includes('<'), '标题里不应残留标签');
  }
});

test('docinfo 页：有全文的取到 1 个 onlinePDF 链接，没有的取到 0 个', () => {
  const links = onlineLinks(docinfoWithLink);
  assert.equal(links.length, 1);
  assert.ok(links[0].startsWith('onlinePDF?'));
  assert.equal(onlineLinks(docinfoEmpty).length, 0);
});

test('absoluteUrl 把相对链接补成门户绝对地址', () => {
  assert.equal(
    absoluteUrl(captured.linkHref),
    `${PORTAL_ORIGIN}/${captured.linkHref}`,
  );
  assert.equal(absoluteUrl('http://x/y'), 'http://x/y');
  assert.equal(absoluteUrl('//202.201.7.17/onlinePDF?a=1'), 'http://202.201.7.17/onlinePDF?a=1');
});

test('objidToText 还原 ASCII 码（与 CLI 的 objid_to_text 一致）', () => {
  // '56_55_55_57_56_49' → chr(56)chr(55)chr(55)chr(57)chr(56)chr(49) = '877981'
  assert.equal(objidToText('56_55_55_57_56_49'), '877981');
  assert.equal(objidToText('120_121_122'), 'xyz');
});

test('decodeEntities / stripTags：数字实体、命名实体、空白折叠', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#24635; &#x4E2D;'), 'a & b <c> 总 中');
  assert.equal(stripTags('<b>草地</b>\n  土壤 &amp; 生产力'), '草地 土壤 & 生产力');
});

test('parseTotal 拿不到时返回 null（而不是 0）', () => {
  assert.equal(parseTotal('<html>没有总数</html>'), null);
});

test('search：暖场 → POST → 结果页；GET zjresult_two 404 时切到 resultlist.jsp', async () => {
  const calls = [];
  const http = {
    async text(url) {
      calls.push(url);
      if (url === SEARCH_URL) return '<html>检索页</html>';
      if (url.endsWith('/zjresult_two.action')) throw new Error('HTTP 404');
      if (url.endsWith('/resultlist.jsp')) return resultlist;
      return '';
    },
    async postForm(url, fields) {
      calls.push(`${url} (POST ${JSON.stringify(fields)})`);
      return '<html>已提交</html>';
    },
  };
  const out = await search(http, '侯扶江', { onStep: () => {} });
  assert.equal(out.rows.length, 20);
  assert.equal(out.total, 77);
  assert.equal(out.source, '/resultlist.jsp');
  assert.equal(calls[0], SEARCH_URL, '第一跳应是暖场检索页');
  assert.ok(calls.some((c) => c.includes('zjresult_two.action (POST')), '应 POST 检索表单');
});

test('recordLinks：docinfo → onlinePDF 链接 → 绝对地址', async () => {
  const http = {
    async postForm(url, fields) {
      assert.ok(url.endsWith('/docinfo.action'));
      assert.equal(fields.id1, captured.row.id1);
      assert.equal(fields.id2, captured.row.id2);
      return docinfoWithLink;
    },
  };
  const out = await recordLinks(http, { id1: captured.row.id1, id2: captured.row.id2 });
  assert.equal(out.links.length, 1);
  assert.equal(out.absLinks[0], `${PORTAL_ORIGIN}/${out.links[0]}`);
});

test('docinfoHtml：POST 到 docinfo.action', async () => {
  let seen = null;
  const http = {
    async postForm(url, fields) {
      seen = { url, fields };
      return docinfoEmpty;
    },
  };
  const html = await docinfoHtml(http, 'a'.repeat(32), 'x%253D');
  assert.ok(seen.url.endsWith('/docinfo.action'));
  assert.equal(html, docinfoEmpty);
});
