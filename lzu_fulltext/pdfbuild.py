# -*- coding: utf-8 -*-
"""把一批页面图片合成一个 PDF（Pillow 实现，无额外依赖）。"""
import os


def images_to_pdf(paths, out, resolution=150.0):
    """paths: 图片路径列表（按页序）；out: 输出 PDF 路径。返回 (out, 页数)。

    resolution 只影响 PDF 里写入的物理尺寸标注（150.0 时 A4 版面看起来最自然），
    不改变像素。
    """
    from PIL import Image

    loaded = []
    for p in paths:
        try:
            im = Image.open(p)
            im.load()
            if im.mode != "RGB":
                im = im.convert("RGB")
            loaded.append(im)
        except Exception as e:  # noqa: BLE001
            print("  [warn] 打不开 %s: %s" % (p, e))
    if not loaded:
        raise RuntimeError("没有任何可用页面，无法合成 PDF")
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    loaded[0].save(out, "PDF", save_all=True, append_images=loaded[1:],
                   resolution=resolution)
    for im in loaded:
        try:
            im.close()
        except Exception:
            pass
    return out, len(loaded)


def safe_name(name, fallback="document", limit=80):
    """把文档标题变成安全的文件名。"""
    bad = '\\/:*?"<>|\r\n\t'
    out = "".join("_" if ch in bad else ch for ch in (name or "")).strip(" .")
    return (out or fallback)[:limit]


def md5_file(path, chunk=1 << 20):
    import hashlib

    h = hashlib.md5()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()
