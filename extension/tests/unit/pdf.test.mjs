/**
 * PDF 写出器：结构用 pdfjs-dist（独立解析器）验证，图片字节用逐字节比对验证
 * “原样嵌入、不重编码”。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import { jpegInfo, buildPdf, pdfString, safeName } from '../../src/lib/pdf.js';
import { fixtureBuffer } from '../fixtures/load.mjs';

const school = await fixtureBuffer('images/school.jpg');
const info = jpegInfo(school);

/** pdfjs 需要拷贝一份独立 ArrayBuffer（它会转移所有权）。 */
async function loadPdf(bytes) {
  const data = new Uint8Array(bytes); // copy
  const doc = await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;
  return doc;
}

test('jpegInfo：真实 1024×750 三通道 JPEG', () => {
  assert.equal(info.width, 1024);
  assert.equal(info.height, 750);
  assert.equal(info.components, 3);
  assert.equal(info.adobeTransform, null);
});

test('jpegInfo：非 JPEG 抛错', () => {
  assert.throws(() => jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), /不是 JPEG/);
  assert.throws(() => jpegInfo(new Uint8Array(0)), /不是 JPEG/);
});

test('pdfString：ASCII 用 ()、中文用 UTF-16BE 十六进制串、括号转义', () => {
  assert.equal(pdfString('abc'), '(abc)');
  assert.equal(pdfString('a(b)c'), '(a\\(b\\)c)');
  assert.equal(pdfString('a\\b'), '(a\\\\b)');
  const cn = pdfString('牦牛');
  assert.match(cn, /^<FEFF7266725B>$/i);
});

test('safeName：逐字复刻 pdfbuild.safe_name', () => {
  assert.equal(safeName('a/b\\c:d*e?f"g<h>i|j.pdf'), 'a_b_c_d_e_f_g_h_i_j.pdf');
  assert.equal(safeName('  .hidden. . '), 'hidden', '首尾的空格和点被去掉');
  assert.equal(safeName(''), 'document');
  assert.equal(safeName('x'.repeat(200)).length, 80);
  assert.equal(
    safeName('262010_220220931930_示例作者_free.pdf'),
    '262010_220220931930_示例作者_free.pdf',
    '中文文件名不应被改动',
  );
});

test('buildPdf：3 页 PDF 能被 pdfjs 解析，页数 / 页面尺寸 / 元数据正确', async () => {
  const pages = [0, 1, 2].map(() => ({ jpeg: school, info }));
  const bytes = buildPdf(pages, { title: '补播白刺花和施厩肥对两种暖季型草地土壤理化性质和生产力的影响', resolution: 150 });

  assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), '%PDF-1.4');
  assert.ok(new TextDecoder().decode(bytes.subarray(-8)).includes('%%EOF'));

  const doc = await loadPdf(bytes);
  assert.equal(doc.numPages, 3);

  // 1024/150*72 = 491.52pt，750/150*72 = 360pt
  for (let i = 1; i <= 3; i++) {
    const page = await doc.getPage(i);
    const view = page.getViewport({ scale: 1 });
    assert.ok(Math.abs(view.width - 491.52) < 0.01, `第 ${i} 页宽 ${view.width}`);
    assert.ok(Math.abs(view.height - 360) < 0.01, `第 ${i} 页高 ${view.height}`);
    const ops = await page.getOperatorList();
    assert.ok(
      ops.fnArray.includes(pdfjs.OPS.paintImageXObject),
      `第 ${i} 页应该画一张图片`,
    );
  }

  const meta = await doc.getMetadata();
  assert.equal(meta.info.Title, '补播白刺花和施厩肥对两种暖季型草地土壤理化性质和生产力的影响');
  await doc.destroy();
});

test('buildPdf：JPEG 字节原样嵌入（不重编码），页数 = 出现次数', async () => {
  const pages = [0, 1].map(() => ({ jpeg: school, info }));
  const bytes = buildPdf(pages, { resolution: 150 });
  const needleHead = Buffer.from(school.subarray(0, 64));
  const needleTail = Buffer.from(school.subarray(school.length - 2));
  const buf = Buffer.from(bytes);
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = buf.indexOf(needleHead, idx);
    if (idx < 0) break;
    count++;
    idx += needleHead.length;
  }
  assert.equal(count, 2, '两张图应各出现一次原始 JPEG 头');
  assert.ok(buf.indexOf(needleTail) >= 0, 'JPEG 尾部（FFD9）应在 PDF 里');
  assert.ok(buf.includes(Buffer.from('/Filter /DCTDecode')), '应使用 DCTDecode 直接嵌入');
});

test('buildPdf：分辨率为 72 时页面尺寸 = 像素', async () => {
  const bytes = buildPdf([{ jpeg: school, info }], { resolution: 72 });
  const doc = await loadPdf(bytes);
  const view = (await doc.getPage(1)).getViewport({ scale: 1 });
  assert.equal(view.width, 1024);
  assert.equal(view.height, 750);
  await doc.destroy();
});

test('buildPdf：空页数组抛错', () => {
  assert.throws(() => buildPdf([], {}), /没有任何页面/);
});
