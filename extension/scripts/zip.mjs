/**
 * 把 dist/chrome、dist/firefox 打成可分发压缩包（零依赖，自写 ZIP 写入器）：
 *   /data/workspaces/lzu-plugin/release/lzu-fulltext-chrome-<version>.zip
 *   /data/workspaces/lzu-plugin/release/lzu-fulltext-firefox-<version>.zip
 *   /data/workspaces/lzu-plugin/release/lzu-fulltext-firefox-<version>.xpi   （同一份 ZIP 的副本）
 *
 * 用法：node scripts/zip.mjs [chrome|firefox]
 */
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const distRoot = path.join(root, 'dist');
// extension/ → LZU-Thesis-CLI/ → lzu-plugin/（工作区根）
const DEFAULT_RELEASE_DIR = path.resolve(root, '..', '..', 'release');

// ---------------------------------------------------------------- CRC32

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- ZIP 写入

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * @param {{name:string, data:Buffer, mtime?:Date}[]} files
 * @returns {Buffer}
 */
function buildZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const compressed = deflateRawSync(file.data, { level: 9 });
    const crc = crc32(file.data);
    const nameBuf = Buffer.from(file.name, 'utf8');
    const { time, date } = dosDateTime(file.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset

    localChunks.push(local, nameBuf, compressed);
    centralChunks.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

// ---------------------------------------------------------------- 校验

/** 读回 ZIP：解析中央目录，校验条目名集合与 manifest.json 内容。 */
function verifyZip(buf, expectedFiles) {
  const eocdIndex = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdIndex < 0) throw new Error('不是有效的 ZIP：找不到 EOCD');
  const count = buf.readUInt16LE(eocdIndex + 10);
  const centralSize = buf.readUInt32LE(eocdIndex + 12);
  const centralOffset = buf.readUInt32LE(eocdIndex + 16);

  const names = [];
  let cursor = centralOffset;
  const end = centralOffset + centralSize;
  while (cursor < end) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) throw new Error('中央目录条目签名错误');
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    names.push(name);
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  if (names.length !== count) throw new Error(`条目数不一致：EOCD ${count} vs 实际 ${names.length}`);
  const actual = [...names].sort();
  const expected = [...expectedFiles].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`条目集合不一致：\n实际 ${actual.join(', ')}\n期望 ${expected.join(', ')}`);
  }
  if (!names.includes('manifest.json')) throw new Error('包根缺少 manifest.json');

  // 解压 manifest.json，确认压缩流可回读
  const localOffset = (() => {
    let c = centralOffset;
    while (c < end) {
      const nameLen = buf.readUInt16LE(c + 28);
      const extraLen = buf.readUInt16LE(c + 30);
      const commentLen = buf.readUInt16LE(c + 32);
      const name = buf.subarray(c + 46, c + 46 + nameLen).toString('utf8');
      if (name === 'manifest.json') return buf.readUInt32LE(c + 42);
      c += 46 + nameLen + extraLen + commentLen;
    }
    return -1;
  })();
  if (localOffset < 0) throw new Error('找不到 manifest.json 的本地头');
  const lnameLen = buf.readUInt16LE(localOffset + 26);
  const lextraLen = buf.readUInt16LE(localOffset + 28);
  const compSize = buf.readUInt32LE(localOffset + 18);
  const dataStart = localOffset + 30 + lnameLen + lextraLen;
  const manifest = JSON.parse(inflateRawSync(buf.subarray(dataStart, dataStart + compSize)).toString('utf8'));
  if (!manifest.manifest_version || !manifest.version) throw new Error('manifest.json 内容异常');

  return { names, manifest };
}

// ---------------------------------------------------------------- 主流程

async function walk(dir, base = dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else out.push({ full, name: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

async function packTarget(targetName, { releaseDir = null } = {}) {
  const dir = path.join(distRoot, targetName);
  try {
    await stat(dir);
  } catch {
    throw new Error(`找不到 ${path.relative(root, dir)}，先运行 npm run build`);
  }

  const files = await walk(dir);
  const payload = [];
  for (const file of files) {
    const info = await stat(file.full);
    payload.push({ name: file.name, data: await readFile(file.full), mtime: info.mtime });
  }

  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const zip = buildZip(payload);
  const { names } = verifyZip(zip, payload.map((f) => f.name));

  const outDir = releaseDir || DEFAULT_RELEASE_DIR;
  await mkdir(outDir, { recursive: true });
  const zipPath = path.join(outDir, `lzu-fulltext-${targetName}-${manifest.version}.zip`);
  await writeFile(zipPath, zip);

  const outputs = [zipPath];
  if (targetName === 'firefox') {
    const xpiPath = path.join(outDir, `lzu-fulltext-firefox-${manifest.version}.xpi`);
    await copyFile(zipPath, xpiPath);
    outputs.push(xpiPath);
  }

  console.log(
    `✓ ${targetName} ${manifest.version}：${names.length} 个文件，${(zip.length / 1024).toFixed(0)} KB（未压缩 ${(
      payload.reduce((n, f) => n + f.data.length, 0) / 1024
    ).toFixed(0)} KB）`,
  );
  for (const out of outputs) console.log(`  → ${out}`);
  return outputs;
}

export { buildZip, verifyZip, packTarget };

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, 'zip.mjs');
if (!invokedDirectly) {
  // 被当成库 import 时（如 Firefox E2E 里现做 xpi）不要跑 CLI。
} else {
  await runCli();
}

async function runCli() {
const only = process.argv.slice(2).find((a) => !a.startsWith('-'));
const targets = only ? [only] : ['chrome', 'firefox'];
for (const target of targets) {
  if (!['chrome', 'firefox'].includes(target)) {
    console.error(`未知目标：${target}（可选：chrome、firefox）`);
    process.exit(2);
  }
}
const all = [];
for (const target of targets) all.push(...(await packTarget(target)));
console.log(`打包完成，共 ${all.length} 个文件。`);
}
