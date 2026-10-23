/**
 * 把扩展里硬编码的 http://202.201.7.17 / http://202.201.7.29 请求映射到本地 mock，
 * 其余行为尽量贴近浏览器：手动跟 302、维护 cookie jar、超时。
 *
 * 这样 integration 测试跑的是 src/lib 里的真实代码（不是复制品）。
 */

/**
 * @param {Record<string,string>} mapping 假 origin → 本地 mock URL，如 {'http://202.201.7.17':'http://127.0.0.1:1234'}
 * @param {{timeoutMs?:number}} [opts]
 */
export function createLocalRequest(mapping, { timeoutMs = 10000 } = {}) {
  const cookies = new Map(); // host -> Map(name, value)

  const mapUrl = (url) => {
    for (const [fake, real] of Object.entries(mapping)) {
      if (url.startsWith(fake)) return real + url.slice(fake.length);
    }
    return url;
  };

  const cookieHeader = (url) => {
    const host = new URL(url).host;
    const jar = cookies.get(host);
    if (!jar) return '';
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  };

  const storeCookies = (url, headers) => {
    const host = new URL(url).host;
    const list = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
    if (!list.length) return;
    let jar = cookies.get(host);
    if (!jar) {
      jar = new Map();
      cookies.set(host, jar);
    }
    for (const raw of list) {
      const first = String(raw).split(';')[0];
      const idx = first.indexOf('=');
      if (idx > 0) jar.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim());
    }
  };

  async function requestOnce(url, spec) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs ?? timeoutMs);
    try {
      const headers = { ...(spec.headers || {}) };
      const cookie = cookieHeader(url);
      if (cookie) headers.cookie = cookie;
      const res = await fetch(mapUrl(url), {
        method: spec.method || 'GET',
        headers,
        body: spec.body ?? undefined,
        redirect: 'manual',
        signal: controller.signal,
      });
      const body = new Uint8Array(await res.arrayBuffer());
      const outHeaders = {};
      for (const [k, v] of res.headers) outHeaders[k.toLowerCase()] = v;
      storeCookies(url, res.headers);
      return { status: res.status, headers: outHeaders, body, url };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 与 src/lib/http.js 约定的 request(spec) 完全一致。
   * @param {{url:string, method?:string, headers?:object, body?:string|null, timeoutMs?:number}} spec
   */
  async function request(spec) {
    let url = spec.url;
    let method = spec.method || 'GET';
    let body = spec.body ?? null;
    for (let hop = 0; hop < 12; hop++) {
      const res = await requestOnce(url, { ...spec, method, body });
      const location = res.headers.location;
      const isRedirect = res.status >= 300 && res.status < 400 && location;
      if (!isRedirect) return res;
      url = new URL(location, url).toString();
      if (res.status === 303 || (res.status === 302 && method === 'POST')) {
        method = 'GET';
        body = null;
      }
    }
    throw new Error('重定向次数过多');
  }

  return {
    request,
    cookieHeader,
    clearCookies: () => cookies.clear(),
    cookies,
  };
}
