# -*- coding: utf-8 -*-
"""gitverify.py —— 不依赖 git 命令，把推上去的提交从远端拉回来核对。

做法：直接用 SSH 跑远端 `git-upload-pack`，说 git 的 v0 传输协议，
拿到 packfile，在本地解压 + 还原 delta，然后从 commit → tree → blob
一路走下来，把每个文件的内容和本地工作区逐字节比对。

    python tools/gitverify.py                 # 核对远端 refs/heads/main
    python tools/gitverify.py --show-tree     # 顺便打印远端树形结构
"""
from __future__ import annotations

import argparse
import hashlib
import os
import struct
import subprocess
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gitpush import (  # noqa: E402
    ROOT, SSH_DIR, SSH_BASE, TYPENAME,
    T_BLOB, T_COMMIT, T_TAG, T_TREE, read_advertisement, pkt, FLUSH, read_pkt,
)

T_OFS_DELTA, T_REF_DELTA = 6, 7


# ---------------------------------------------------------------- pack 解析


def parse_pack(data: bytes):
    """把 packfile 拆成 {offset: entry}，delta 暂不还原。"""
    if data[:4] != b"PACK":
        raise ValueError("不是 packfile：%r" % data[:8])
    ver, count = struct.unpack(">II", data[4:12])
    if ver not in (2, 3):
        raise ValueError("pack 版本 %d 不支持" % ver)
    pos = 12
    entries: dict[int, dict] = {}
    for _ in range(count):
        start = pos
        byte = data[pos]
        pos += 1
        typ = (byte >> 4) & 0x07
        size = byte & 0x0F
        shift = 4
        while byte & 0x80:
            byte = data[pos]
            pos += 1
            size |= (byte & 0x7F) << shift
            shift += 7
        entry = {"type": typ, "size": size, "offset": start}
        if typ == T_OFS_DELTA:
            byte = data[pos]
            pos += 1
            off = byte & 0x7F
            while byte & 0x80:
                byte = data[pos]
                pos += 1
                off = ((off + 1) << 7) | (byte & 0x7F)
            entry["base_offset"] = start - off
        elif typ == T_REF_DELTA:
            entry["base_sha"] = data[pos:pos + 20].hex()
            pos += 20
        dec = zlib.decompressobj()
        entry["raw"] = dec.decompress(data[pos:])
        pos += (len(data) - pos) - len(dec.unused_data)
        entries[start] = entry
    return entries


def _varint(buf: bytes, pos: int):
    val = shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        val |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return val, pos


def apply_delta(base: bytes, delta: bytes) -> bytes:
    src_size, pos = _varint(delta, 0)
    dst_size, pos = _varint(delta, pos)
    if src_size != len(base):
        raise ValueError("delta 里的 base 大小 %d != 实际 %d" % (src_size, len(base)))
    out = bytearray()
    while pos < len(delta):
        op = delta[pos]
        pos += 1
        if op & 0x80:                       # copy
            cp_off = cp_size = 0
            for i in range(4):
                if op & (1 << i):
                    cp_off |= delta[pos] << (8 * i)
                    pos += 1
            for i in range(3):
                if op & (1 << (4 + i)):
                    cp_size |= delta[pos] << (8 * i)
                    pos += 1
            if cp_size == 0:
                cp_size = 0x10000
            out += base[cp_off:cp_off + cp_size]
        elif op:                            # insert
            out += delta[pos:pos + op]
            pos += op
        else:
            raise ValueError("delta 里出现非法操作码 0")
    if len(out) != dst_size:
        raise ValueError("delta 结果大小 %d != 声明 %d" % (len(out), dst_size))
    return bytes(out)


def resolve_all(entries: dict[int, dict]) -> dict[int, tuple[int, bytes]]:
    """把 delta 全部还原成 (type, content)。"""
    resolved: dict[int, tuple[int, bytes]] = {}
    by_sha: dict[str, int] = {}
    pending = dict(entries)
    while pending:
        progress = False
        for off in list(pending):
            e = pending[off]
            typ = e["type"]
            if typ in (T_COMMIT, T_TREE, T_BLOB, T_TAG):
                resolved[off] = (typ, e["raw"])
            elif typ == T_OFS_DELTA:
                base = resolved.get(e["base_offset"])
                if base is None:
                    continue
                resolved[off] = (base[0], apply_delta(base[1], e["raw"]))
            elif typ == T_REF_DELTA:
                boff = by_sha.get(e["base_sha"])
                if boff is None:
                    continue
                resolved[off] = (resolved[boff][0], apply_delta(resolved[boff][1], e["raw"]))
            else:
                raise ValueError("未知对象类型 %d" % typ)
            sha = hashlib.sha1(b"%s %d\x00" % (TYPENAME[resolved[off][0]],
                                               len(resolved[off][1])) + resolved[off][1]).hexdigest()
            by_sha[sha] = off
            del pending[off]
            progress = True
        if not progress:
            raise ValueError("delta 还原卡住了，剩余 %d 个对象（缺 base？）" % len(pending))
    return resolved


