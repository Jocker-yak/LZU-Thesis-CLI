# -*- coding: utf-8 -*-
"""202.201.7.29「版权保护」在线阅读器（小麦阅读器 DRM）客户端。

已验证的服务端行为
------------------
* ``fid`` 就是**原始 PDF 文件字节的 MD5**（32 位小写十六进制）。实测：自己造一个
  3 页 PDF（``md5 = 1261a0336915cef52a5e5752b4ca2f92``），把它放到阅读器的
  ``D:\\DRM\\read\\WebRoot\\store\\test.pdf``，注册后服务器返回的 fid 正是
  ``1261a0336915cef52a5e5752b4ca2f92``；反过来把这个文件改名成它的 md5
  （``store\\1261a033….pdf``）再注册则 500 ``FileNotFoundException``——说明认的是
  **内容**，不是文件名、也不是路径。所以 fid 是可靠的身份指纹：同一篇文档，
  谁注册、在哪个会话注册，都得到同一个 fid；而 store 里的随机文件名每次都变。
* 文档必须先"注册"进某个会话：
  ``GET /personaliiifServlet?path=<token>`` → 302 到 ``/pdfindex1.jsp?fid=<fid>``
  并下发 ``Set-Cookie: JSESSIONID``。用这个会话打开 pdfindex1.jsp 才能读到
  pageCount / infoname / filename / watermark 等隐藏域；否则全是 ``null``。
* 页面地址：``GET /jumpServlet?page=N&fid=<fid>`` 返回
  ``{"list":[{"id":"N","src":".../pdfboxServlet?page=<64位hex>"}]}``，
  但每次只给出 N 附近的一小段，所以要 ``0..pageCount`` 循环、合并去重。
* ``GET /pdfboxServlet?page=<64位hex>`` 直接返回该页 JPEG，**不需要 Cookie**，
  只需要那个 64 位十六进制令牌。
* 站点本身没有可用的原始 PDF 通道（downloadServlet 500、/store/ 被
  ``alert('不能打开！')`` 拦、pdfoffServlet 404），所以拿到的只能是渲染位图，
  分辨率约 144dpi，并且带站点水印。

令牌（token）格式（逆向并验证）
------------------------------
``token = 5 个随机 base64 字符 + base64( quote(path, safe="") + "&startpage=..&endpage=..&down=..&watermark=..&filename=..&infoname=.." )``
其中 ``path`` 是服务器上的 PDF 路径，形如 ``D:\\DRM\\read\\WebRoot\\store\\<随机名>.pdf``。
"""
import os
import random
import re
import string
import time
import urllib.parse

from . import net

BASE = "http://202.201.7.29"
REGISTER_PATH = "/personaliiifServlet?path="
INDEX_PATH = "/pdfindex1.jsp?fid="
JUMP_PATH = "/jumpServlet?page=%d&fid=%s"

META_FIELDS = ("fid", "sum", "pageCount", "startpage", "endpage",
               "filename", "infoname", "watermark", "pdfchange",
               "pagewidth", "pageheight", "pdfchange")

_NULLISH = (None, "", "null", "NULL")

#: 服务端明确说"文件不在"时的报错特征（这种错误重试没用）
_GONE_RE = re.compile(r"FileNotFoundException|系统找不到指定的文件|NoSuchFile",
                      re.IGNORECASE)


# --------------------------------------------------------------------------- #
# 令牌编解码
# --------------------------------------------------------------------------- #
def decode_token(token):
    """把 DRM 令牌还原成字典：path / startpage / endpage / down / watermark / filename / infoname。"""
    import base64

    body = token[5:]
    try:
        raw = base64.b64decode(body + "=" * (-len(body) % 4))
        text = urllib.parse.unquote(raw.decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}
    parts = text.split("&")
    out = {"path": parts[0]}
    for kv in parts[1:]:
        if "=" in kv:
            k, v = kv.split("=", 1)
            out[k] = v
    return out


def encode_token(path, startpage=1, endpage=1, down=50, watermark="",
                 filename="doc.pdf", infoname="doc", prefix=None):
    """伪造一个令牌（用于验证服务器上的文件路径 / 做身份比对）。"""
    import base64

    payload = "%s&startpage=%s&endpage=%s&down=%s&watermark=%s&filename=%s&infoname=%s" % (
        urllib.parse.quote(path, safe=""), startpage, endpage, down,
        watermark, filename, infoname)
    pre = prefix or "".join(random.choice(string.ascii_letters + string.digits)
                            for _ in range(5))
    return pre + base64.b64encode(payload.encode("utf-8")).decode("ascii")


