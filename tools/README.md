# tools/ —— 这台机器上没有 git 时怎么推代码

本机（Windows）**没有安装 git，也不能上外网**，所以下载不了 portable-git。
但 GitLab 的 SSH 是通的，于是这里用 Python 标准库直接讲 git 的传输协议：
自己造 blob / tree / commit 对象、自己生成 packfile、自己跑 `git-receive-pack`。

| 文件 | 作用 |
| --- | --- |
| `gitpush.py` | 把工作区里指定的文件打包成一个提交，推到远端（等价于 `git add/commit/push`） |
| `gitverify.py` | 用 `git-upload-pack` 把远端的分支拉回来，解压还原 delta，逐字节核对文件内容 |

## 依赖

* Python 3.8+，只用标准库（`hashlib` / `zlib` / `subprocess`）。
* 一把能访问该 GitLab 的 SSH 私钥，默认取 `../.ssh/id_ed25519_lzu_thesis_cli`
  （可用 `SSH_BASE` 改；本机私钥不在仓库里）。
* 工作目录 `../.ssh/known_hosts` 里要有该主机的 host key（用相对路径传参，
  是为了绕开工作目录名里带空格导致 ssh 解析配置出错的问题）。

## 用法

```powershell
# 只看远端有哪些分支
python tools/gitpush.py --advertise

# 造对象但不发送
python tools/gitpush.py --dry-run

# 真推送（默认分支 main；远端已有同名分支时自动接在它后面，不覆盖历史）
python tools/gitpush.py -m "提交说明"

# 顺便导出一个本地 bundle，装了 git 之后可以 git clone xxx.bundle
python tools/gitpush.py --bundle ..\LZU-Thesis-CLI.bundle -m "提交说明"

# 拉回来核对（会打印每个文件是否与本地逐字节一致）
python tools/gitverify.py
```

## 踩过的坑

* **pack 里放的是对象内容，不是带 `"<type> <size>\0"` 头的那一坨**。
  一开始把头也算进长度一起塞进 pack，远端 `index-pack` 直接报
  `error: bogus commit object ...` / `fatal: invalid commit`。
  现在 `gitpush.py` 里加了 `verify_pack()` 本地自检（解回来核对 sha / 长度 / 尾部校验和），
  这类错误在本地就会拦住，不会再跑到远端才炸。
* `time.strftime("%z")` 在 Windows 上返回 `+0800`（正常），但 `%Z` 返回的是
  本地化的时区名（"马来西亚半岛标准时间"），不能拿来拼 author 行。
* `ssh -o UserKnownHostsFile=<带空格的路径>` 会被 ssh 配置解析器截断到空格处，
  所以 `gitpush.py` 用 `cwd=<.ssh 目录>` + 相对路径 `known_hosts` 绕开。
* GitLab 默认开了 `receive.fsckObjects`，对象稍有问题就会被拒；推送前务必本地自检。
