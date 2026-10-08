# -*- coding: utf-8 -*-
"""统一命令行入口。

    python -m lzu_fulltext probe
    python -m lzu_fulltext decode   <token>
    python -m lzu_fulltext forge    --path <服务器PDF路径>
    python -m lzu_fulltext verify   <token> [<token> ...]
    python -m lzu_fulltext search   <关键词>
    python -m lzu_fulltext tokens   <关键词> --out tokens.json
    python -m lzu_fulltext identify <fid> [--from tokens.json]
    python -m lzu_fulltext fetch    --token <token> | --fid F --cookie S | --link <onlinePDF链接>
    python -m lzu_fulltext grab     --keyword <关键词> (--find-fid <fid> | --index N)
"""
import argparse
import json
import os
import sys

from . import drm, net, portal


def _p(msg):
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:  # Windows 控制台编码兜底
        sys.stdout.write(str(msg).encode("utf-8", "replace").decode("utf-8", "replace") + "\n")


# --------------------------------------------------------------------------- #
def cmd_probe(a):
    v17 = net.status(portal.BASE + "/")
    v29 = net.status(drm.BASE + "/")
    _p("门户 .17  -> %s" % (v17 if v17 else "不可达"))
    _p("阅读器 .29 -> %s" % (v29 if v29 else "不可达"))
    return 0 if v29 else 1


def cmd_decode(a):
    d = drm.decode_token(a.token)
    _p(json.dumps(d, ensure_ascii=False, indent=1))
    return 0


def cmd_forge(a):
    tok = drm.encode_token(a.path, startpage=a.startpage, endpage=a.endpage,
                           down=a.down, watermark=a.watermark,
                           filename=a.filename, infoname=a.infoname)
    _p("token = %s" % tok)
    _p("decoded = %s" % json.dumps(drm.decode_token(tok), ensure_ascii=False))
    if a.verify:
        r = drm.register(tok)
        _p("register -> status=%s fid=%s" % (r["status"], r["fid"]))
        _p("Location: %s" % r["location"])
        return 0 if r["fid"] else 1
    return 0


def cmd_verify(a):
    bad = 0
    for tok in a.tokens:
        r = drm.register(tok, timeout=a.timeout)
        _p("fid=%s  status=%s  %s" % (r["fid"], r["status"],
                                      json.dumps(drm.decode_token(tok).get("path"), ensure_ascii=False)))
        if not r["fid"]:
            bad += 1
    return 1 if bad else 0


def cmd_search(a):
    rows = portal.Portal().search(a.keyword)
    for i, r in enumerate(rows):
        _p("%02d  id1=%s id2=%s  %s" % (i, r["id1"], r["id2"], r["title"][:70]))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False, indent=1)
        _p("saved %s" % a.json)
    _p("共 %d 条" % len(rows))
    return 0


def cmd_tokens(a):
    recs = portal.Portal().collect(a.keyword, out=a.out, progress=_p)
    _p("共 %d 条记录，%d 个令牌 -> %s" % (len(recs),
                                        sum(len(r["tokens"]) for r in recs), a.out))
    return 0