def md5_file(path):
    from .pdfbuild import md5_file as _m

    return _m(path)


# --------------------------------------------------------------------------- #
# 注册（把文档绑定到一个会话上）
# --------------------------------------------------------------------------- #
def register(token, timeout=60, tries=3):
    """GET personaliiifServlet 注册文档。

    返回 dict：fid / jar / jsessionid / status / location / requoted / tries
    fid 为 None 表示注册失败（令牌失效或文件路径不存在，服务端会 500）。

    ``personaliiifServlet`` 偶尔会抖（同一个令牌前一秒 500、后一秒就正常），
    所以这里自带重试：网络异常和服务端 5xx 会重试 ``tries`` 次（每次换新会话）；
    服务端明确回 ``FileNotFoundException`` 这类确定性错误则不重试。
    """
    result = {"fid": None, "jar": None, "jsessionid": "", "status": None,
              "location": "", "requoted": False, "tries": 0}
    for candidate in (token, net.quote_token(token)):
        for attempt in range(max(1, tries)):
            result["tries"] += 1
            jar = net.new_jar()
            op = net.opener(jar, redirect=False)
            try:
                code, headers, body = net.open_once(
                    op, BASE + REGISTER_PATH + candidate, timeout=timeout)
            except Exception as e:  # noqa: BLE001 - 网络抖动，重试
                result.update(status="ERR %s" % e, jar=jar,
                              requoted=(candidate != token))
                if attempt + 1 < tries:
                    time.sleep(1.0 * (attempt + 1))
                    continue
                break
            loc = headers.get("Location", "")
            m = re.search(r"fid=([0-9a-fA-F]{32})", loc or "")
            result.update(status=code, location=loc, jar=jar,
                          jsessionid=net.cookie_value(jar, "JSESSIONID"),
                          requoted=(candidate != token))
            if m:
                result["fid"] = m.group(1).lower()
                return result
            body_text = (body or b"").decode("utf-8", "replace")
            fatal = bool(code and code < 500) or bool(_GONE_RE.search(body_text))
            if attempt + 1 < tries and not fatal:
                time.sleep(1.0 * (attempt + 1))
                continue
            break
    return result


def verify_token(token):
    """只注册、不下载：拿令牌换回它的 fid（身份指纹）。"""
    return register(token)


# --------------------------------------------------------------------------- #
# 阅读器客户端
# --------------------------------------------------------------------------- #
def _hidden(html, name):
    """从 pdfindex1.jsp 里抠出隐藏域的值；'null' 当没取到。"""
    pats = (
        r'id="%s"[^>]*?value="([^"]*)"' % name,
        r'value="([^"]*)"[^>]*?id="%s"' % name,
        r'name="%s"[^>]*?value="([^"]*)"' % name,
        r'value="([^"]*)"[^>]*?name="%s"' % name,
    )
    for p in pats:
        m = re.search(p, html)
        if m and m.group(1) not in _NULLISH:
            return m.group(1)
    return None


