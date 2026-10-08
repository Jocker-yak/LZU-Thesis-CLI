# -*- coding: utf-8 -*-
"""Download every page JPEG of a registered DRM document and assemble a PDF.

Usage:
  python fetch_pages.py --token <personaliiif-path-token> [--out DIRNAME]
  python fetch_pages.py --fid <fid> --cookie <JSESSIONID> [--out DIRNAME]
"""
import sys, os, re, json, time, argparse, io
import urllib.request, urllib.error, http.cookiejar
from PIL import Image

P29 = "http://202.201.7.29/"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def make_opener(cj, redirect=True):
    handlers = [urllib.request.HTTPCookieProcessor(cj)]
    if not redirect:
        handlers.insert(0, NoRedirect)
    op = urllib.request.build_opener(*handlers)
    op.addheaders = [("User-Agent", UA), ("Referer", P29)]
    return op


def fetch(op, url, timeout=120, tries=4):
    last = None
    for i in range(tries):
        try:
            return op.open(url, timeout=timeout).read()
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token")
    ap.add_argument("--fid")
    ap.add_argument("--cookie")
    ap.add_argument("--out", default="")
    ap.add_argument("--pages-dir", default="pages")
    a = ap.parse_args()

    cj = http.cookiejar.CookieJar()
    if a.cookie:
        cj.set_cookie(http.cookiejar.Cookie(version=0, name="JSESSIONID", value=a.cookie,
                                            port=None, port_specified=False, domain="202.201.7.29",
                                            domain_specified=False, domain_initial_dot=False, path="/",
                                            path_specified=True, secure=False, expires=None, discard=True,
                                            comment=None, comment_url=None, rest={}, rfc2109=False))

    if a.token:
        op = make_opener(cj, redirect=False)
        try:
            op.open(P29 + "personaliiifServlet?path=" + a.token, timeout=60)
            loc = ""
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location", "")
        print("register ->", loc)
        m = re.search(r"fid=([0-9a-fA-F]{32})", loc or "")
        fid = m.group(1) if m else a.fid
    else:
        fid = a.fid
    if not fid:
        sys.exit("no fid")
    print("fid =", fid)

    op = make_opener(cj)
    idx = fetch(op, P29 + "pdfindex1.jsp?fid=" + fid).decode("utf-8", "replace")
    open("probe/pdfindex_%s.html" % fid[:8], "w", encoding="utf-8").write(idx)

    def hidden(name):
        m = re.search(r'id="%s"[^>]*value="([^"]*)"' % name, idx) or re.search(r'name="%s"[^>]*value="([^"]*)"' % name, idx)
        if not m:
            m = re.search(r'value="([^"]*)"[^>]*(?:id|name)="%s"' % name, idx)
        return m.group(1) if m else None

    page_count = hidden("pageCount") or hidden("sum") or hidden("endpage")
    infoname = hidden("infoname") or fid
    print("pageCount=%s infoname=%s filename=%s watermark=%s pdfchange=%s" %
          (page_count, infoname, hidden("filename"), hidden("watermark"), hidden("pdfchange")))
    pc = int(page_count) if page_count and page_count.isdigit() else 0
    if pc <= 0:
        sys.exit("cannot read pageCount: %s" % page_count)

    pages = {}
    for p in range(0, pc + 2):
        try:
            raw = fetch(op, "%sjumpServlet?page=%d&fid=%s" % (P29, p, fid))
        except Exception as e:
            print("jumpServlet page=%d err %s" % (p, e)); continue
        try:
            js = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            continue
        lst = js.get("list") or []
        for it in lst:
            try:
                pages[int(it["id"])] = it["src"]
            except Exception:
                pass
        if len(pages) >= pc:
            break
    print("page urls collected:", len(pages), "of", pc)
    missing = [i for i in range(pc) if i not in pages]
    print("missing:", missing[:20])

    safe = re.sub(r"[\\/:*?\"<>|]", "_", infoname).strip()[:80] or fid
    outdir = a.out or safe
    imgdir = os.path.join(a.pages_dir, fid[:8])
    os.makedirs(imgdir, exist_ok=True)
    imgs = []
    for i in range(pc):
        f = os.path.join(imgdir, "%04d.jpg" % i)
        if os.path.exists(f) and os.path.getsize(f) > 1000:
            imgs.append(f); continue
        src = pages.get(i)
        if not src:
            print("skip page", i, "(no url)"); continue
        try:
            data = fetch(op, src)
            open(f, "wb").write(data)
            imgs.append(f)
        except Exception as e:
            print("page", i, "failed", e)
        if i % 10 == 0:
            print("downloaded %d/%d" % (i + 1, pc), flush=True)
    print("images:", len(imgs), "-> building pdf")

    pdf = os.path.join(a.pages_dir, safe + ".pdf")
    Image.init()
    first, rest = None, []
    loaded = []
    for f in imgs:
        try:
            im = Image.open(f)
            im.load()
            if im.mode != "RGB":
                im = im.convert("RGB")
            loaded.append(im)
        except Exception as e:
            print("cannot open", f, e)
    if loaded:
        loaded[0].save(pdf, "PDF", save_all=True, append_images=loaded[1:], resolution=150.0)
    print("PDF:", pdf, os.path.getsize(pdf) if os.path.exists(pdf) else "-", "pages", len(loaded))
    print("PAGES_DIR:", imgdir)
    print("INFONAME:", infoname)


if __name__ == "__main__":
    main()
