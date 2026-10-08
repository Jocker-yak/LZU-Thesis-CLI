# -*- coding: utf-8 -*-
"""gitpush.py —— 不依赖 git 命令的极简 git 推送器。

用途：本机没有安装 git（也没有外网可下载），但要往
    git@gitlab.oceaniaslazycat.heiyu.space:root/LZU-Thesis-CLI.git
提交代码。于是直接用 SSH 跑远端的 `git-receive-pack`，在本地自己
造 blob / tree / commit 对象和 packfile，讲 git 的 v0 传输协议。

支持：
    python tools/gitpush.py --advertise                     # 只看远端有哪些 ref
    python tools/gitpush.py --branch main -m "msg" \\
        --include fulltext.py lzu_fulltext tools README.md .gitignore   # 真推送
    python tools/gitpush.py ... --bundle LZU.bundle         # 顺便导出本地 bundle
    python tools/gitpush.py ... --dry-run                   # 造对象但不连远端

对象格式、tree 排序、pkt-line、pack 头等都是按 git 规范手写的；
sha1 用 hashlib，压缩用 zlib，所以不需要任何第三方库。
"""
from __future__ import annotations

import argparse
import hashlib
import os
import struct
import subprocess
import sys
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SSH_DIR = os.path.join(ROOT, ".ssh")
KEY = os.path.join(SSH_DIR, "id_ed25519_lzu_thesis_cli")
HOST = "gitlab.oceaniaslazycat.heiyu.space"

SSH_BASE = [
    "ssh",
    "-o", "ConnectTimeout=20",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "UserKnownHostsFile=known_hosts",   # 相对路径，避开工作目录里的空格
    "-o", "IdentitiesOnly=yes",
    "-o", "LogLevel=ERROR",
    "-i", KEY,
    "-T",
    "git@" + HOST,
]

T_COMMIT, T_TREE, T_BLOB, T_TAG = 1, 2, 3, 4
TYPENAME = {T_COMMIT: b"commit", T_TREE: b"tree", T_BLOB: b"blob", T_TAG: b"tag"}
ZERO = "0" * 40

# ---------------------------------------------------------------- 对象存储


class ObjStore:
    """收集对象。

    注意：这里存的是**对象内容本身**（不含 `"<type> <size>\\0"` 头），
    因为 packfile 里放的就是内容；而算 sha1 时要用 `头 + 内容`。
    早期版本把带头的内容塞进 pack，导致服务端 index-pack 报
    `bogus commit object`（对象内容里多了一段头，类型/长度全错位）。
    """

    def __init__(self) -> None:
        self.objs: dict[str, tuple[int, bytes]] = {}   # sha -> (type, content)
        self.shas: list[str] = []                      # 插入顺序（不打紧）

    def add(self, typ: int, data: bytes) -> str:
        full = b"%s %d\x00" % (TYPENAME[typ], len(data)) + data
        sha = hashlib.sha1(full).hexdigest()
        if sha not in self.objs:
            self.objs[sha] = (typ, data)
            self.shas.append(sha)
        return sha


def _pack_object(typ: int, data: bytes) -> bytes:
    """packfile 里的一个对象：变长头 + zlib 压缩体（不做 delta）。"""
    size = len(data)
    first = (typ << 4) | (size & 0x0F)
    size >>= 4
    out = bytearray()
    if size:
        first |= 0x80
    out.append(first)
    while size:
        byte = size & 0x7F
        size >>= 7
        if size:
            byte |= 0x80
        out.append(byte)
    out += zlib.compress(data, 6)
    return bytes(out)


def build_pack(store: ObjStore) -> bytes:
    head = b"PACK" + struct.pack(">II", 2, len(store.objs))
    body = bytearray(head)
    for sha in store.shas:
        typ, content = store.objs[sha]
        body += _pack_object(typ, content)
    body += hashlib.sha1(bytes(body)).digest()
    return bytes(body)