class Reader(object):
    """一个已注册会话上的文档阅读器。"""

    def __init__(self, fid, jar=None, jsessionid=None):
        self.fid = (fid or "").lower()
        if jar is None:
            jar = net.new_jar()
            if jsessionid:
                net.set_cookie(jar, "JSESSIONID", jsessionid, "202.201.7.29")
        self.jar = jar
        self.op = net.opener(jar, referer=BASE + "/pdfindex1.jsp")
        self._meta = None

    # --- 构造 ------------------------------------------------------------- #
    @classmethod
    def from_token(cls, token, timeout=60):
        """用门户给的令牌自助注册（推荐：不用手动抄 Cookie）。"""
        r = register(token, timeout=timeout)
        if not r["fid"]:
            raise RuntimeError(
                "注册失败：personaliiifServlet 未返回 fid（status=%s）。"
                "令牌可能已过期，或该文件在服务器上已不存在。" % r["status"])
        obj = cls(r["fid"], jar=r["jar"])
        obj.registration = r
        return obj

    @classmethod
    def from_session(cls, fid, jsessionid):
        """复用浏览器里已经注册好的会话（F12 → Application → Cookies → JSESSIONID）。"""
        return cls(fid, jsessionid=jsessionid)

    # --- 元信息 ----------------------------------------------------------- #
    def load_meta(self, refresh=False):
        if self._meta is not None and not refresh:
            return self._meta
        html = net.fetch_text(self.op, BASE + INDEX_PATH + self.fid)
        meta = {k: _hidden(html, k) for k in dict.fromkeys(META_FIELDS)}
        if not meta.get("pageCount") and not meta.get("sum"):
            raise RuntimeError(
                "这个会话里没有该文档（pdfindex1.jsp 字段全是 null）。"
                "fid 必须先在当前会话里注册过。")
        self._meta = meta
        return meta

    @property
    def page_count(self):
        meta = self.load_meta()
        for key in ("pageCount", "sum", "endpage"):
            v = meta.get(key)
            if v and str(v).isdigit():
                return int(v)
        raise RuntimeError("读不到 pageCount")

    @property
    def infoname(self):
        meta = self.load_meta()
        return meta.get("infoname") or meta.get("filename") or self.fid

    @property
    def filename(self):
        return self.load_meta().get("filename") or ""

    @property
    def watermark(self):
        return self.load_meta().get("watermark") or ""

    # --- 页面地址 --------------------------------------------------------- #
    def page_urls(self, progress=None):
        """返回 {页序号: 图片URL}，索引从 0 开始。"""
        n = self.page_count
        pages = {}
        for p in range(0, n + 2):
            try:
                raw = net.fetch(self.op, (BASE + JUMP_PATH) % (p, self.fid))
            except Exception as e:  # noqa: BLE001
                if progress:
                    progress("  jumpServlet page=%d 失败：%s" % (p, e))
                continue
            import json

            try:
                items = (json.loads(raw.decode("utf-8", "replace")) or {}).get("list") or []
            except Exception:
                continue
            for it in items:
                try:
                    src = it["src"]
                    if not src.startswith("http"):
                        src = BASE + "/" + src.lstrip("/")
                    pages[int(it["id"])] = src
                except Exception:
                    pass
            if len(pages) >= n:
                break
        return pages

    # --- 下载 ------------------------------------------------------------- #
    def download_pages(self, imgdir, progress=None):
        """逐页下载 JPEG 到 imgdir（已存在且 >1KB 的跳过，方便断点续传）。"""
        n = self.page_count
        pages = self.page_urls(progress=progress)
        if progress:
            progress("  页面地址 %d/%d" % (len(pages), n))
        os.makedirs(imgdir, exist_ok=True)
        paths = []
        for i in range(n):
            f = os.path.join(imgdir, "%04d.jpg" % i)
            if os.path.exists(f) and os.path.getsize(f) > 1000:
                paths.append(f)
                continue
            src = pages.get(i)
            if not src:
                if progress:
                    progress("  第 %d 页没有地址，跳过" % (i + 1))
                continue
            try:
                data = net.fetch(self.op, src)
            except Exception as e:  # noqa: BLE001
                if progress:
                    progress("  第 %d 页下载失败：%s" % (i + 1, e))
                continue
            with open(f, "wb") as fh:
                fh.write(data)
            paths.append(f)
            if progress and (i % 10 == 0 or i == n - 1):
                progress("  下载 %d/%d" % (i + 1, n))
        return paths

    # --- 一条龙 ----------------------------------------------------------- #
    def fetch(self, outdir="out", name=None, resolution=150.0,
              keep_images=True, progress=None):
        """下载全部页面并合成 PDF。返回 dict(pdf, pages, imgdir, name, meta)。"""
        from .pdfbuild import images_to_pdf, safe_name

        progress = progress or (lambda s: None)
        meta = self.load_meta()
        n = self.page_count
        title = name or self.infoname
        safe = safe_name(title, fallback=self.fid[:8])
        os.makedirs(outdir, exist_ok=True)
        imgdir = os.path.join(outdir, "pages", self.fid[:8])
        progress("文档：%s（%d 页）" % (title, n))
        paths = self.download_pages(imgdir, progress=progress)
        if not paths:
            raise RuntimeError("一页都没下载到")
        pdf = os.path.join(outdir, safe + ".pdf")
        pdf, cnt = images_to_pdf(paths, pdf, resolution=resolution)
        if not keep_images:
            import shutil

            shutil.rmtree(imgdir, ignore_errors=True)
        return {"pdf": pdf, "pages": cnt, "imgdir": imgdir if keep_images else None,
                "name": safe, "title": title, "fid": self.fid, "meta": meta}
