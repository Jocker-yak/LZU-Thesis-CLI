# lzu_fulltext —— 学位论文门户 + DRM 阅读器全文抓取工具

把兰州大学学位论文管理系统（`202.201.7.17`）里"查看全文"打开的、**版权保护阅读器**
（`202.201.7.29`）渲染出来的页面，逐页抓下来合成一个可以在任何阅读器里看的 PDF。

站点没有可用的原始 PDF 下载通道（`downloadServlet` 报 500、`/store/` 被
`alert('不能打开！')` 拦截、`pdfoffServlet` 404），所以拿到的只能是**渲染位图**，
分辨率约 144 dpi，并且带站点水印。这是能做到的最好结果。

---

## 1. 环境

* Python 3.8+（只用标准库即可完成检索/取页）
* 合成 PDF 需要 **Pillow**：`pip install pillow`
* 无需浏览器。

```powershell
python fulltext.py probe        # 先看两台服务器在不在
# 门户 .17  -> 200
# 阅读器 .29 -> 200
```

---

## 2. fid 是什么？怎么拿到？

`fid` 是本工具里**唯一可靠的身份标识**，也是一切下载入口的钥匙。先把这一节看完，
后面就不会卡在"这个字段是哪来的"。

### 2.1 它是什么

`fid` = **原始 PDF 文件字节的 MD5**，32 位小写十六进制。

实测证据：自己造一个 3 页 PDF（`md5 = 1261a0336915cef52a5e5752b4ca2f92`），
把它放到阅读器的 `D:\DRM\read\WebRoot\store\test.pdf`，注册后服务器返回的 fid 正是
`1261a0336915cef52a5e5752b4ca2f92`；反过来把这个文件改名成它的 md5
（`store\1261a033….pdf`）再注册，服务器报 500 `FileNotFoundException`。
→ 认的是**文件内容**，不是文件名、也不是路径。

### 2.2 为什么只能用它

服务器每次请求都会把 PDF 重新落一份带随机名的副本，同一个文件在不同时刻的 `path` 是：

```
D:\DRM\read\WebRoot\store\jnf0wg….pdf
D:\DRM\read\WebRoot\store\oe5o3rm….pdf
D:\DRM\read\WebRoot\store\nspt1u….pdf
```

而 fid 始终是 `5cff3489f0c23900f886634fffe22fff`。所以：
**认文档只认 fid；`path`、`filename`、令牌都会变，都不能当身份。**

### 2.3 怎么拿到（四条路）

| 办法 | 怎么做 |
| --- | --- |
| ① 浏览器地址栏 | 打开全文的那一页，地址栏就是 `…/pdfindex1.jsp?fid=5cff3489f0c23900f886634fffe22fff`，抄那 32 位 |
| ② **不知道就查（推荐）** | `python fulltext.py fids "侯扶江"` —— 检索门户、逐条注册令牌，把每条记录对应的 fid 列出来 |
| ③ 已有令牌 | `python fulltext.py verify <令牌>` —— 注册这个令牌，打印它的 fid |
| ④ 有原始 PDF 文件 | 文件本身就是答案：`certutil -hashfile 论文.pdf MD5`（Linux/macOS：`md5sum 论文.pdf`） |

`fids` 的实跑输出：

```powershell
python fulltext.py fids "补播白刺花"

# 门户命中 1 条
#   00  fid=5cff3489f0c23900f886634fffe22fff 补播白刺花和施厩肥对两种暖季型草地土壤理化性质和生产力的影响
#   00  fid=注册失败                             补播白刺花和施厩肥对两种暖季型草地土壤理化性质和生产力的影响
#
# 序号    fid                               标题
# 00      5cff3489f0c23900f886634fffe22fff 补播白刺花和施厩肥对两种暖季型草地土壤理化性质和生产力的影响
# 00      注册失败                             补播白刺花和施厩肥对两种暖季型草地土壤理化性质和生产力的影响
#
# 共 1 条记录，1 个可用 fid。
```

（这条记录挂了 2 个令牌，另一个指向服务器上已不存在的 `_free.pdf`，所以显示"注册失败"；
一个令牌注册失败不影响其他令牌。）

