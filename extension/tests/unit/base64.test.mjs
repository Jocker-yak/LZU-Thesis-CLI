/**
 * base64 工具的单测。
 *
 * 这里锁住一个 Firefox 专属坑：原先用 `String.fromCharCode.apply(null, typedArray)`
 * 做 base64，Chrome 里没事，但在 Firefox 的 content script 沙箱里会抛
 * `Permission denied to access property "constructor"`，整条桥接通道直接废掉。
 * 所以实现必须逐字节查表（见 src/lib/ext.js 的注释），并且源码里不能再出现该写法。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bytesToBase64, base64ToBytes } from '../../src/lib/ext.js';

const readSource = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('bytesToBase64 与 Node Buffer 的结果完全一致（覆盖 3 的余数）', () => {
  for (let n = 0; n <= 40; n += 1) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), `长度 ${n}`);
  }
});

test('bytesToBase64 处理大缓冲（超过旧实现的分块阈值 0x8000）', () => {
  const bytes = Uint8Array.from({ length: 0x8000 * 2 + 7 }, (_, i) => (i * 131 + 7) % 256);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('base64 往返不丢字节（含中文/空/随机）', () => {
  const samples = [
    new Uint8Array(0),
    new TextEncoder().encode('补播白刺花和施厩肥对两种暖季型草地土壤理化性质和生产力的影响'),
    Uint8Array.from({ length: 100000 }, (_, i) => (i * 17 + 3) % 256),
  ];
  for (const sample of samples) {
    const round = base64ToBytes(bytesToBase64(sample));
    assert.deepEqual(Array.from(round), Array.from(sample));
  }
});

test('源码里不再出现 String.fromCharCode.apply（Firefox content script 会抛权限错误）', () => {
  for (const rel of ['../../src/lib/ext.js', '../../src/content/bridge.js', '../../src/lib/protocol.js']) {
    assert.ok(!readSource(rel).includes('fromCharCode.apply'), `${rel} 里还有 fromCharCode.apply`);
  }
});
