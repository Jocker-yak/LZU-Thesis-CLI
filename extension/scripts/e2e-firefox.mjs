/**
 * 跑 Firefox E2E。
 *
 * Playwright 不支持给 Firefox 装扩展，所以这里走 Firefox 自带的 Marionette 协议：
 * 本地把 dist/firefox 打成 XPI →（远程时同步到 nucbox）→ 在装了 Firefox 的机器上
 * 临时安装未签名扩展 → 用 mock 门户/阅读器 + network.dns.localDomains 做端到端验证。
 *
 *   npm run test:e2e:firefox                       # 本机有 Firefox 就本地跑，否则走远程 Docker
 *   npm run test:e2e:firefox -- --mode=docker
 *   npm run test:e2e:firefox -- --mode=local
 *
 * 远程参数同样支持环境变量覆盖：
 *   LZU_E2E_SSH_CONFIG（默认 /data/.ssh/config）、LZU_E2E_SSH_HOST（默认 nucbox）、
 *   LZU_E2E_REMOTE_DIR（默认 /home/oceanias/dsh/lzu-ext-firefox）、
 *   LZU_E2E_IMAGE（默认 mcr.microsoft.com/playwright:v1.64.1-noble）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { packTarget } from './zip.mjs';

const root = path.resolve(import.meta.dirname, '..'); // extension/
const repoRoot = path.resolve(root, '..'); // 仓库根（release/ 在其下）

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const mode = opt('mode', process.env.LZU_E2E_MODE || 'auto');
const SSH_CONFIG = process.env.LZU_E2E_SSH_CONFIG || '/data/.ssh/config';
const SSH_HOST = process.env.LZU_E2E_SSH_HOST || 'nucbox';
const REMOTE_DIR = process.env.LZU_E2E_REMOTE_DIR || '/home/oceanias/dsh/lzu-ext-firefox';
const IMAGE = process.env.LZU_E2E_IMAGE || 'mcr.microsoft.com/playwright:v1.64.1-noble';
const OUT_DIR = path.join(root, 'tests', 'e2e', 'out');

function run(cmd, options = {}) {
  const res = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: root, ...options });
  if (res.status !== 0) throw new Error(`命令失败（exit ${res.status}）：${cmd}`);
}

function capture(cmd) {
  const res = spawnSync(cmd, {
    shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: root,
  });
  return { ok: res.status === 0, out: `${res.stdout || ''}${res.stderr || ''}`.trim() };
}

function sshReady() {
  if (!existsSync(SSH_CONFIG)) return false;
  const res = capture(`ssh -F ${SSH_CONFIG} -o BatchMode=yes -o ConnectTimeout=8 ${SSH_HOST} 'echo READY'`);
  return res.ok && res.out.includes('READY');
}

function findLocalFirefox() {
  if (process.env.LZU_FIREFOX_BIN) return process.env.LZU_FIREFOX_BIN;
  for (const name of ['firefox', 'firefox-esr']) {
    const found = capture(`command -v ${name}`);
    if (found.ok && found.out) return found.out.split('\n')[0];
  }
  return '';
}

async function buildArtifacts() {
  console.log('构建扩展…');
  run('node scripts/build.mjs');
  // 优先用仓库内已发布的 XPI：E2E 验证的就是用户拿到的那个包。
  const version = JSON.parse(readFileSync(path.join(root, 'dist/firefox/manifest.json'), 'utf8')).version;
  const shipped = path.join(repoRoot, 'release', version, `lzu-fulltext-firefox-${version}.xpi`);
  if (existsSync(shipped)) {
    console.log(`XPI（发布包）：${shipped}`);
    return { xpi: shipped, version };
  }
  console.log('仓库内没有发布包，现场打 XPI…');
  const outputs = await packTarget('firefox', { releaseDir: OUT_DIR });
  const xpi = outputs.find((p) => p.endsWith('.xpi'));
  if (!xpi) throw new Error('没有生成 XPI');
  console.log(`XPI：${xpi}`);
  return { xpi, version };
}

function summarize() {
  const reportPath = path.join(OUT_DIR, 'firefox', 'report.json');
  if (!existsSync(reportPath)) return;
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const downloads = report.downloads || [];
  console.log(`\nFirefox E2E 报告：${report.ok ? '通过' : '未通过'}`);
  console.log(`  检索：${report.search ? `${report.search.rows} 行` : '—'}`);
  for (const d of downloads) console.log(`  下载：${d.file}（${d.bytes} 字节，${d.pages} 页）`);
  console.log(`  产物：${path.join(OUT_DIR, 'firefox')}`);
}

async function runLocal(xpi) {
  const firefox = findLocalFirefox();
  if (!firefox) throw new Error('本机没有 Firefox；用 --mode=docker 在容器里跑。');
  console.log(`本地 Firefox：${firefox}`);
  run(`LZU_FIREFOX_BIN='${firefox}' LZU_FIREFOX_XPI='${xpi}' node tests/e2e/firefox.mjs`);
}

async function runDocker(xpi, version) {
  if (!sshReady()) {
    throw new Error(`连不上 ${SSH_HOST}（ssh -F ${SSH_CONFIG}）。确认远程主机或改用本机 Firefox。`);
  }
  const image = capture(`ssh -F ${SSH_CONFIG} ${SSH_HOST} 'docker image inspect ${IMAGE} >/dev/null 2>&1 && echo HAVE || echo MISSING'`);
  if (!image.out.includes('HAVE')) {
    console.log(`远程缺少镜像 ${IMAGE}，开始拉取…`);
    run(`ssh -F ${SSH_CONFIG} ${SSH_HOST} 'docker pull ${IMAGE}'`);
  }
  console.log(`同步 release/ → ${SSH_HOST}:${REMOTE_DIR}/release…`);
  run(
    `tar -C ${repoRoot}/release -czf - . `
    + `| ssh -F ${SSH_CONFIG} ${SSH_HOST} 'mkdir -p ${REMOTE_DIR}/release && tar -C ${REMOTE_DIR}/release -xzf -'`,
  );

  console.log(`同步 extension/ → ${SSH_HOST}:${REMOTE_DIR}…`);
  run(
    `tar -C ${root} --exclude=./tests/e2e/out --exclude='./tests/e2e/out/*' -czf - . `
    + `| ssh -F ${SSH_CONFIG} ${SSH_HOST} 'mkdir -p ${REMOTE_DIR} && tar -C ${REMOTE_DIR} -xzf -'`,
  );

  // 容器里绑定 127.0.0.1:80，需要 root；playwright 镜像默认就是 root。
  const remoteXpi = xpi.startsWith(path.join(repoRoot, 'release'))
    ? `/release/${path.relative(path.join(repoRoot, 'release'), xpi).split(path.sep).join('/')}`
    : `/ext/${path.relative(root, xpi).split(path.sep).join('/')}`;
  console.log(`在容器 ${IMAGE} 里跑 Firefox E2E（Marionette + Xvfb）…`);
  run(
    `ssh -F ${SSH_CONFIG} ${SSH_HOST} "docker run --rm -v ${REMOTE_DIR}:/ext -w /ext `
    + `-v ${REMOTE_DIR}/release:/release:ro -e LZU_RELEASE_DIR=/release/${version} `
    + `-e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= `
    + `-e LZU_FIREFOX_XPI='${remoteXpi}' `
    + `-e LZU_E2E_OUT=/ext/tests/e2e/out/firefox `
    + `${IMAGE} `
    + `bash -lc 'Xvfb :99 -screen 0 1280x1024x24 >/tmp/xvfb.log 2>&1 & sleep 1; export DISPLAY=:99; `
    + `node --test tests/unit/version.test.mjs && node tests/e2e/firefox.mjs'"`,
  );

  console.log('回传测试产物…');
  await mkdir(path.join(OUT_DIR, 'firefox'), { recursive: true });
  run(
    `ssh -F ${SSH_CONFIG} ${SSH_HOST} 'tar -C ${REMOTE_DIR}/tests/e2e/out/firefox -czf - .' `
    + `| tar -C ${OUT_DIR}/firefox -xzf -`,
  );
}

async function main() {
  const { xpi, version } = await buildArtifacts();
  const chosen = (() => {
    if (mode === 'local' || mode === 'docker') return mode;
    if (findLocalFirefox()) return 'local';
    if (sshReady()) return 'docker';
    return '';
  })();
  if (!chosen) {
    throw new Error('没有可用 Firefox：本机没有，也连不上远程 Docker 主机。见 extension/README.md 的「测试」一节。');
  }
  console.log(`Firefox E2E 模式：${chosen}`);
  if (chosen === 'local') await runLocal(xpi);
  else await runDocker(xpi, version);
  summarize();
}

main().then(() => {
  console.log('\nFirefox E2E 通过。');
}).catch((err) => {
  console.error(`\nFirefox E2E 失败：${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
