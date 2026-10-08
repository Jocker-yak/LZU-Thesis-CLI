# -*- coding: utf-8 -*-
"""
Harvest all page images of a document from the 版权保护 online reader (202.201.7.29)
and assemble them into a PDF.

Two ways to get the document registered into a session:

  A) you already have a live browser session (fid + JSESSIONID cookie):
     python harvest.py --fid <fid> --cookie <JSESSIONID>

  B) forge the personaliiifServlet path-token for a known server-side file path:
     python harvest.py --path "D:\\DRM\\read\\WebRoot\\store\\xxx.pdf" --filename xxx.pdf

     token format (reverse engineered):
         token = 5 random chars + base64( quote(path) + "&startpage=..&endpage=..&down=50&watermark=..&filename=..&infoname=.." )
"""
import argparse, base64, http.cookiejar, json, os, random, re, string, sys, urllib.parse, urllib.request

BASE = "http://202.201.7.29"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
opener.addheaders = [("User-Agent", UA), ("Referer", BASE + "/pdfindex1.jsp")]


def get(url, binary=False):
    with opener.open(url, timeout=60) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


def field(html, name):
    m = re.search(r'id="%s"[^>]*value="([^"]*)"' % name, html)
    if not m:
        m = re.search(r'value="([^"]*)"[^>]*id="%s"' % name, html)
    return m.group(1) if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fid")
    ap.add_argument("--cookie", help="JSESSIONID value of a session where the doc is registered")
    ap.add_argument("--path", help="server-side pdf path, e.g. D:\\DRM\\read\\WebRoot\\store\\a.pdf")
    ap.add_argument("--filename", default="doc.pdf")
    ap.add_argument("--infoname", default="doc")
    ap.add_argument("--watermark", default="")
    ap.add_argument("--outdir", default="pages")
    ap.add_argument("--pdf", default="fulltext.pdf")
    ap.add_argument("--keep", action="store_true", help="keep page images")
    args = ap.parse_args()

    fid = args.fid
    if args.path:
        enc = urllib.parse.quote(args.path, safe="")
        payload = ("%s&startpage=1&endpage=1&down=50&watermark=%s&filename=%s&infoname=%s"
                   % (enc, args.watermark, args.filename, args.infoname))
        prefix = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(5))
        token = prefix + base64.b64encode(payload.encode("utf-8")).decode("ascii")
        url = BASE + "/personaliiifServlet?path=" + urllib.parse.quote(token, safe="")
        html = get(url)  # final landing page after redirect (302 followed)
        m = re.search(r"fid=([0-9a-f]{32})", html) or None
        # fid also appears in the hidden field of the landing page
        fid = field(html, "fid") or fid
        print("[reg] path=%s -> fid=%s" % (args.path, fid))
    elif args.cookie:
        opener.addheaders.append(("Cookie", "JSESSIONID=" + args.cookie))

    if not fid:
        sys.exit("need --fid (with --cookie) or --path")

    html = get(BASE + "/pdfindex1.jsp?fid=" + fid)
    info = {k: field(html, k) for k in
            ("fid", "sum", "pageCount", "startpage", "endpage", "filename", "infoname", "watermark", "pdfchange")}
    print("[meta]", info)
    try:
        n = int(info["pageCount"])
    except (TypeError, ValueError):
        sys.exit("document not registered in this session (fields are null)")

    js = get(BASE + "/jumpServlet?page=0&fid=" + fid)
    try:
        items = json.loads(js).get("list") or []
    except json.JSONDecodeError:
        sys.exit("jumpServlet did not return json: " + js[:400])
    urls = [it["src"] if it["src"].startswith("http") else BASE + "/" + it["src"].lstrip("/") for it in items]
    print("[pages] %d urls from jumpServlet (pageCount=%d)" % (len(urls), n))
    if len(urls) < n:
        for i in range(1, n):
            try:
                items = json.loads(get(BASE + "/jumpServlet?page=%d&fid=%s" % (i, fid))).get("list") or []
            except Exception:
                continue
            for it in items:
                u = it["src"] if it["src"].startswith("http") else BASE + "/" + it["src"].lstrip("/")
                if u not in urls:
                    urls.append(u)

    os.makedirs(args.outdir, exist_ok=True)
    paths = []
    for i, u in enumerate(urls):
        p = os.path.join(args.outdir, "page%04d.jpg" % (i + 1))
        with open(p, "wb") as f:
            f.write(get(u, binary=True))
        paths.append(p)
        print("  %3d/%d %6d bytes  %s" % (i + 1, len(urls), os.path.getsize(p), u[-40:]))

    from PIL import Image
    imgs = [Image.open(p).convert("RGB") for p in paths]
    if not imgs:
        sys.exit("no pages downloaded")
    imgs[0].save(args.pdf, save_all=True, append_images=imgs[1:], resolution=150.0)
    print("[done] %s  pages=%d  size=%d bytes" % (args.pdf, len(imgs), os.path.getsize(args.pdf)))
    if not args.keep:
        for p in paths:
            try:
                os.remove(p)
            except OSError:
                pass


if __name__ == "__main__":
    main()
