# -*- coding: utf-8 -*-
"""极简 HTTP 工具：带 Cookie 的 opener、不跟随重定向、自动重试与健康检查。

只依赖标准库，方便在没有装任何第三方包的环境里直接跑。
"""
import http.cookiejar
import time
import urllib.error
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """让 302 变成"可读取的响应"，而不是自动跟过去（我们要看 Location 头）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def new_jar():
    return http.cookiejar.CookieJar()


def set_cookie(jar, name, value, domain, path="/"):
    """手工往 CookieJar 里塞一个 Cookie（例如从浏览器里抄来的 JSESSIONID）。"""
    jar.set_cookie(http.cookiejar.Cookie(
        version=0, name=name, value=value, port=None, port_specified=False,
        domain=domain, domain_specified=False, domain_initial_dot=False,
        path=path, path_specified=True, secure=False, expires=None,
        discard=True, comment=None, comment_url=None, rest={}, rfc2109=False))


def cookie_value(jar, name):
    for c in jar:
        if c.name == name:
            return c.value
    return ""


def opener(jar=None, redirect=True, referer=None):
    """构造一个带 Cookie 支持的 opener。redirect=False 时不自动跟随 302。"""
    jar = jar if jar is not None else new_jar()
    handlers = [urllib.request.HTTPCookieProcessor(jar)]
    if not redirect:
        handlers.insert(0, _NoRedirect)
    op = urllib.request.build_opener(*handlers)
    headers = [("User-Agent", UA)]
    if referer:
        headers.append(("Referer", referer))
    op.addheaders = headers
    return op


def open_once(op, url, data=None, timeout=60):
    """请求一次，返回 (status, headers_dict, body_bytes)。HTTP 错误码不抛异常。"""
    req = urllib.request.Request(url, data=data)
    try:
        r = op.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        r = e
    try:
        body = r.read()
        code = r.getcode()
        headers = {k: v for k, v in r.headers.items()}
    finally:
        try:
            r.close()
        except Exception:
            pass
    return code, headers, body


def fetch(op, url, data=None, timeout=60, tries=4, delay=1.5):
    """带重试的 GET/POST，返回 bytes。全部失败时抛出最后一次异常。"""
    last = None
    for i in range(tries):
        try:
            return open_once(op, url, data, timeout)[2]
        except Exception as e:  # noqa: BLE001 - 网络抖动全都重试
            last = e
            time.sleep(delay * (i + 1))
    raise last


def fetch_text(op, url, data=None, encoding="utf-8", **kw):
    return fetch(op, url, data, **kw).decode(encoding, "replace")


def status(url, timeout=12):
    """轻量健康检查：返回 HTTP 状态码，连不上返回 None。"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        r = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None
    try:
        return r.getcode()
    finally:
        r.close()


def quote_token(token):
    """令牌里可能出现 base64 的 '+'，在 query 里会被当成空格，这里做一次安全编码。"""
    return urllib.parse.quote(token, safe="")
