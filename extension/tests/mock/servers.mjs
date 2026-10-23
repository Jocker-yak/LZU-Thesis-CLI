/**
 * 本地 mock：复刻门户（202.201.7.17）与阅读器（202.201.7.29）的真实行为，
 * 用于集成测试；E2E 里也用同一套（端口 80 + host-resolver-rules）。
 *
 * 路由与真实抓包一致：
 *  门户  GET  /simpsearch.action          → 检索暖场页
 *        POST /zjresult_two.action        → 结果页（真实 fixture）
 *        GET  /zjresult_two.action        → 404（真实门户就是这样）
 *        GET  /resultlist.jsp             → 结果页（真实 fixture）
 *        POST /docinfo.action             → 有全文 / 无全文两种 docinfo 页
 *        GET  /onlinePDF?...              → 302 到阅读器 personaliiifServlet
 *  阅读器 GET  /personaliiifServlet?path=  → 校验令牌，302 到 /pdfindex1.jsp?fid=，种 JSESSIONID
 *        GET  /pdfindex1.jsp?fid=          → 隐藏域元信息（没会话时全 null）
 *        GET  /jumpServlet?page=N&fid=     → {"list":[{"id","src"}]}
 *        GET  /pdfboxServlet?...            → 真实 JPEG（tests/fixtures/images/school.jpg）
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');

export const MOCK_FID = '0f86d523cf98c2e7d4a8416c4d6bd7ee';
const ARTICLE_TITLE = '补播白刺花和施厩肥对两种暖季型草地土壤理化性质和生产力的影响';
const ARTICLE_FILENAME = '262010_220220931930_示例作者_free.pdf';

async function readBuffer(rel) {
  return readFile(path.join(FIXTURES, rel));
}

async function readText(rel) {
  return (await readBuffer(rel)).toString('utf8');
}

function jsonBody(res, status, text, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json;charset=utf-8', ...headers });
  res.end(text);
}

function htmlBody(res, status, text, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html;charset=utf-8', ...headers });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * 启动 mock 世界。
 * @param {{portalPort?:number, readerPort?:number, host?:string, pages?:number}} [opts]
 * @returns {Promise<{portalUrl:string, readerUrl:string, state:object, close:()=>Promise<void>}>}
 */