def _load_records(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def cmd_identify(a):
    recs = _load_records(a.from_file)
    target = a.fid.lower()
    found = None
    for i, rec in enumerate(recs):
        for t in rec.get("tokens", []):
            r = drm.register(t["token"])
            hit = r["fid"] == target
            _p("%02d %-42s fid=%-32s %s" % (i, rec.get("title", "")[:42],
                                            r["fid"], "<<< 命中" if hit else ""))
            if hit:
                found = {"index": i, "record": rec, "token": t["token"],
                         "decoded": t.get("decoded")}
                _p("     path = %s" % t.get("decoded", {}).get("path"))
    if not found:
        _p("没有记录匹配 fid=%s" % target)
        return 1
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(found, fh, ensure_ascii=False, indent=1)
        _p("saved %s" % a.json)
    return 0


def _resolve_token(a):
    """把 fetch/grab 的几种入口统一成一个 DRM 令牌。"""
    if a.link:
        tok, info = portal.Portal(timeout=a.timeout).token_for_link(a.link)
        _p("link -> %s" % info)
        if not tok:
            raise SystemExit("这个链接里没有 personaliiifServlet 令牌")
        return tok
    return a.token


def cmd_fetch(a):
    token = _resolve_token(a)
    if token:
        _p("注册令牌 …")
        reader = drm.Reader.from_token(token, timeout=a.timeout)
        _p("fid = %s" % reader.fid)
    elif a.fid and a.cookie:
        reader = drm.Reader.from_session(a.fid, a.cookie)
    elif a.fid:
        raise SystemExit("只给 --fid 不够：文档必须在某个会话里注册过，"
                         "请改用 --token（门户令牌）或同时给 --cookie <JSESSIONID>")
    else:
        raise SystemExit("需要 --token / --fid+--cookie / --link 三者之一")

    res = reader.fetch(outdir=a.out, name=a.name, resolution=a.resolution,
                       keep_images=not a.no_images, progress=_p)
    _p("完成：%s（%d 页，%.2f MB）" % (res["pdf"], res["pages"],
                                     os.path.getsize(res["pdf"]) / 1048576.0))
    return 0


def cmd_grab(a):
    """全自动：门户检索 -> 取令牌 -> 用 fid 指纹确认是哪一篇 -> 下载全文。"""
    po = portal.Portal()
    recs = po.search(a.keyword)
    _p("门户命中 %d 条" % len(recs))
    if not recs:
        return 1

    if a.index is not None:
        if not 0 <= a.index < len(recs):
            raise SystemExit("--index 超出范围 0..%d" % (len(recs) - 1))
        rec = recs[a.index]
        toks = po.tokens_for(rec)
        if not toks:
            raise SystemExit("第 %d 条没有全文链接" % a.index)
        _p("选中 %02d %s" % (a.index, rec["title"]))
        _p("  令牌 path = %s" % toks[0]["decoded"].get("path"))
        if a.dry_run:
            return 0
        reader = drm.Reader.from_token(toks[0]["token"])
    else:
        target = (a.find_fid or "").lower()
        reader = None
        for i, rec in enumerate(recs):
            toks = po.tokens_for(rec)
            if not toks:
                _p("  %02d 无全文链接/取不到令牌  %s" % (i, rec["title"][:40]))
            for t in toks:
                r = drm.register(t["token"])
                if r["fid"] == target:
                    _p("命中第 %02d 条：%s" % (i, rec["title"]))
                    _p("  fid  = %s（与目标一致）" % r["fid"])
                    _p("  path = %s" % t["decoded"].get("path"))
                    if a.dry_run:
                        return 0
                    reader = drm.Reader(r["fid"], jar=r["jar"])
                    break
            if reader:
                break
        if not reader:
            _p("没有任何记录的 fid 等于 %s" % target)
            return 1

    _p("fid = %s" % reader.fid)
    res = reader.fetch(outdir=a.out, name=a.name, resolution=a.resolution,
                       keep_images=not a.no_images, progress=_p)
    _p("完成：%s（%d 页）" % (res["pdf"], res["pages"]))
    return 0


# --------------------------------------------------------------------------- #
def build_parser():
    ap = argparse.ArgumentParser(
        prog="python -m lzu_fulltext",
        description="兰州大学学位论文门户（.17）+ 版权保护阅读器（.29）全文抓取工具")
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("probe", help="检查 .17 / .29 是否可达")
    p.set_defaults(func=cmd_probe)

    p = sub.add_parser("decode", help="解析一个 DRM 令牌")
    p.add_argument("token")
    p.set_defaults(func=cmd_decode)

    p = sub.add_parser("forge", help="按服务器文件路径伪造令牌（可用 --verify 验证身份）")
    p.add_argument("--path", required=True, help=r"例如 D:\DRM\read\WebRoot\store\xxx.pdf")
    p.add_argument("--startpage", default=1)
    p.add_argument("--endpage", default=1)
    p.add_argument("--down", default=50)
    p.add_argument("--watermark", default="")
    p.add_argument("--filename", default="doc.pdf")
    p.add_argument("--infoname", default="doc")
    p.add_argument("--verify", action="store_true", help="顺便去 .29 注册，看返回的 fid")
    p.set_defaults(func=cmd_forge)

    p = sub.add_parser("verify", help="注册令牌并打印它对应的 fid（身份指纹）")
    p.add_argument("tokens", nargs="+")
    p.add_argument("--timeout", type=int, default=60)
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("search", help="门户按关键词检索")
    p.add_argument("keyword")
    p.add_argument("--json", default="")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("tokens", help="检索并抓出每条记录的 DRM 令牌，写 JSON")
    p.add_argument("keyword")
    p.add_argument("--out", default="tokens.json")
    p.set_defaults(func=cmd_tokens)

    p = sub.add_parser("identify", help="用目标 fid 反查是哪一条记录")
    p.add_argument("fid")
    p.add_argument("--from", dest="from_file", default="tokens.json")
    p.add_argument("--json", default="")
    p.set_defaults(func=cmd_identify)

    p = sub.add_parser("fetch", help="下载全文并合成 PDF")
    p.add_argument("--token", default="", help="门户给的 personaliiifServlet 令牌")
    p.add_argument("--link", default="", help="onlinePDF 链接（含 ?dbid=72&objid=...）")
    p.add_argument("--fid", default="", help="配合 --cookie 使用")
    p.add_argument("--cookie", default="", help="浏览器里的 JSESSIONID")
    p.add_argument("--out", default="out", help="输出目录（默认 out）")
    p.add_argument("--name", default="", help="输出文件名（不含 .pdf）")
    p.add_argument("--resolution", type=float, default=150.0)
    p.add_argument("--timeout", type=int, default=60)
    p.add_argument("--no-images", action="store_true", help="合成后删掉页面图片")
    p.set_defaults(func=cmd_fetch)

    p = sub.add_parser("grab", help="一条龙：检索 → 令牌 → 用 fid 确认 → 下载全文")
    p.add_argument("--keyword", required=True, help="例如 侯扶江 或论文标题")
    p.add_argument("--find-fid", default="", help="目标 fid（pdfindex1.jsp 链接里的那个）")
    p.add_argument("--index", type=int, default=None, help="直接指定检索结果序号")
    p.add_argument("--out", default="out")
    p.add_argument("--name", default="")
    p.add_argument("--resolution", type=float, default=150.0)
    p.add_argument("--no-images", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="只确认是哪一篇，不下载")
    p.set_defaults(func=cmd_grab)
    return ap


def main(argv=None):
    ap = build_parser()
    a = ap.parse_args(argv)
    if not getattr(a, "func", None):
        ap.print_help()
        return 0
    return a.func(a) or 0


if __name__ == "__main__":
    sys.exit(main())
