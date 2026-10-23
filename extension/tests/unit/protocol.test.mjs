/**
 * 令牌 / 编解码：用真实抓包得到的令牌（tests/fixtures/portal/token.json）做金标准，
 * 再验证 encodeToken ↔ decodeToken 往返、quote/unquote 与命令行 Python 实现一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeToken, encodeToken, quote, unquote, quoteToken, extractToken,
  fidFromUrl, originOf, bytesToBase64, base64ToBytes,
  READER_ORIGIN, PORTAL_ORIGIN, FID_RE, GONE_RE,
} from '../../src/lib/protocol.js';
import { fixtureJson } from '../fixtures/load.mjs';

const captured = await fixtureJson('portal/token.json');

test('真实令牌：解码结果与命令行 drm.decode_token 一致', () => {
  const info = decodeToken(captured.token);
  assert.equal(info.prefix, 'KsAbQ');
  assert.equal(info.path, 'D:\\DRM\\read\\WebRoot\\store/xtuwd8qhjlywd.pdf');
  assert.equal(info.storeName, 'xtuwd8qhjlywd.pdf');
  assert.equal(info.startpage, 1);
  assert.equal(info.endpage, 2000);
  assert.equal(info.down, 50);
  assert.equal(info.watermark, '');
  assert.equal(info.filename, '262010_220220931930_示例作者_free.pdf');
  assert.equal(info.infoname, '补播白刺花和施厩肥对两种暖季型草地土壤理化性质和生产力的影响');
});

test('真实令牌：302 Location 里能原样取出并解码', () => {
  const fromUrl = extractToken(captured.location);
  assert.equal(fromUrl, captured.token);
  assert.equal(decodeToken(fromUrl).storeName, 'xtuwd8qhjlywd.pdf');
});

test('encodeToken ↔ decodeToken 往返（含中文与特殊字符）', () => {
  const spec = {
    prefix: 'Ab+/9',
    path: 'D:\\DRM\\read\\WebRoot\\store/中文 文件#1.pdf',
    startpage: 3,
    endpage: 88,
    down: 50,
    watermark: '',
    filename: '262010_测试 (final).pdf',
    infoname: '补播白刺花 & 施厩肥的响应特征',
  };
  const token = encodeToken(spec);
  assert.ok(token.startsWith('Ab+/9'));
  const info = decodeToken(token);
  assert.equal(info.path, spec.path);
  assert.equal(info.startpage, 3);
  assert.equal(info.endpage, 88);
  assert.equal(info.down, 50);
  assert.equal(info.watermark, '');
  assert.equal(info.filename, spec.filename);
  assert.equal(info.infoname, spec.infoname);
});

test('编码结果与 Python quote(safe="") 的字节一致（黄金向量）', () => {
  // 这些向量来自 lzu_fulltext.drm.decode_token/encode_token 的实现行为：
  // 路径里的 / \ : 空格 中文 都按 UTF-8 %XX 转义，! ' ( ) * 也要转义。
  assert.equal(quote('D:\\DRM\\read\\WebRoot\\store/a.pdf', ''),
    'D%3A%5CDRM%5Cread%5CWebRoot%5Cstore%2Fa.pdf');
  assert.equal(quote("!*'()", ''), '%21%2A%27%28%29');
  assert.equal(quote('a b+c', ''), 'a%20b%2Bc');
  assert.equal(unquote('D%3A%5CDRM%5Cread%5CWebRoot%5Cstore%2Fa.pdf'),
    'D:\\DRM\\read\\WebRoot\\store/a.pdf');
  assert.equal(unquote('%E4%B8%AD%E6%96%87'), '中文');
});

test('真实令牌的 payload 前缀校验（与抓包解码字符串逐字对照）', () => {
  const body = captured.token.slice(5);
  const payload = unquote(Buffer.from(body.replace(/%3[dD]/g, '='), 'base64').toString('utf8'));
  assert.ok(
    payload.startsWith('D:\\DRM\\read\\WebRoot\\store/xtuwd8qhjlywd.pdf'),
    `payload 头不对：${payload.slice(0, 60)}`,
  );
  assert.ok(payload.includes('&startpage=1&endpage=2000&down=50&watermark=&filename='));
});

test('quoteToken 二次编码：+ / = 都变成 %XX', () => {
  const token = encodeToken({ prefix: 'Xy+z/', path: 'a.pdf', filename: 'b.pdf' });
  const quoted = quoteToken(token);
  assert.ok(!quoted.includes('+'), 'quote 之后不应残留 +');
  assert.ok(!quoted.includes('/'), 'quote 之后不应残留 /');
  assert.match(quoted, /^[A-Za-z0-9%._~-]+$/);
});

test('extractToken：链接 / 纯令牌 / 空输入', () => {
  assert.equal(extractToken(captured.linkUrl), '', 'onlinePDF 链接本身不含令牌');
  assert.equal(extractToken(captured.location), captured.token);
  assert.equal(extractToken(captured.token), captured.token);
  assert.equal(extractToken('  '), '');
  assert.equal(extractToken('https://example.com/foo'), '');
});

test('fidFromUrl：大小写归一化', () => {
  const fid = '0F86D523CF98C2E7D4A8416C4D6BD7EE';
  assert.equal(fidFromUrl(`http://202.201.7.29/pdfindex1.jsp?fid=${fid}`), fid.toLowerCase());
  assert.equal(fidFromUrl(`http://202.201.7.29/personaliiifServlet?path=x&fid=${fid}`), fid.toLowerCase());
  assert.equal(fidFromUrl('http://202.201.7.29/jumpServlet?page=1'), null);
  assert.ok(FID_RE.test(`fid=${fid.toLowerCase()}`));
});

test('originOf：裸 IP / 带路径 URL / 空值', () => {
  assert.equal(originOf('202.201.7.29'), READER_ORIGIN);
  assert.equal(originOf('http://202.201.7.17/simpsearch.action'), PORTAL_ORIGIN);
  assert.equal(originOf('http://202.201.7.29/'), READER_ORIGIN);
});

test('GONE_RE 命中 CLI 里定义的三种“文件不存在”文案', () => {
  assert.ok(GONE_RE.test('java.io.FileNotFoundException: x'));
  assert.ok(GONE_RE.test('系统找不到指定的文件。'));
  assert.ok(GONE_RE.test('NoSuchFile'));
  assert.ok(!GONE_RE.test('一切正常'));
});

test('base64 辅助函数与 Node Buffer 互通', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252]);
  const b64 = bytesToBase64(bytes);
  assert.deepEqual(Array.from(base64ToBytes(b64)), Array.from(bytes));
  assert.equal(b64, Buffer.from(bytes).toString('base64'));
});

test('decodeToken 对垃圾输入抛错而不是静默返回', () => {
  assert.throws(() => decodeToken('abc'), /令牌太短/);
});