# ---------------------------------------------------------------- upload-pack


def open_upload_pack(remote: str):
    cmd = "git-upload-pack '%s'" % remote
    proc = subprocess.Popen(SSH_BASE + [cmd], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=SSH_DIR)
    refs, caps = read_advertisement(proc.stdout)
    return proc, refs, caps


# ---------------------------------------------------------------- 走树比对


def walk_tree(content: bytes):
    """返回 [(mode, name, sha)]。"""
    out = []
    pos = 0
    while pos < len(content):
        sp = content.index(b" ", pos)
        mode = content[pos:sp].decode()
        nul = content.index(b"\x00", sp)
        name = content[sp + 1:nul].decode("utf-8", "surrogateescape")
        sha = content[nul + 1:nul + 21].hex()
        out.append((mode, name, sha))
        pos = nul + 21
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--remote", default="root/LZU-Thesis-CLI.git")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--root", default=ROOT)
    ap.add_argument("--show-tree", action="store_true")
    args = ap.parse_args(argv)

    cmd = "git-upload-pack '%s'" % args.remote
    proc, refs, caps = open_upload_pack(args.remote)
    print("→ ssh %s  %s" % (SSH_BASE[-1].split("@")[-1], cmd))
    print("远端 refs：")
    for name, sha in refs.items():
        print("   %s %s" % (sha, name))
    want = refs.get("refs/heads/" + args.branch)
    if not want:
        proc.kill()
        print("!! 远端没有 refs/heads/%s" % args.branch, file=sys.stderr)
        return 1

    proc.stdin.write(pkt(("want %s ofs-delta agent=gitverify.py/1.0\n" % want).encode())
                     + FLUSH + pkt(b"done\n"))
    proc.stdin.flush()
    proc.stdin.close()
    try:
        first = read_pkt(proc.stdout)
    except EOFError:
        first = b""
    print("协商：%s" % (first or b"").decode(errors="replace").strip())
    pack = proc.stdout.read()
    err = proc.stderr.read()
    proc.wait(timeout=120)
    if err.strip():
        print("stderr: %s" % err.decode(errors="replace").strip())
    print("收到 pack：%d 字节" % len(pack))

    entries = parse_pack(pack)
    resolved = resolve_all(entries)
    print("解析出 %d 个对象（其中 delta %d 个）"
          % (len(resolved), sum(1 for e in entries.values() if e["type"] in (6, 7))))

    # sha 索引
    by_sha: dict[str, tuple[int, bytes]] = {}
    for off, (typ, content) in resolved.items():
        sha = hashlib.sha1(b"%s %d\x00" % (TYPENAME[typ], len(content)) + content).hexdigest()
        by_sha[sha] = (typ, content)

    commit = by_sha.get(want)
    if commit is None:
        print("!! 拿回来的 pack 里没有提交 %s" % want, file=sys.stderr)
        return 1
    ctyp, cbody = commit
    text = cbody.decode("utf-8", "replace")
    head = text.split("\n\n", 1)[0]
    print("\n=== 远端提交 %s ===" % want)
    for line in head.splitlines():
        print("   %s" % line)

    tree_sha = [l.split()[1] for l in head.splitlines() if l.startswith("tree ")][0]
    problems: list[str] = []
    checked = 0

    def walk(sha: str, prefix: str):
        nonlocal checked
        typ, content = by_sha[sha]
        if typ != T_TREE:
            problems.append("%s 不是 tree（type=%d）" % (sha, typ))
            return
        if args.show_tree:
            print("  %s/" % (prefix or "."))
        for mode, name, csha in walk_tree(content):
            path = prefix + name
            if mode == "40000":
                walk(csha, path + "/")
                continue
            if csha not in by_sha:
                problems.append("%s：远端缺对象 %s" % (path, csha))
                continue
            btyp, bcontent = by_sha[csha]
            if btyp != T_BLOB:
                problems.append("%s：对象类型不是 blob" % path)
                continue
            local = os.path.join(args.root, path.replace("/", os.sep))
            if not os.path.isfile(local):
                problems.append("%s：本地没有这个文件" % path)
                continue
            with open(local, "rb") as fh:
                ldata = fh.read()
            if ldata != bcontent:
                problems.append("%s：内容不一致（远端 %d 字节 / 本地 %d 字节）"
                                % (path, len(bcontent), len(ldata)))
            else:
                checked += 1
                print("   ✓ %-40s %7d 字节  %s" % (path, len(bcontent), csha[:12]))

    walk(tree_sha, "")

    print("\n=== 结论 ===")
    print("逐字节一致的文件：%d 个" % checked)
    if problems:
        print("问题 %d 条：" % len(problems))
        for p in problems:
            print("   ✗ %s" % p)
        return 1
    print("远端 refs/heads/%s = %s，内容与本地工作区完全一致 ✅" % (args.branch, want))
    return 0


if __name__ == "__main__":
    sys.exit(main())