不想先查也行：`grab` 不传 `--find-fid` / `--index` 时会**自动列出候选和它们的 fid**，
只有一条有全文时直接自动选中：

```powershell
python fulltext.py grab --keyword 侯扶江 --dry-run

# 门户命中 20 条
# 有 14 条记录都有全文，请指定要哪一条：
#   05  fid=5cff3489f0c23900f886634fffe22fff  补播白刺花和施厩肥对两种暖季型草地土壤理化性质和生产力的影响
#   07  fid=970f3a4ec5c821b35189e2c55b97df91  饲养模式影响牦牛肉品质与风味的作用机理
#   …（共 14 条）
# → 加 --index <序号> 或 --find-fid <fid> 重跑
```

> `--index` 用的是**同一关键词**下 `search` 的序号。`fids "A"` 得到序号 5，
> 就只能在 `grab --keyword "A" --index 5` 里用；换关键词序号会变。
> 另外 `fids` 每条记录都要发一次注册请求，20 来条跑十几秒属正常。

---

## 3. 三种用法，挑一种

### 用法 A：只知道论文/作者，想全自动（推荐）

```powershell
# 1) 关键词够特别（比如整条标题）：会自动选中唯一那条有全文的记录
python fulltext.py grab --keyword "补播白刺花和施厩肥对两种暖季型草地土壤理化性质和生产力的影响" --out out

# 2) 关键词太宽（比如只有导师名）：先看清单，再用序号或 fid 指定
python fulltext.py fids "侯扶江"
python fulltext.py grab --keyword "侯扶江" --index 5 --out out
python fulltext.py grab --keyword "侯扶江" --find-fid 5cff3489f0c23900f886634fffe22fff --out out

# 3) 只确认"是哪一篇"，不下载
python fulltext.py grab --keyword 侯扶江 --find-fid 5cff3489f0c23900f886634fffe22fff --dry-run
```

产物：`out/<论文标题>.pdf`，页面图片留在 `out/pages/<fid前8位>/`（`--no-images` 可删）。

### 用法 B：手上已经有一个 DRM 令牌

令牌形如 `QjPoURCUzQSU1Q0RSTSU1Q3JlYWQlNUNXZWJSb290...`，来自门户跳转地址里的
`personaliiifServlet?path=<令牌>`。

```powershell
python fulltext.py fetch --token <令牌> --out out
python fulltext.py decode <令牌>          # 先看看它指向哪个文件、哪几页
python fulltext.py verify <令牌>          # 顺便看看它的 fid
```

### 用法 C：浏览器里已经打开了全文，不想折腾网络

在能看到全文的那个阅读页面按 `F12` → Console，把
[`browser-console.js`](browser-console.js) 全文粘贴进去回车，会直接下载 `fulltext.pdf`。
（脚本从页面隐藏域读 fid/pageCount，调 `jumpServlet` 取图，用 CDN 上的 jsPDF 合成；
若浏览器拦截下载，它会把所有页面地址复制到剪贴板。）
**不想写脚本的话**：那一页的地址栏里 `fid=` 后面那 32 位就是 fid。

### 用法 D：从门户链接直接抓

```powershell
python fulltext.py fetch --link "onlinePDF?dbid=72&objid=55_55_55_57_56_49&flag=online" --out out
```

---

## 4. 完整命令表

| 命令 | 作用 |
| --- | --- |
| `probe` | 检查 `.17` / `.29` 是否可达 |
| `decode <token>` | 解析令牌 → path / startpage / endpage / filename / infoname |
| `forge --path <P> [--verify]` | 按服务器文件路径伪造令牌；`--verify` 顺便注册看 fid |
| `verify <token>…` | 注册令牌并打印对应的 fid（身份指纹） |
| `search <关键词> [--json f]` | 门户检索，列出 `id1/id2/标题` |
| `fids <关键词> [--from f.json]` | **列出每条记录对应的 fid**（不知道 fid 时先跑这个） |
| `tokens <关键词> --out f.json` | 检索 + 逐条抽 DRM 令牌，写 JSON |
| `identify <fid> [--from f.json]` | 用 fid 反查是哪一条记录 |
| `fetch (--token\|--link\|--fid+--cookie)` | 下载全文并合成 PDF |
| `grab --keyword K [--find-fid F\|--index N]` | 一条龙：检索 → 令牌 → fid 确认 → 下载 |

