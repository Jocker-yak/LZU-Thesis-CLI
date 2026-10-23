/**
 * 打包扩展：esbuild 打 IIFE bundle，复制静态资源与 manifest，输出
 *   dist/chrome   —— Chrome MV3（service_worker + offscreen 文档）
 *   dist/firefox   —— Firefox MV3（background.scripts）
 *
 * 用法：
 *   node scripts/build.mjs            # 两个浏览器都构建
 *   node scripts/build.mjs chrome     # 只构建 Chrome
 *   node scripts/build.mjs --test-key # 预留：给 E2E 固定扩展 ID 用（当前不需要）
 */
import { build } from 'esbuild';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeIcons } from './make-icons.mjs';

const root = path.resolve(import.meta.dirname, '..');
const distRoot = path.join(root, 'dist');

const ENTRIES = [
  { src: 'src/background/main.js', out: 'background.js' },
  { src: 'src/content/reader.js', out: 'content-reader.js' },
  { src: 'src/content/portal.js', out: 'content-portal.js' },
  { src: 'src/ui/popup.js', out: 'popup.js' },
  { src: 'src/ui/app.js', out: 'app.js' },
];

const CHROME_ENTRIES = [{ src: 'src/background/offscreen.js', out: 'offscreen.js' }];

const STATIC_FILES = ['src/ui/popup.html', 'src/ui/app.html', 'src/ui/ui.css'];
const CHROME_STATIC_FILES = ['src/background/offscreen.html'];

const TARGETS = [
  {
    name: 'chrome',
    manifest: 'manifest.chrome.json',
    esTarget: ['chrome116'],
    entries: [...ENTRIES, ...CHROME_ENTRIES],
    staticFiles: [...STATIC_FILES, ...CHROME_STATIC_FILES],
  },
  {
    name: 'firefox',
    manifest: 'manifest.firefox.json',
    esTarget: ['firefox115'],
    entries: ENTRIES,
    staticFiles: STATIC_FILES,
  },
];

/** 把静态文件复制到某个 dist 子目录（保持原文件名，扁平放置）。 */
async function copyStatic(file, outDir) {
  const body = await readFile(path.join(root, file));
  await writeFile(path.join(outDir, path.basename(file)), body);
}

async function bundleEntry(entry, outDir, esTarget) {
  const outfile = path.join(outDir, entry.out);
  await build({
    entryPoints: [path.join(root, entry.src)],
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: esTarget,
    legalComments: 'none',
    logLevel: 'warning',
  });
  return outfile;
}

/** 构建后自检：manifest 里引用的每个文件都必须存在。 */
async function validateDist(outDir, manifest) {
  const refs = new Set();
  const add = (p) => {
    if (typeof p === 'string' && p) refs.add(p);
  };

  add(manifest.background?.service_worker);
  for (const s of manifest.background?.scripts || []) add(s);
  for (const cs of manifest.content_scripts || []) for (const js of cs.js || []) add(js);
  add(manifest.action?.default_popup);
  add(manifest.options_ui?.page);
  add(manifest.options_page);
  for (const p of Object.values(manifest.icons || {})) add(p);
  for (const p of Object.values(manifest.action?.default_icon || {})) add(p);

  const missing = [];
  for (const ref of refs) {
    try {
      await access(path.join(outDir, ref));
    } catch {
      missing.push(ref);
    }
  }
  if (missing.length) {
    throw new Error(`构建产物缺少 manifest 引用的文件：${missing.join(', ')}`);
  }
  return [...refs];
}

async function buildTarget(target) {
  const outDir = path.join(distRoot, target.name);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const built = [];
  for (const entry of target.entries) built.push(await bundleEntry(entry, outDir, target.esTarget));
  for (const file of target.staticFiles) await copyStatic(file, outDir);

  const iconsDir = path.join(outDir, 'icons');
  const icons = await writeIcons(iconsDir);

  const manifestPath = path.join(root, target.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const manifestOut = path.join(outDir, 'manifest.json');
  await writeFile(manifestOut, `${JSON.stringify(manifest, null, 2)}\n`);

  const refs = await validateDist(outDir, manifest);

  const { size } = await import('node:fs/promises').then((fs) => fs.stat(manifestOut));
  console.log(
    `✓ ${target.name}: ${built.length} 个 bundle + ${target.staticFiles.length} 个静态文件 + ${icons.length} 个图标 → ${path.relative(root, outDir)}（manifest ${size}B，自检 ${refs.length} 个引用）`,
  );
  return outDir;
}

const args = process.argv.slice(2);
if (args.includes('--test-key')) {
  // E2E 直接从 service worker URL 取扩展 ID，无需在 manifest 里注入固定公钥；
  // 保留这个开关只是为了让 `npm run build:test` 与文档里的命令不报错。
  console.warn('提示：--test-key 目前不需要（E2E 动态读取扩展 ID）。');
}

const only = args.find((a) => !a.startsWith('-'));
const selected = only ? TARGETS.filter((t) => t.name === only) : TARGETS;
if (only && !selected.length) {
  console.error(`未知的目标：${only}（可选：chrome、firefox）`);
  process.exit(2);
}

for (const target of selected) await buildTarget(target);
console.log('构建完成。');