def verify_pack(pack: bytes, store: ObjStore) -> list[str]:
    """本地把刚生成的 pack 解回来，逐对象核对 sha / 长度 / 尾部校验和。

    没有 git 命令可以自检，所以这一步很重要：上一次就是这里的编码错误
    直到远端 index-pack 才暴露出来（报 bogus commit object）。
    """
    problems: list[str] = []
    if pack[:4] != b"PACK":
        return ["pack 头不是 PACK"]
    ver, count = struct.unpack(">II", pack[4:12])
    if ver != 2:
        problems.append("pack 版本 %d != 2" % ver)
    if count != len(store.objs):
        problems.append("pack 对象数 %d != 本地 %d" % (count, len(store.objs)))
    pos, seen = 12, set()
    for i in range(count):
        if pos >= len(pack):
            problems.append("第 %d 个对象越界" % i)
            break
        byte = pack[pos]
        pos += 1
        typ = (byte >> 4) & 0x07
        size = byte & 0x0F
        shift = 4
        while byte & 0x80:
            byte = pack[pos]
            pos += 1
            size |= (byte & 0x7F) << shift
            shift += 7
        dec = zlib.decompressobj()
        try:
            content = dec.decompress(pack[pos:])
        except zlib.error as exc:
            problems.append("第 %d 个对象 zlib 解压失败：%s" % (i, exc))
            break
        consumed = len(pack) - pos - len(dec.unused_data)
        pos += consumed
        if len(content) != size:
            problems.append("第 %d 个对象长度 %d != 头里写的 %d" % (i, len(content), size))
        if typ not in TYPENAME:
            problems.append("第 %d 个对象类型非法：%s" % (i, typ))
            continue
        sha = hashlib.sha1(b"%s %d\x00" % (TYPENAME[typ], len(content)) + content).hexdigest()
        if sha not in store.objs:
            problems.append("第 %d 个对象解出来是未知 sha %s" % (i, sha))
        if store.objs.get(sha, (None, None))[0] != typ:
            problems.append("第 %d 个对象类型不符：%s" % (i, sha))
        seen.add(sha)
    if len(seen) != len(store.objs):
        problems.append("pack 里只覆盖了 %d/%d 个对象" % (len(seen), len(store.objs)))
    if pack[-20:] != hashlib.sha1(pack[:-20]).digest():
        problems.append("pack 尾部 sha1 校验和不符")
    return problems


# ---------------------------------------------------------------- 工作区扫描


def scan(root: str, includes: list[str]) -> list[str]:
    """返回仓库内的相对路径（POSIX 风格）列表。"""
    found: set[str] = set()
    for inc in includes:
        p = os.path.join(root, inc)
        if os.path.isfile(p):
            found.add(os.path.relpath(p, root).replace("\\", "/"))
        elif os.path.isdir(p):
            for dirpath, dirnames, filenames in os.walk(p):
                dirnames[:] = [d for d in dirnames if d not in (".git", "__pycache__")]
                for fn in filenames:
                    if fn.endswith((".pyc", ".pyo")):
                        continue
                    ap = os.path.join(dirpath, fn)
                    found.add(os.path.relpath(ap, root).replace("\\", "/"))
        else:
            print("!! 路径不存在，已跳过：%s" % inc, file=sys.stderr)
    return sorted(found)


def make_tree(node: dict, store: ObjStore) -> str:
    items = []
    for name, val in node.items():
        if isinstance(val, dict):
            items.append((name, b"40000", make_tree(val, store)))
        else:
            items.append((name, b"100644", store.add(T_BLOB, val)))
    # git 的 tree 排序：目录按 “名字 + /” 参与比较
    items.sort(key=lambda t: t[0].encode() + (b"/" if t[1] == b"40000" else b""))
    data = b"".join(mode + b" " + name.encode() + b"\x00" + bytes.fromhex(sha)
                    for name, mode, sha in items)
    return store.add(T_TREE, data)