`fetch` / `grab` 通用参数：`--out 目录`（默认 `out`）、`--name 文件名`、
`--resolution 150`、`--no-images`（不保留页面图片）、`--dry-run`（只确认不下载，仅 `grab`）。
`fids` 另有 `--limit N`（最多处理前 N 条记录）与 `--json f.json`。

---

## 5. 常用流程（组合命令）

```powershell
# 1) 把某位导师名下所有论文的全文令牌都抓出来
python fulltext.py tokens 侯扶江 --out tokens.json

# 2) 不知道 fid：直接列出每条记录的 fid（读已有 JSON，不再访问门户）
python fulltext.py fids --from tokens.json

# 3) 反过来，已知 fid 想知道是哪一条记录
python fulltext.py identify 5cff3489f0c23900f886634fffe22fff --from tokens.json

# 4) 下载命中那一条
python fulltext.py grab --keyword 侯扶江 --find-fid 5cff3489f0c23900f886634fffe22fff --out out
```

`tokens.json` 结构：

```json
[
  {"id1": "7815c931...", "id2": "m6Mz4VdaxFE%3D", "title": "补播白刺花…",
   "links": ["onlinePDF?dbid=72&objid=55_55_55_57_56_49&flag=online"],
   "tokens": [{"token": "QjPoUR…", "link": "onlinePDF?…",
               "decoded": {"path": "D:\\DRM\\read\\WebRoot\\store\\xxx.pdf",
                           "filename": "262010_220220931930_示例作者.pdf",
                           "infoname": "补播白刺花…", "startpage": "1",
                           "endpage": "2000", "down": "50", "watermark": ""}}]}
]
```

---

## 6. 当作 Python 库用

```python
import sys; sys.path.insert(0, r"<仓库目录>")
from lzu_fulltext import Reader, Portal, decode_token, encode_token

# 知道令牌
r = Reader.from_token("<令牌>")
print(r.fid, r.page_count, r.infoname)
res = r.fetch(outdir="out")            # {'pdf': ..., 'pages': 84, ...}

# 只知道关键词 + fid
po = Portal()
recs = po.search("侯扶江")
for i, rec in enumerate(recs):
    for t in po.tokens_for(rec):
        reg = Reader.from_token(t["token"])
        if reg.fid == "5cff3489f0c23900f886634fffe22fff":
            reg.fetch(outdir="out")
```

其他常用 API：

* `Reader.from_session(fid, jsessionid)` —— 复用浏览器会话（F12 → Application → Cookies）
* `Reader.page_urls()` / `Reader.download_pages(dir)` —— 只要图、先不合成
* `Reader.load_meta()` —— 读 pageCount / filename / infoname / watermark
* `drm.register(token)` —— 底层注册，返回 `{fid, jar, jsessionid, status, location}`
* `drm.encode_token(path, ...)` —— 伪造令牌（用来验证某个服务器路径属于哪篇文档）
* `drm.md5_file(path)` —— 本地文件的 MD5，也就是它的 fid
* `pdfbuild.images_to_pdf(paths, out)` —— 任意图片列表 → PDF

---

## 7. 原理速查（想改代码时看这里）

1. **fid = 原 PDF 文件字节的 MD5**（证据见第 2 节）。拿令牌注册后，服务器返回的
   `Location` 里就带着它，所以可以用 fid 精确判断"这一条记录是不是我要的那篇"，
   而不用先下载。
2. **文档是会话级的**。`GET /personaliiifServlet?path=<令牌>` → 302 到
   `/pdfindex1.jsp?fid=<fid>` 并下发 `JSESSIONID`；换个会话直接访问
   `pdfindex1.jsp?fid=…` 所有隐藏域都是 `null`。这就是"原链接打开一片空白"的原因。
