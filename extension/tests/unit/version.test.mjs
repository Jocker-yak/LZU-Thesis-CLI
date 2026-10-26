/**
 * 发布物一致性：dist ↔ release/<version>/*.zip ↔ SHA256SUMS.txt 必须逐字节对齐。
 *
 * 这些包是 v1.0.1 tag 里 release/1.0.1/ 的内容，也是 GitHub Release 附件；
 * 任何一步「改了代码但忘了重新打包」都会在这里暴露。
 *
 * 在 E2E 容器里通过 LZU_RELEASE_DIR=/release 指定挂载点。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { readZipEntries } from '../../scripts/zip.mjs';

const EXT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(EXT_ROOT, '..');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else out.push({ full, name: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

const chromeManifest = existsSync(path.join(EXT_ROOT, 'dist/chrome/manifest.json'))
  ? readJson(path.join(EXT_ROOT, 'dist/chrome/manifest.json'))
  : { version: '1.0.1' };
const firefoxManifest = existsSync(path.join(EXT_ROOT, 'dist/firefox/manifest.json'))
  ? readJson(path.join(EXT_ROOT, 'dist/firefox/manifest.json'))
  : { version: '1.0.1' };

const VERSION = chromeManifest.version;
const RELEASE_DIR = process.env.LZU_RELEASE_DIR || path.join(REPO_ROOT, 'release', VERSION);
const hasRelease = existsSync(path.join(RELEASE_DIR, `lzu-fulltext-chrome-${VERSION}.zip`));
const skip = hasRelease ? false : `缺少 ${path.relative(REPO_ROOT, RELEASE_DIR)}/，先运行 npm run build && npm run package`;

test('dist 与 package.json / release 版本一致', () => {
  const pkg = readJson(path.join(EXT_ROOT, 'package.json'));
  assert.equal(chromeManifest.version, pkg.version);
  assert.equal(firefoxManifest.version, pkg.version);
  assert.equal(VERSION, pkg.version);
});

test('dist 清单与 release 包名版本一致', { skip }, () => {
  const names = readdirSync(RELEASE_DIR);
  assert.ok(names.includes(`lzu-fulltext-chrome-${VERSION}.zip`), names.join(', '));
  assert.ok(names.includes(`lzu-fulltext-firefox-${VERSION}.zip`), names.join(', '));
  assert.ok(names.includes(`lzu-fulltext-firefox-${VERSION}.xpi`), names.join(', '));
  assert.ok(names.includes('SHA256SUMS.txt'), '缺少 SHA256SUMS.txt');
});

test('Chrome 包内容 = dist/chrome 逐字节', { skip }, () => {
  const zip = readFileSync(path.join(RELEASE_DIR, `lzu-fulltext-chrome-${VERSION}.zip`));
  const entries = readZipEntries(zip);
  const files = walkFiles(path.join(EXT_ROOT, 'dist/chrome'));
  assert.deepEqual([...entries.keys()].sort(), files.map((f) => f.name).sort());
  for (const file of files) {
    assert.ok(entries.get(file.name).equals(readFileSync(file.full)), `${file.name} 与 dist 不一致`);
  }
});

test('Firefox 包内容 = dist/firefox 逐字节，且 .zip 与 .xpi 完全相同', { skip }, () => {
  const zipPath = path.join(RELEASE_DIR, `lzu-fulltext-firefox-${VERSION}.zip`);
  const xpiPath = path.join(RELEASE_DIR, `lzu-fulltext-firefox-${VERSION}.xpi`);
  const zip = readFileSync(zipPath);
  assert.ok(zip.equals(readFileSync(xpiPath)), '.xpi 与 .zip 字节不同');
  const entries = readZipEntries(zip);
  const files = walkFiles(path.join(EXT_ROOT, 'dist/firefox'));
  assert.deepEqual([...entries.keys()].sort(), files.map((f) => f.name).sort());
  for (const file of files) {
    assert.ok(entries.get(file.name).equals(readFileSync(file.full)), `${file.name} 与 dist 不一致`);
  }
});

test('SHA256SUMS.txt 覆盖全部安装包且哈希正确', { skip }, () => {
  const lines = readFileSync(path.join(RELEASE_DIR, 'SHA256SUMS.txt'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      assert.ok(m, `格式不对：${line}`);
      return { hash: m[1], name: m[2] };
    });
  const expected = [
    `lzu-fulltext-chrome-${VERSION}.zip`,
    `lzu-fulltext-firefox-${VERSION}.zip`,
    `lzu-fulltext-firefox-${VERSION}.xpi`,
  ];
  assert.deepEqual(lines.map((l) => l.name).sort(), expected.sort());
  for (const line of lines) {
    const actual = sha256(readFileSync(path.join(RELEASE_DIR, line.name)));
    assert.equal(actual, line.hash, `${line.name} 哈希不符`);
  }
});

test('release/README.md 存在且提到当前版本', { skip }, () => {
  const p = path.join(REPO_ROOT, 'release', 'README.md');
  assert.ok(existsSync(p), '缺少 release/README.md');
  assert.ok(readFileSync(p, 'utf8').includes(VERSION), 'README 未提到当前版本');
});
