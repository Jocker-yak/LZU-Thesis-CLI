/**
 * 跑 Chrome E2E。两种模式：
 *
 *   本地（有 Chromium 的 Linux）：
 *     npm run test:e2e                       # 自动找 chromium/google-chrome，必要时套 xvfb-run
 *     npm run test:e2e -- --mode=local
 *
 *   远程 Docker（本机没有浏览器时；默认用 nucbox）：
 *     npm run test:e2e -- --mode=docker      # 把 extension/ 同步到 nucbox，在
 *                                            # mcr.microsoft.com/playwright 容器里跑
 *
 * 可用环境变量覆盖远程参数：
 *   LZU_E2E_SSH_CONFIG（默认 /data/.ssh/config）、LZU_E2E_SSH_HOST（默认 nucbox）、
 *   LZU_E2E_REMOTE_DIR（默认 /home/oceanias/dsh/lzu-ext-e2e）、
 *   LZU_E2E_IMAGE（默认 mcr.microsoft.com/playwright:v1.64.1-noble）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..'); // extension/
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const mode = opt('mode', process.env.LZU_E2E_MODE || 'auto');
const SSH_CONFIG = process.env.LZU_E2E_SSH_CONFIG || '/data/.ssh/config';
const SSH_HOST = process.env.LZU_E2E_SSH_HOST || 'nucbox';
const REMOTE_DIR = process.env.LZU_E2E_REMOTE_DIR || '/home/oceanias/dsh/lzu-ext-e2e';
const IMAGE = process.env.LZU_E2E_IMAGE || 'mcr.microsoft.com/playwright:v1.64.1-noble';

function run(cmd, options = {}) {
  const res = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: root, ...options });
  if (res.status !== 0) {
    throw new Error(`命令失败（exit ${res.status}）：${cmd}`);
  }
}

function capture(cmd, options = {}) {
  const res = spawnSync(cmd, {
    shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: root, ...options,
  });
  return { ok: res.status === 0, out: `${res.stdout || ''}${res.stderr || ''}`.trim() };
}

function findLocalBrowser() {
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    const found = capture(`command -v ${name}`);
    if (found.ok && found.out) return found.out.split('\n')[0];
  }
  return '';
}

function hasDisplay() {
  return Boolean(process.env.DISPLAY);
}

function runLocal() {
  const browser = findLocalBrowser();
  if (!browser) {
    throw new Error('本机没有 Chromium/Chrome。请用 `npm run test:e2e -- --mode=docker` 在容器里跑。');
  }
  console.log(`本地浏览器：${browser}`);
  let prefix = '';
  if (!hasDisplay()) {
    const xvfb = capture('command -v xvfb-run');
    if (!xvfb.ok) throw new Error('没有 DISPLAY 也没有 xvfb-run；请装 xvfb 或用 --mode=docker。');
    prefix = 'xvfb-run -a ';
  }
  run(`${prefix}node tests/e2e/chrome.mjs --extension=dist/chrome --out=tests/e2e/out`);
}

function sshReady() {
  if (!existsSync(SSH_CONFIG)) return false;
  const res = capture(`ssh -F ${SSH_CONFIG} -o BatchMode=yes -o ConnectTimeout=8 ${SSH_HOST} 'echo READY'`);
  return res.ok && res.out.includes('READY');
}

async function runDocker() {
  if (!sshReady()) {
    throw new Error(`连不上 ${SSH_HOST}（ssh -F ${SSH_CONFIG}）。请先确认远程主机，或改用本机 Chromium。`);
  }
  const image = capture(`ssh -F ${SSH_CONFIG} ${SSH_HOST} 'docker image inspect ${IMAGE} >/dev/null 2>&1 && echo HAVE || echo MISSING'`);
  if (!image.out.includes('HAVE')) {
    console.log(`远程缺少镜像 ${IMAGE}，开始拉取（可能需要几分钟）…`);
    run(`ssh -F ${SSH_CONFIG} ${SSH_HOST} 'docker pull ${IMAGE}'`);
  }

  await mkdir(path.join(root, 'tests', 'e2e', 'out'), { recursive: true });
  console.log(`同步 extension/ → ${SSH_HOST}:${REMOTE_DIR}（排除 node_modules 之外的大件也没必要，直传）…`);
  run(
    `tar -C ${root} -czf - . `
    + `| ssh -F ${SSH_CONFIG} ${SSH_HOST} 'mkdir -p ${REMOTE_DIR} && tar -C ${REMOTE_DIR} -xzf -'`,
  );

  console.log(`在容器 ${IMAGE} 里跑 E2E…`);
  run(
    `ssh -F ${SSH_CONFIG} ${SSH_HOST} "docker run --rm -v ${REMOTE_DIR}:/ext -w /ext `
    + `-e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= `
    + `${IMAGE} `
    + `bash -lc 'Xvfb :99 -screen 0 1280x1024x24 >/tmp/xvfb.log 2>&1 & sleep 1; export DISPLAY=:99; `
    + `node tests/e2e/chrome.mjs --extension=dist/chrome --out=tests/e2e/out'"`,
  );

  console.log('回传测试产物…');
  run(
    `ssh -F ${SSH_CONFIG} ${SSH_HOST} 'tar -C ${REMOTE_DIR}/tests/e2e/out -czf - .' `
    + `| tar -C ${root}/tests/e2e/out -xzf -`,
  );
  const reportPath = path.join(root, 'tests', 'e2e', 'out', 'report.json');
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    console.log(`\nE2E 报告：${report.checks.filter((c) => c.ok).length}/${report.checks.length} 项通过`);
    for (const check of report.checks) console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}`);
  }
  console.log(`\n产物保留在：${path.join(root, 'tests', 'e2e', 'out')}`);
}

async function main() {
  console.log('构建扩展…');
  run('node scripts/build.mjs');

  const chosen = (() => {
    if (mode === 'local' || mode === 'docker') return mode;
    if (findLocalBrowser()) return 'local';
    if (sshReady()) return 'docker';
    return '';
  })();

  if (!chosen) {
    throw new Error('没有可用浏览器：本机无 Chromium，也连不上远程 Docker 主机。见 extension/README.md 的「测试」一节。');
  }
  console.log(`E2E 模式：${chosen}`);
  if (chosen === 'local') runLocal();
  else await runDocker();
}

main().then(() => {
  console.log('\nE2E 通过。');
}).catch((err) => {
  console.error(`\nE2E 失败：${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