3. **令牌格式**：
   `5 个随机 base64 字符 + base64( quote(path,"") + "&startpage=..&endpage=..&down=..&watermark=..&filename=..&infoname=.." )`
   `path` 形如 `D:\DRM\read\WebRoot\store\<随机名>.pdf`。
   **每次请求门户，随机名都会变**，所以 path 不能当身份；fid 才能。
4. **取页**：`GET /jumpServlet?page=N&fid=<fid>` 返回
   `{"list":[{"id":"N","src":".../pdfboxServlet?page=<64位hex>"}]}`，每次只给 N 附近一小段，
   所以要从 0 循环到 pageCount 合并去重。
5. **下页**：`GET /pdfboxServlet?page=<64位hex>` 直接吐 JPEG，**不需要 Cookie**。
   令牌失效时返回 500（`pdfboxServlet.java:35` NPE）。
6. **门户链接**：`/onlinePDF?dbid=72&objid=<ASCII码用下划线连>&flag=online` → 302 到
   `.29/personaliiifServlet?path=<令牌>`。`objid` 例如 `55_55_55_57_56_49` → `"777981"`。
   `state=free` 那个链接指向另一份 `_free.pdf`，一般用 `flag=online` 那个。
   **请求这个链接必须带门户会话**（先访问检索页），否则拿不到令牌。

---

## 8. 限制与注意事项

* 拿到的是**图片版 PDF**：文字不可选、不可复制；要 OCR 请自己再过一遍。
* 每页带站点水印（通常是访问者 IP + 时间）。试过按亮度曲线淡化，图表线条会一起变淡，
  所以保留原样。
* `/store/` 下的原始 PDF 无法直取；`downloadServlet`、`pdfoffServlet` 都是坏的。
* 令牌和 `JSESSIONID` 有时效，且 `.29` 偶尔会短暂连不上（重试即可；本工具自带 4 次重试）。
* 服务器端会为每次请求重新分配 store 文件名，别把 `path` 写死到代码里。
* 请只在你有权访问的范围内使用（本人可访问的馆藏 / 已获授权），不要批量转发。

---

## 9. 目录结构

```
fulltext.py                 便捷入口（等价于 python -m lzu_fulltext）
lzu_fulltext/
  __init__.py               对外 API
  __main__.py               python -m lzu_fulltext
  cli.py                    命令行实现（10 个子命令）
  net.py                    HTTP 工具（Cookie / 不跟随 302 / 重试 / 健康检查）
  drm.py                    .29 阅读器客户端 + 令牌编解码
  portal.py                 .17 门户客户端（检索 / 取令牌）
  pdfbuild.py               图片 → PDF
  browser-console.js        浏览器控制台一键版（用法 C）
  README.md                 本文件
legacy/                     早期探索脚本（功能已并入上面，仅作参考）
tools/                      本机没有 git 时用来推送/回拉校验的脚本（见 tools/README.md）
```

> 开发机上另有 `probe/`（调试证据）、`pages/`（已下载页面图）、`tokens*.json`（门户令牌快照），
> 都含时效凭证或大体积二进制，**不在仓库里**（见 `.gitignore`）。

---

## 10. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `pdfindex1.jsp 字段全是 null` | 该 fid 没在当前会话注册过。用 `--token` 自助注册，或 `--fid`+`--cookie` 复用浏览器会话 |
| 不知道 `--find-fid` 填什么 | 跑 `fids <关键词>` 看清单（第 2 节）；或者干脆不填，`grab` 会自己列候选 |
| `grab` 列出好几条候选 | 关键词太宽（例如只有导师名）。加 `--index N` 或 `--find-fid <fid>` |
| `注册失败：personaliiifServlet 未返回 fid` | 令牌过期，或服务器上的文件已被清理。重新 `tokens` 一次拿新令牌 |
| `pdfboxServlet 500` | 页面令牌失效/过期，重新跑一次（页面令牌是即时生成的） |
| `grab` 报"没有任何记录的 fid 等于 …" | 这个 fid 不在该关键词的检索结果里；换标题关键词，或直接用 `--token` |
| `--link` 取不到令牌 | 该链接要带门户会话；用 `fetch --link`（内部会先 warm），不要自己裸请求 |
| `.29` 连不上（`probe` 显示不可达） | 站点临时故障，稍后重试 |
