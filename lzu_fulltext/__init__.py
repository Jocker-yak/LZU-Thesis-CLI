# -*- coding: utf-8 -*-
"""lzu_fulltext —— 兰州大学学位论文门户(.17) + 版权保护阅读器(.29) 全文抓取工具。

最短用法：

    from lzu_fulltext import Reader, Portal

    # 1) 知道令牌，直接下全文
    r = Reader.from_token("<personaliiifServlet 令牌>")
    r.fetch(outdir="out")                     # -> out/<标题>.pdf

    # 2) 只有关键词 / fid，全自动
    recs = Portal().search("侯扶江")
    ...
"""
from .drm import Reader, decode_token, encode_token, register, verify_token  # noqa: F401
from .portal import Portal, token_from_link                                 # noqa: F401

__all__ = ["Reader", "Portal", "decode_token", "encode_token", "register",
           "verify_token", "token_from_link"]
__version__ = "1.0"
