# -*- coding: utf-8 -*-
"""Lanzhou Univ. thesis portal -> DRM reader full-text harvester.

Pipeline
  search  <keyword>            : portal search -> records (id1,id2,title)
  tokens  <out.json>           : for every record, follow onlinePDF -> extract DRM path token
  identify <target_fid>        : register each token on .29, compare returned fid with target
  fetch   <fid> <cookie>       : download all page JPEGs and build a PDF
"""
import sys, os, re, json, base64, time, io
import urllib.request, urllib.parse, urllib.error, http.cookiejar

P17 = "http://202.201.7.17/"
P29 = "http://202.201.7.29/"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
HERE = os.path.dirname(os.path.abspath(__file__))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def opener(cj=None, redirect=True):
    cj = cj if cj is not None else http.cookiejar.CookieJar()
    handlers = [urllib.request.HTTPCookieProcessor(cj)]
    if not redirect:
        handlers.insert(0, NoRedirect)
    op = urllib.request.build_opener(*handlers)
    op.addheaders = [("User-Agent", UA)]
    return op


def alive(url=P29, timeout=12):
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout)
        return r.getcode()
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None


def portal_session():
    cj = http.cookiejar.CookieJar()
    op = opener(cj)
    op.open(P17 + "simpsearch.action?ffieldname=xkcode&ffieldkey=07*&dbid=72", timeout=40).read()
    return cj, op


def rows_of(op):
    out = []
    for u in ("zjresult_two.action", "resultlist.jsp"):
        try:
            raw = op.open(P17 + u, timeout=40).read().decode("utf-8", "replace")
        except Exception:
            continue
        for m in re.finditer(r"docinfo\('([0-9a-fA-F]+)','([^']+)'\)\">(.*?)</a>", raw, re.S):
            t = re.sub(r"\s+", " ", re.sub(r"<[^>]*>", "", m.group(3))).strip()
            out.append({"id1": m.group(1), "id2": m.group(2), "title": t})
        if out:
            break
    return out


def search(keyword):
    cj, op = portal_session()
    data = urllib.parse.urlencode({
        "searchkeyword": keyword,
        "searchstrs": "all:%s:and" % keyword,
        "ffields": "", "ffieldstr": ""}).encode()
    op.open(P17 + "zjresult_two.action", data, timeout=40).read()
    rs = rows_of(op)
    return rs


def docinfo_html(op, id1, id2):
    data = urllib.parse.urlencode({"id1": id1, "id2": id2}).encode()
    return op.open(P17 + "docinfo.action", data, timeout=40).read().decode("utf-8", "replace")


def decode_token(tok):
    """token = 5 random base64 chars + base64(quote(path)&startpage=..&endpage=..&down=..&watermark=..&filename=..&infoname=..)"""
    try:
        payload = base64.b64decode(tok[5:] + "=" * (-len(tok[5:]) % 4))
        s = urllib.parse.unquote(payload.decode("utf-8", "replace"))
    except Exception as e:
        return {"error": str(e)}
    d = {}
    parts = s.split("&")
    d["path"] = parts[0]
    for kv in parts[1:]:
        if "=" in kv:
            k, v = kv.split("=", 1)
            d[k] = v
    return d


def collect_tokens(keyword, outfile):
    cj, op = portal_session()
    data = urllib.parse.urlencode({"searchkeyword": keyword, "searchstrs": "all:%s:and" % keyword,
                                   "ffields": "", "ffieldstr": ""}).encode()
    op.open(P17 + "zjresult_two.action", data, timeout=40).read()
    recs = rows_of(op)
    print("records:", len(recs))
    res = []
    for i, r in enumerate(recs):
        try:
            html = docinfo_html(op, r["id1"], r["id2"])
        except Exception as e:
            print(i, "docinfo err", e); continue
        links = sorted(set(re.findall(r'href="(onlinePDF[^"]+)"', html)))
        item = dict(r, links=[], tokens=[])
        for lk in links:
            url = P17 + lk.replace("&amp;", "&")
            op2 = opener(cj, redirect=False)
            op2.addheaders = [("User-Agent", UA), ("Referer", P17 + "docinfo.action")]
            try:
                op2.open(url, timeout=40)
                item["links"].append(lk)
            except urllib.error.HTTPError as e:
                loc = e.headers.get("Location", "")
                item["links"].append(lk)
                m = re.search(r"personaliiifServlet\?path=([A-Za-z0-9+/=]+)", loc)
                if m:
                    tok = m.group(1)
                    dec = decode_token(tok)
                    item["tokens"].append({"token": tok, "link": lk, "decoded": dec})
            except Exception as e:
                print(i, "onlinePDF err", e)
        print("%02d tokens=%d %s" % (i, len(item["tokens"]), r["title"][:46]))
        for t in item["tokens"]:
            print("      ", t["decoded"].get("path"), "|", t["decoded"].get("filename"))
        res.append(item)
        json.dump(res, io.open(outfile, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("saved", outfile)


def register(token):
    """GET personaliiifServlet?path=<token> without following redirect -> (fid, cookie, status)."""
    cj = http.cookiejar.CookieJar()
    op = opener(cj, redirect=False)
    try:
        r = op.open(P29 + "personaliiifServlet?path=" + token, timeout=60)
        code, hdrs = r.getcode(), r.getheaders()
    except urllib.error.HTTPError as e:
        code, hdrs = e.code, e.headers.items()
    except Exception as e:
        return None, None, "ERR %s" % e
    loc = ""
    for k, v in hdrs:
        if k.lower() == "location":
            loc = v
    m = re.search(r"fid=([0-9a-fA-F]{32})", loc or "")
    fid = m.group(1) if m else None
    return fid, cj, "%s -> %s" % (code, loc)


def identify(target, infile):
    data = json.load(io.open(infile, encoding="utf-8"))
    for i, rec in enumerate(data):
        for t in rec["tokens"]:
            fid, cj, info = register(t["token"])
            mark = "  <<<< MATCH" if fid and fid.lower() == target.lower() else ""
            print("%02d %s | %s | %s%s" % (i, rec["title"][:40], fid, info[:80], mark))
            print("      path=%s" % t["decoded"].get("path"))
            if fid and fid.lower() == target.lower():
                print("FOUND record", i, "token", t["token"])
                return i, t


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "alive"
    if cmd == "alive":
        print(".29 ->", alive())
    elif cmd == "search":
        for r in search(sys.argv[2] if len(sys.argv) > 2 else "侯扶江"):
            print(r["id1"], r["id2"], r["title"][:60])
    elif cmd == "tokens":
        collect_tokens(sys.argv[3] if len(sys.argv) > 3 else "侯扶江", sys.argv[2])
    elif cmd == "identify":
        identify(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else os.path.join(HERE, "tokens.json"))
    elif cmd == "decodetoken":
        print(json.dumps(decode_token(sys.argv[2]), ensure_ascii=False, indent=1))
