/**
 * 真实站点只读冒烟：验证「门户检索 → docinfo → onlinePDF 302 → 令牌解码」这条链路。
 *
 * 只发 GET/POST 读请求，不注册令牌、不抓阅读器页面（`.29` 通常只在校内网可达），
 * 因此这个脚本在任何能访问门户的机器/网络里都可以安全跑：
 *
 *   npm run smoke:live
 *   node tests/e2e/live-portal.mjs [关键词]
 *
 * 退出码：0 = 门户链路正常；1 = 门户链路失败。阅读器不可达只记录、不判失败。
 */
import { createHttp } from '../../src/lib/http.js';
import { search, recordLinks } from '../../src/lib/portal.js';
import { decodeToken, extractToken } from '../../src/lib/protocol.js';
import { makeNodeRequest } from '../mock/node-request.mjs';

const keyword = process.argv[2] || '侯扶江';
const nodeRequest = makeNodeRequest({ keepCookies: true });
const http = createHttp(nodeRequest.request, { retries: 2, timeoutMs: 30000 });

const checks = [];
function ok(name, detail) {
  checks.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function bad(name, detail) {
  checks.push({ name, ok: false, detail });
  console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const t0 = Date.now();

  // 1. 门户检索
  const result = await search(http, keyword);
  if (!result.rows.length) throw new Error(`门户没有检索到「${keyword}」的记录`);
  ok('门户检索', `关键字「${keyword}」命中 ${result.rows.length} 行，门户标称 ${result.total ?? '?'} 条，${Date.now() - t0}ms`);

  // 2. docinfo：找一条有 onlinePDF 入口的记录（最多看前 6 条，避免请求过多）
  let picked = null;
  for (const row of result.rows.slice(0, 6)) {
    const found = await recordLinks(http, row);
    if (found.absLinks && found.absLinks.length) {
      picked = { row, link: found.absLinks[0] };
      break;
    }
  }
  if (!picked) {
    // 门户本身可达，但没有全文入口：不算链路失败（可能这组关键词都没入口 / 需要登录）
    bad('docinfo 全文入口', '前 6 条记录都没有 onlinePDF 入口（门户可达，但需要登录或没有全文）');
    throw new Error('没有可用的全文入口，无法继续验证令牌链路');
  }
  ok('docinfo 全文入口', `${picked.row.title || picked.row.id1} → ${picked.link.replace(/objid=[^&]*/, 'objid=…')}`);

  // 3. onlinePDF 302 → 令牌
  // 这里必须自己看到 302：raw() 走的是默认跟随，所以直接用 node 侧 request
  const res = await nodeRequest.request({ url: picked.link, method: 'GET', redirect: 'manual' });
  res.headers = Object.fromEntries(Object.entries(res.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const location = (res.headers && (res.headers.location || res.headers.Location)) || '';
  if (res.status !== 302 || !location) {
    throw new Error(`onlinePDF 期望 302 + Location，实际 ${res.status} ${JSON.stringify(res.headers)}`);
  }
  const token = extractToken(location);
  if (!token) throw new Error(`302 Location 里没有令牌：${location.slice(0, 160)}`);
  ok('onlinePDF 302', `HTTP ${res.status}，Location → ${location.split('path=')[0]}path=…（令牌 ${token.length} 字符）`);

  // 4. 令牌解码（本地）
  const info = decodeToken(token);
  if (!info.path || !info.filename) throw new Error(`令牌解码结果不完整：${JSON.stringify(info)}`);
  ok('令牌解码', `path=${info.path}，pages=${info.startpage}-${info.endpage}，filename=${info.filename}`);
  if (info.infoname) console.log(`   题名：${info.infoname}`);

  // 5. 阅读器可达性（只记录，不判失败）
  const reader = await http
    .raw('http://202.201.7.29/', { timeoutMs: 8000 })
    .then((r) => ({ ok: true, status: r.status }))
    .catch((err) => ({ ok: false, error: (err && err.message) || String(err) }));
  const readerLine = reader.ok ? `HTTP ${reader.status}` : `不可达（${reader.error}）`;
  console.log(`ℹ 阅读器 202.201.7.29：${readerLine}`);
  if (!reader.ok) console.log('   —— 阅读器通常只在校内网可达，插件会在运行时给出提示。');
}

main().then(() => {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n只读冒烟：${checks.length - failed.length}/${checks.length} 项通过。`);
  process.exit(failed.length ? 1 : 0);
}).catch((err) => {
  console.error(`\n只读冒烟失败：${err && err.message ? err.message : err}`);
  process.exit(1);
});
