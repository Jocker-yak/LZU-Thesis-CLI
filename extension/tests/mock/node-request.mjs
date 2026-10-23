/**
 * Node 侧 request() 实现：给 createHttp 注入用（fixture 抓取 / 集成测试 / 真实冒烟）。
 * 契约见 src/lib/http.js：request(spec) -> {status, headers, body, url}
 */
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function makeNodeRequest({
  keepCookies = true, defaultHeaders = {}, userAgent = UA,
} = {}) {
  const jar = new Map();

  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

  const absorb = (res) => {
    if (!keepCookies) return;
    const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const pair = line.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  };

  const request = async (spec) => {
    const {
      url, method = 'GET', headers = {}, body = null, timeoutMs = 45000, redirect = 'follow',
    } = spec || {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
    try {
      const outHeaders = {
        'user-agent': userAgent,
        'accept-language': 'zh-CN,zh;q=0.9',
        ...defaultHeaders,
        ...headers,
      };
      if (keepCookies && jar.size && !outHeaders.cookie) outHeaders.cookie = cookieHeader();
      const res = await fetch(url, {
        method,
        headers: outHeaders,
        body: body == null ? undefined : body,
        redirect,
        signal: ctrl.signal,
      });
      absorb(res);
      const buf = new Uint8Array(await res.arrayBuffer());
      const h = {};
      res.headers.forEach((value, key) => {
        h[key] = key === 'set-cookie' ? value : value;
      });
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      if (setCookies.length) h['set-cookie'] = setCookies.join(', ');
      return { status: res.status, url: res.url || url, headers: h, body: buf };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    request,
    cookieHeader,
    clearCookies: () => jar.clear(),
    get cookies() {
      return new Map(jar);
    },
  };
}