export async function startMockWorld(opts = {}) {
  const host = opts.host || '127.0.0.1';
  // E2E 里两个假域名要映射到不同回环地址（Chromium 的 --host-resolver-rules 只改 IP 不改端口），
  // 所以支持给门户/阅读器分别指定监听地址。
  const portalHost = opts.portalHost || host;
  const readerHost = opts.readerHost || host;
  const totalPages = opts.pages ?? 3;

  const state = {
    keyword: '侯扶江',
    total: 77,
    token: '', // 由 onlinePDF 302 之前从 fixture 填
    pages: totalPages,
    /** 模拟阅读器故障：null | 'gone'（500 文件不存在）| 'empty'（某页始终空）| 'empty-once'（第 1 页只空一次） */
    readerFault: null,
    emptyOnceUsed: false,
    requests: [],
  };

  const schoolJpeg = await readBuffer('images/school.jpg');
  const resultlist = await readText('portal/resultlist.html');
  const docinfoEmpty = await readText('portal/docinfo-empty.html');
  const docinfoLink = await readText('portal/docinfo-link.html');
  const captured = JSON.parse(await readText('portal/token.json'));
  state.token = captured.token;
  state.linkHref = captured.linkHref;

  // ---------------------------------------------------------------- 阅读器
  const readerServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${readerHost}`);
    state.requests.push(`reader ${req.method} ${url.pathname}${url.search}`);
    const cookies = parseCookies(req);
    const session = cookies.JSESSIONID;

    if (url.pathname === '/personaliiifServlet') {
      const token = url.searchParams.get('path') || '';
      if (token !== state.token) {
        htmlBody(res, 200, '<html>令牌无效</html>');
        return;
      }
      const location = `http://202.201.7.29/pdfindex1.jsp?fid=${MOCK_FID}`;
      res.writeHead(302, {
        location,
        'set-cookie': `JSESSIONID=new-session-${Date.now()}; Path=/; HttpOnly`,
        'content-type': 'text/html;charset=utf-8',
      });
      res.end('');
      return;
    }

    if (url.pathname === '/pdfindex1.jsp') {
      const fid = url.searchParams.get('fid') || '';
      const registered = Boolean(session) && fid === MOCK_FID;
      const field = (name, value) => `<input type="hidden" id="${name}" value="${escapeAttr(value)}">`;
      const metaHtml = registered
        ? [
          field('fid', MOCK_FID),
          field('sum', ''),
          field('pageCount', String(state.pages)),
          field('startpage', '1'),
          field('endpage', String(state.pages)),
          `<input type="hidden" name="filename" value="${escapeAttr(ARTICLE_FILENAME)}">`,
          `<input type="hidden" name="infoname" value="${escapeAttr(ARTICLE_TITLE)}">`,
          '<input type="hidden" name="watermark" value="">',
        ].join('\n')
        : [
          '<input type="hidden" id="fid" value="null">',
          '<input type="hidden" id="pageCount" value="null">',
          '<input type="hidden" id="sum" value="null">',
          '<input type="hidden" id="endpage" value="null">',
        ].join('\n');
      htmlBody(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>阅读器</title></head><body>
${metaHtml}
<script>var pdfUrl = "/pdfboxServlet";</script>
</body></html>`);
      return;
    }

    if (url.pathname === '/jumpServlet') {
      if (!session) {
        jsonBody(res, 200, '{"list":[]}');
        return;
      }
      const page = Number(url.searchParams.get('page'));
      const fid = url.searchParams.get('fid');
      if (fid !== MOCK_FID || !Number.isFinite(page) || page < 0 || page >= state.pages) {
        jsonBody(res, 200, '{"list":[]}');
        return;
      }
      if (state.readerFault === 'empty' && page === 1) {
        jsonBody(res, 200, '{"list":[]}');
        return;
      }
      if (state.readerFault === 'empty-once' && page === 1 && !state.emptyOnceUsed) {
        state.emptyOnceUsed = true;
        jsonBody(res, 200, '{"list":[]}');
        return;
      }
      jsonBody(res, 200, JSON.stringify({ list: [{ id: page, src: `/pdfboxServlet?id=${page + 1}&fid=${fid}` }] }));
      return;
    }

    if (url.pathname === '/pdfboxServlet') {
      if (state.readerFault === 'gone') {
        res.writeHead(500, { 'content-type': 'text/html;charset=utf-8' });
        res.end('<html>java.io.FileNotFoundException: 系统找不到指定的文件。</html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': schoolJpeg.length });
      res.end(schoolJpeg);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/html;charset=utf-8' });
    res.end('<html>404</html>');
  });
  await listen(readerServer, readerHost, opts.readerPort ?? 0);
  const readerPort = readerServer.address().port;
  const readerUrl = `http://${readerHost}:${readerPort}`;

  // ---------------------------------------------------------------- 门户
  const portalServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${portalHost}`);
    state.requests.push(`portal ${req.method} ${url.pathname}${url.search}`);

    if (url.pathname === '/simpsearch.action') {
      htmlBody(res, 200, '<!doctype html><html><body><form>检索页</form></body></html>');
      return;
    }

    if (url.pathname === '/zjresult_two.action') {
      if (req.method === 'POST') {
        await readBody(req);
        htmlBody(res, 200, resultlist);
      } else {
        htmlBody(res, 404, '<html>404（真实门户 GET zjresult_two 就是 404）</html>');
      }
      return;
    }

    if (url.pathname === '/resultlist.jsp') {
      htmlBody(res, 200, resultlist);
      return;
    }

    if (url.pathname === '/docinfo.action') {
      const body = new URLSearchParams(await readBody(req));
      const id1 = body.get('id1') || '';
      htmlBody(res, 200, id1 === captured.row.id1 ? docinfoLink : docinfoEmpty);
      return;
    }

    if (url.pathname === '/onlinePDF') {
      res.writeHead(302, {
        location: `http://202.201.7.29/personaliiifServlet?path=${state.token}`,
        'content-type': 'text/html;charset=utf-8',
      });
      res.end('');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/html;charset=utf-8' });
    res.end('<html>404</html>');
  });
  await listen(portalServer, portalHost, opts.portalPort ?? 0);
  const portalPort = portalServer.address().port;
  const portalUrl = `http://${portalHost}:${portalPort}`;

  return {
    portalUrl,
    readerUrl,
    state,
    close: async () => {
      await Promise.all([closeServer(portalServer), closeServer(readerServer)]);
    },
  };
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve(undefined)));
}
