/** HTTP 层：重试策略、错误分类、字符集解码、POST 表单。 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHttp, HttpError, GoneError, AppError, decodeText,
} from '../../src/lib/http.js';

const enc = (s) => new TextEncoder().encode(s);
const res = (status, body = '', headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? enc(body) : body,
  url: 'http://x/',
});

test('text()：正常响应，headers 键统一小写', async () => {
  const http = createHttp(async () => res(200, 'hello', { 'Content-Type': 'text/plain; charset=utf-8' }));
  const out = await http.raw('http://x/a');
  assert.equal(out.status, 200);
  assert.equal(out.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(await http.text('http://x/a'), 'hello');
});

test('网络异常重试到成功（默认 3 次）', async () => {
  let calls = 0;
  const http = createHttp(async () => {
    calls++;
    if (calls < 3) throw new Error('ECONNRESET');
    return res(200, 'ok');
  }, { retries: 3, delay: 0.001 });
  assert.equal(await http.text('http://x/a'), 'ok');
  assert.equal(calls, 3);
});

test('重试用尽抛 HttpError（带 cause）', async () => {
  let calls = 0;
  const http = createHttp(async () => {
    calls++;
    throw new Error('timeout');
  }, { retries: 2, delay: 0.001 });
  await assert.rejects(http.text('http://x/a'), (err) => {
    assert.ok(err instanceof HttpError);
    assert.match(err.message, /网络请求失败/);
    assert.ok(err.cause);
    return true;
  });
  assert.equal(calls, 2);
});

test('AbortError 不重试，直接抛给上层（取消语义）', async () => {
  let calls = 0;
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const http = createHttp(async () => {
    calls++;
    throw abort;
  });
  await assert.rejects(http.text('http://x/a'), (err) => err.name === 'AbortError');
  assert.equal(calls, 1);
});

test('5xx + “文件不存在”正文 → GoneError；4xx → 普通 HttpError', async () => {
  const http = createHttp(async (spec) => {
    if (spec.url.endsWith('/gone')) return res(500, 'java.io.FileNotFoundException: /store/x.pdf');
    return res(404, '<html>Not Found</html>');
  });
  await assert.rejects(http.text('http://x/gone'), (err) => {
    assert.ok(err instanceof GoneError);
    assert.equal(err.status, 500);
    return true;
  });
  await assert.rejects(http.text('http://x/other'), (err) => {
    assert.ok(err instanceof HttpError);
    assert.ok(!(err instanceof GoneError));
    assert.equal(err.status, 404);
    return true;
  });
});

test('302 视为成功（让调用方自己读 Location）', async () => {
  const http = createHttp(async () => res(302, '', { location: 'http://202.201.7.29/pdfindex1.jsp?fid=abc' }));
  const out = await http.raw('http://x/a');
  assert.equal(out.status, 302);
  assert.equal(out.headers.location, 'http://202.201.7.29/pdfindex1.jsp?fid=abc');
});

test('postForm：application/x-www-form-urlencoded 编码', async () => {
  let seen = null;
  const http = createHttp(async (spec) => {
    seen = spec;
    return res(200, 'ok');
  });
  await http.postForm('http://x/docinfo.action', { id1: 'a b', id2: 'c&d=1' });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const params = new URLSearchParams(seen.body);
  assert.equal(params.get('id1'), 'a b');
  assert.equal(params.get('id2'), 'c&d=1');
});

test('json()：坏 JSON 抛 AppError(BAD_JSON)', async () => {
  const http = createHttp(async () => res(200, '<html>不是 JSON</html>'));
  await assert.rejects(http.json('http://x/a'), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'BAD_JSON');
    return true;
  });
});

test('bytes()：原样返回二进制', async () => {
  const body = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const http = createHttp(async () => res(200, body, { 'content-type': 'image/jpeg' }));
  assert.deepEqual(Array.from(await http.bytes('http://x/p.jpg')), Array.from(body));
});

test('decodeText：UTF-8 默认 / gb2312 按 GBK 字节解码 / meta charset 兜底', () => {
  assert.equal(decodeText(enc('中文'), 'text/html; charset=utf-8'), '中文');
  assert.equal(decodeText(enc('中文'), ''), '中文');

  // '中文' 的 GB18030 字节是 D6 D0 CE C4
  const gbk = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);
  let supported = true;
  try {
    new TextDecoder('gb18030');
  } catch {
    supported = false;
  }
  if (supported) {
    assert.equal(decodeText(gbk, 'text/html; charset=gb2312'), '中文');
    const html = Uint8Array.from([...enc('<meta charset="gbk">'), ...gbk]);
    assert.ok(decodeText(html, '').includes('中文'));
  }
});

test('AppError 默认 code', () => {
  const err = new AppError('x');
  assert.equal(err.name, 'AppError');
  assert.equal(err.code, 'APP_ERROR');
});
