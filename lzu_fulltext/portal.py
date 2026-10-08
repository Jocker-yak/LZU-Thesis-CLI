# -*- coding: utf-8 -*-
"""202.201.7.17 兰州大学学位论文管理系统（门户）客户端。

它只负责"找到全文链接"，真正的全文在 .29 那台 DRM 阅读器上：
``/onlinePDF?dbid=72&objid=<...>&flag=online`` → 302 → ``.29/personaliiifServlet?path=<令牌>``。

objid 是 ASCII 码用下划线连起来的，例如 ``55_55_55_57_56_49`` → ``"777981"``。
"""
import re
import urllib.parse

from . import net

BASE = "http://202.201.7.17"
SEARCH_URL = BASE + "/simpsearch.action?ffieldname=xkcode&ffieldkey=07*&dbid=72"
RESULT_URLS = ("/zjresult_two.action", "/resultlist.jsp")

_ROW_RE = re.compile(r"docinfo\('([0-9a-fA-F]+)','([^']+)'\)\">(.*?)</a>", re.S)
_ONLINE_RE = re.compile(r'href="(onlinePDF[^"]+)"')
_TOKEN_RE = re.compile(r"personaliiifServlet\?path=([A-Za-z0-9+/=%]+)")


def objid_to_text(objid):
    """'55_55_55_57_56_49' -> '777981'"""
    try:
        return "".join(chr(int(x)) for x in objid.split("_") if x)
    except Exception:  # noqa: BLE001
        return objid


def token_from_link(url, jar=None, referer=None, timeout=40):
    """给一个 onlinePDF 链接（可相对可绝对），返回 (令牌, 完整 Location)。

    不自动跟随 302，直接从 Location 里抠令牌。
    **必须携带门户会话**（先 warm() 过检索页），否则门户不会把它转给阅读器。
    """
    if not url.lower().startswith("http"):
        url = BASE + "/" + url.lstrip("/")
    op = net.opener(jar, redirect=False,
                    referer=referer or (BASE + "/docinfo.action"))
    try:
        code, headers, _ = net.open_once(op, url, timeout=timeout)
    except Exception as e:  # noqa: BLE001
        return None, "ERR %s" % e
    loc = headers.get("Location", "")
    m = _TOKEN_RE.search(loc or "")
    return (m.group(1) if m else None), "%s -> %s" % (code, loc)


class Portal(object):
    def __init__(self, timeout=40):
        self.timeout = timeout
        self.jar = net.new_jar()
        self.referer = BASE + "/docinfo.action"
        self.op = net.opener(self.jar, referer=BASE + "/")

    def warm(self):
        """先访问一次检索页拿 JSESSIONID，后面的 action 才认。"""
        net.fetch(self.op, SEARCH_URL, timeout=self.timeout)

    # --- 检索 ------------------------------------------------------------- #
    def search(self, keyword):
        """按关键词检索，返回 [{'id1','id2','title'}, ...]。"""
        self.warm()
        data = urllib.parse.urlencode({"searchkeyword": keyword,
                                       "searchstrs": "all:%s:and" % keyword,
                                       "ffields": "", "ffieldstr": ""}).encode()
        net.fetch(self.op, BASE + "/zjresult_two.action", data, timeout=self.timeout)
        for u in RESULT_URLS:
            try:
                raw = net.fetch_text(self.op, BASE + u, timeout=self.timeout)
            except Exception:  # noqa: BLE001
                continue
            rows = []
            for m in _ROW_RE.finditer(raw):
                title = re.sub(r"<[^>]*>", "", m.group(3))
                rows.append({"id1": m.group(1), "id2": m.group(2),
                             "title": re.sub(r"\s+", " ", title).strip()})
            if rows:
                return rows
        return []

    def docinfo_html(self, id1, id2):
        data = urllib.parse.urlencode({"id1": id1, "id2": id2}).encode()
        return net.fetch_text(self.op, BASE + "/docinfo.action", data,
                              timeout=self.timeout)

    def online_links(self, id1, id2):
        html = self.docinfo_html(id1, id2)
        return sorted(set(_ONLINE_RE.findall(html)))

    # --- 令牌 ------------------------------------------------------------- #
    def tokens_for(self, record):
        """对一条记录，把它所有 onlinePDF 链接换成 DRM 令牌。

        注意：链接要用**门户自己的会话**去请求，独立会话拿不到令牌。
        """
        from .drm import decode_token

        out = []
        for lk in self.online_links(record["id1"], record["id2"]):
            tok, info = token_from_link(lk, jar=self.jar, referer=self.referer,
                                        timeout=self.timeout)
            if tok:
                out.append({"token": tok, "link": lk,
                            "decoded": decode_token(tok), "info": info})
        return out

    def token_for_link(self, link):
        """独立使用：给一个 onlinePDF 链接，先 warm 会话再换令牌。"""
        self.warm()
        return token_from_link(link, jar=self.jar, referer=self.referer,
                               timeout=self.timeout)

    def collect(self, keyword, out=None, progress=None):
        """检索 + 逐条取令牌。out 给路径则顺便写 JSON。"""
        import io
        import json

        progress = progress or (lambda s: None)
        recs = self.search(keyword)
        progress("命中 %d 条记录" % len(recs))
        result = []
        for i, r in enumerate(recs):
            try:
                toks = self.tokens_for(r)
            except Exception as e:  # noqa: BLE001
                progress("  %02d docinfo 失败：%s" % (i, e))
                toks = []
            item = dict(r, tokens=toks, links=[t["link"] for t in toks])
            result.append(item)
            progress("  %02d 令牌=%d %s" % (i, len(toks), r["title"][:40]))
            for t in toks:
                progress("        %s | %s" % (t["decoded"].get("path"),
                                              t["decoded"].get("filename")))
            if out:
                with io.open(out, "w", encoding="utf-8") as fh:
                    json.dump(result, fh, ensure_ascii=False, indent=1)
        return result