def build_commit(root: str, includes: list[str], message: str,
                 author: str, email: str, parent: str | None) -> tuple[ObjStore, str, str, int]:
    store = ObjStore()
    files = scan(root, includes)
    tree: dict = {}
    total = 0
    for rel in files:
        ap = os.path.join(root, rel)
        with open(ap, "rb") as fh:
            data = fh.read()
        total += len(data)
        node = tree
        parts = rel.split("/")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = data

    tree_sha = make_tree(tree, store)
    ts = int(time.time())
    tz = time.strftime("%z") or "+0800"
    ident = ("%s <%s> %d %s" % (author, email, ts, tz)).encode()
    body = b"tree " + tree_sha.encode() + b"\n"
    if parent:
        body += b"parent " + parent.encode() + b"\n"
    body += b"author " + ident + b"\n"
    body += b"committer " + ident + b"\n\n"
    body += message.encode("utf-8").rstrip(b"\n") + b"\n"
    commit_sha = store.add(T_COMMIT, body)
    return store, commit_sha, tree_sha, total


# ---------------------------------------------------------------- pkt-line


def pkt(data: bytes) -> bytes:
    return b"%04x" % (len(data) + 4) + data


FLUSH = b"0000"


def read_exact(stream, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            raise EOFError("连接提前结束（已读 %d/%d 字节）" % (len(buf), n))
        buf += chunk
    return buf


def read_pkt(stream) -> bytes | None:
    hdr = read_exact(stream, 4)
    n = int(hdr, 16)
    if n == 0:
        return None                      # flush-pkt
    if n in (1, 2):
        return b""                       # delim / response-end
    return read_exact(stream, n - 4)


def read_advertisement(stream):
    refs: dict[str, str] = {}
    caps: set[bytes] = set()
    while True:
        line = read_pkt(stream)
        if line is None:
            break
        if line.startswith(b"version "):
            continue
        line = line.rstrip(b"\n")
        sha, _, rest = line.partition(b" ")
        if b"\x00" in rest:
            name, _, capstr = rest.partition(b"\x00")
            caps |= set(capstr.split())
        else:
            name = rest
        refs[name.decode()] = sha.decode()
    return refs, caps


# ---------------------------------------------------------------- 主流程


def push(remote: str, branch: str, store: ObjStore, commit_sha: str,
         force_parent: str | None, dry_run: bool) -> int:
    refname = "refs/heads/" + branch
    cmd = "git-receive-pack '%s'" % remote
    print("→ ssh %s  %s" % (HOST, cmd))
    proc = subprocess.Popen(SSH_BASE + [cmd], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            cwd=SSH_DIR)
    try:
        refs, caps = read_advertisement(proc.stdout)
    except Exception as exc:
        proc.kill()
        print("!! 读取远端 ref 失败：%s" % exc, file=sys.stderr)
        return 1

    print("远端 ref：")
    for name, sha in refs.items():
        print("   %s %s" % (sha, name))
    if not refs:
        print("   （空仓库）")
    print("远端能力：%s" % " ".join(sorted(c.decode(errors="replace") for c in caps)))

    old = refs.get(refname, ZERO)
    parent = force_parent if force_parent is not None else (old if old != ZERO else None)
    print("\n分支 %s：old=%s  new=%s" % (branch, old, commit_sha))
    print("父提交：%s" % (parent or "（无，全新历史）"))

    if dry_run:
        proc.kill()
        print("--dry-run：不发送任何数据")
        return 0

    pack = build_pack(store)
    problems = verify_pack(pack, store)
    if problems:
        print("!! 本地 pack 自检失败，已中止（避免又让远端 index-pack 报错）：", file=sys.stderr)
        for p in problems:
            print("   - %s" % p, file=sys.stderr)
        proc.kill()
        return 1
    print("本地 pack 自检通过：%d 个对象，%d 字节" % (len(store.objs), len(pack)))

    cap_list = []
    if b"report-status" in caps:
        cap_list.append("report-status")
    cap_list.append("agent=gitpush.py/1.0")
    command = ("%s %s %s" % (old, commit_sha, refname)).encode() + b"\x00" + \
              " ".join(cap_list).encode() + b"\n"
    payload = pkt(command) + FLUSH + pack
    try:
        proc.stdin.write(payload)
        proc.stdin.flush()
        proc.stdin.close()
    except Exception as exc:
        print("!! 发送 pack 失败：%s" % exc, file=sys.stderr)
        proc.kill()
        return 1

    out = proc.stdout.read()
    err = proc.stderr.read()
    proc.wait(timeout=120)
    if err.strip():
        print("远端 stderr：%s" % err.decode(errors="replace").strip())

    # 解析 report-status
    stream = _BytesReader(out)
    ok = False
    status_lines = []
    try:
        while True:
            line = read_pkt(stream)
            if line is None:
                break
            status_lines.append(line.decode(errors="replace").rstrip("\n"))
    except EOFError:
        pass
    for line in status_lines:
        print("远端：%s" % line)
        if line.startswith("unpack ok"):
            ok = True
        if line.startswith("ng "):
            ok = False
    if not status_lines:
        print("远端没有返回 report-status，退出码 %s" % proc.returncode)
        ok = proc.returncode == 0
    return 0 if ok else 1


class _BytesReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def read(self, n: int) -> bytes:
        chunk = self.data[self.pos:self.pos + n]
        self.pos += len(chunk)
        return chunk


def write_bundle(path: str, commit_sha: str, branch: str, store: ObjStore) -> None:
    with open(path, "wb") as fh:
        fh.write(b"# v2 git bundle\n")
        fh.write(("%s refs/heads/%s\n" % (commit_sha, branch)).encode())
        fh.write(b"\n")
        fh.write(build_pack(store))
    print("本地 bundle 已写出：%s（以后装了 git 可以 git clone %s）" % (path, path))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="无 git 依赖的极简 push")
    ap.add_argument("--remote", default="root/LZU-Thesis-CLI.git")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--root", default=ROOT)
    ap.add_argument("--include", nargs="*", default=[
        "fulltext.py", "lzu_fulltext", "legacy", "tools", "README.md", ".gitignore"])
    ap.add_argument("-m", "--message", default="Import LZU thesis fulltext CLI")
    ap.add_argument("--author", default="oceanias")
    ap.add_argument("--email", default="oceanias@oceaniaslazycat.heiyu.space")
    ap.add_argument("--parent", default=None, help="指定父提交 sha（默认取远端同名分支）")
    ap.add_argument("--bundle", default=None)
    ap.add_argument("--advertise", action="store_true", help="只列远端 ref，不推送")
    ap.add_argument("--dry-run", action="store_true", help="造对象但不发送")
    args = ap.parse_args(argv)

    if args.advertise:
        store = ObjStore()
        return push(args.remote, args.branch, store, ZERO, None, True)

    store, commit_sha, tree_sha, total = build_commit(
        args.root, args.include, args.message, args.author, args.email, None)

    # 远端分支存在时，把它的 sha 当作父提交重新造一次 commit
    refname = "refs/heads/" + args.branch
    if args.parent is None:
        print("先探一次远端 ref 以确定父提交 …")
        probe = subprocess.Popen(SSH_BASE + ["git-receive-pack '%s'" % args.remote],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, cwd=SSH_DIR)
        try:
            refs, _ = read_advertisement(probe.stdout)
        except Exception:
            refs = {}
        probe.kill()
        remote_head = refs.get(refname, ZERO)
        if remote_head != ZERO:
            args.parent = remote_head

    if args.parent:
        store, commit_sha, tree_sha, total = build_commit(
            args.root, args.include, args.message, args.author, args.email, args.parent)

    print("仓库对象：%d 个，工作区 %d 字节，tree=%s" % (len(store.objs), total, tree_sha))
    print("commit   ：%s" % commit_sha)
    print("文件清单：")
    for rel in scan(args.root, args.include):
        print("   %s" % rel)

    if args.bundle:
        write_bundle(args.bundle, commit_sha, args.branch, store)

    print()
    return push(args.remote, args.branch, store, commit_sha, args.parent, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
