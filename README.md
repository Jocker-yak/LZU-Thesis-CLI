# LZU-Thesis-CLI

兰州大学学位论文管理系统（门户 `202.201.7.17`）里的"查看全文"，实际是由一台**版权保护阅读器**
（`202.201.7.29`）把 PDF 渲染成图片再显示的；站点没有可用的原始 PDF 下载通道
（`downloadServlet` 500、`/store/` 被 `alert('不能打开！')` 拦、`pdfoffServlet` 404）。

这个工具把那台阅读器渲染出来的页面**逐页抓下来，合成一个能在任何阅读器里打开的 PDF**。
产物是**图片版 PDF**（约 144 dpi，带站点水印），文字不可选、不可复制；这是能做到的最好结果。

---

## 1. 安装

只需要 Python 3.8+；合成 PDF 用到 Pillow：

```powershell
pip install pillow
```

无需浏览器、无需 Node。

---

## 2. 四种用法，挑一种

### A. 只知道论文关键词或导师姓名 —— 全自动（推荐）

```powershell
python fulltext.py probe                     # 先确认两台服务器都在
python fulltext.py grab --keyword 侯扶江 `
    --find-fid 5cff3489f0c23900f886634fffe22fff --out out
```

流程：门户检索 → 逐条抽 DRM 令牌 → 用 **fid 指纹**确认是哪一篇 → 下页 → 合成
`out/<论文标题>.pdf`。加 `--dry-run` 只确认不下载；已知是检索结果第 N 条可用 `--index N`。

`fid` 就是你浏览器地址栏里 `pdfindex1.jsp?fid=xxxx` 那串 32 位十六进制。
**它等于原始 PDF 文件内容的 MD5**，所以是可靠的身份指纹——换个会话、换个 store 文件名，
fid 都不变。

### B. 手上已经有一个 DRM 令牌

```powershell
python fulltext.py decode <令牌>              # 先看它指向哪个文件、哪几页
python fulltext.py fetch  --token <令牌> --out out
```

### C. 浏览器里已经打开了全文

在能看到全文的页面按 `F12` → Console，把 [`lzu_fulltext/browser-console.js`](lzu_fulltext/browser-console.js)
整段粘进去回车，直接下载 `fulltext.pdf`。（脚本从页面隐藏域读 fid/pageCount，调
`jumpServlet` 取图，用 CDN 上的 jsPDF 合成。）

### D. 从门户链接直接抓

```powershell
python fulltext.py fetch --link "onlinePDF?dbid=72&objid=55_55_55_57_56_49&flag=online" --out out
```

---

## 3. 命令表

| 命令 | 作用 |
| --- | --- |
| `probe` | 检查 `.17` / `.29` 是否可达 |
| `decode <token>` | 解析令牌 → path / startpage / endpage / filename / infoname |
| `forge --path <P> [--verify]` | 按服务器文件路径伪造令牌；`--verify` 顺便注册看 fid |
| `verify <token>…` | 注册令牌并打印对应的 fid（身份指纹） |
| `search <关键词> [--json f]` | 门户检索，列出 `id1/id2/标题` |
| `tokens <关键词> --out f.json` | 检索 + 逐条抽 DRM 令牌，写 JSON |
| `identify <fid> [--from f.json]` | 用 fid 反查是哪一条记录 |
| `fetch (--token\|--link\|--fid+--cookie)` | 下载全文并合成 PDF |
| `grab --keyword K (--find-fid F\|--index N)` | 一条龙：检索 → 令牌 → fid 确认 → 下载 |

`fetch` / `grab` 通用参数：`--out 目录`（默认 `out`）、`--name 文件名`、`--resolution 150`、
`--no-images`（不保留页面图片）、`--dry-run`（只确认不下载）。

---

## 4. 当库用

```python
import sys; sys.path.insert(0, r"<仓库目录>")
from lzu_fulltext import Reader, Portal, decode_token, encode_token

r = Reader.from_token("<令牌>")
print(r.fid, r.page_count, r.infoname)
print(r.fetch(outdir="out"))          # {'pdf': ..., 'pages': 84, ...}

po = Portal()
for rec in po.search("侯扶江"):
    for t in po.tokens_for(rec):
        reg = Reader.from_token(t["token"])
        if reg.fid == "5cff3489f0c23900f886634fffe22fff":
            reg.fetch(outdir="out")
```

---

## 5. 原理速查（想改代码时看这里）

1. **fid = 原 PDF 内容的 MD5**。拿令牌注册后服务器返回的 `Location` 里就带着它，
   所以能用 fid 精确判断"这条记录是不是我要的那篇"，而不必先下载。
2. **文档是会话级的**。`GET /personaliiifServlet?path=<令牌>` → 302 到
   `/pdfindex1.jsp?fid=<fid>` 并下发 `JSESSIONID`；换个会话裸开 `pdfindex1.jsp?fid=…`
   所有隐藏域都是 `null`——这就是"原链接打开一片空白"的原因。
3. **令牌格式**：`5 个随机 base64 字符 + base64(quote(path,"") + "&startpage=..&endpage=..&down=..&watermark=..&filename=..&infoname=..")`，
   `path` 形如 `D:\DRM\read\WebRoot\store\<随机名>.pdf`。**每次请求门户这个随机名都会变**，
   所以 path 绝不能当身份，只能认 fid。
4. **取页**：`GET /jumpServlet?page=N&fid=<fid>` 返回
   `{"list":[{"id":"N","src":".../pdfboxServlet?page=<64位hex>"}]}`，每次只给 N 附近一小段，
   所以要从 0 循环到 pageCount 合并去重。
5. **下页**：`GET /pdfboxServlet?page=<64位hex>` 直接吐 JPEG，**不需要 Cookie**；
   令牌失效时返回 500（`pdfboxServlet.java:35` NPE）。
6. **门户链接**：`/onlinePDF?dbid=72&objid=<ASCII码用下划线连>&flag=online` → 302 到
   `.29/personaliiifServlet?path=<令牌>`。`objid` 例如 `55_55_55_57_56_49` → `"777981"`。
   请求这个链接必须带门户会话（先访问检索页），否则拿不到令牌。

---

## 6. 目录结构

```
fulltext.py                 便捷入口（等价于 python -m lzu_fulltext）
lzu_fulltext/
  __init__.py               对外 API
  __main__.py               python -m lzu_fulltext
  cli.py                    命令行实现（9 个子命令）
  net.py                    HTTP 工具（Cookie / 不跟随 302 / 重试 / 健康检查）
  drm.py                    .29 阅读器客户端 + 令牌编解码
  portal.py                 .17 门户客户端（检索 / 取令牌）
  pdfbuild.py               图片 → PDF
  browser-console.js        浏览器控制台一键版（用法 C）
  README.md                 更详细的说明（含排查表）
legacy/                     早期探索脚本（功能已并入上面，仅作参考）
```

仓库里**不含**下载产物（`out/`、`pages/`、PDF）、会话令牌快照 `tokens*.json`
（里面是时效性凭证）以及本机私钥，见 [.gitignore](.gitignore)。

---

## 7. 限制与注意事项

* 拿到的是**图片版 PDF**：文字不可选、不可复制；要 OCR 请自己再过一遍。
* 每页带站点水印（通常是访问者 IP + 时间）。试过按亮度曲线淡化，图表线条会一起变淡，故保留原样。
* `/store/` 下的原始 PDF 无法直取；`downloadServlet`、`pdfoffServlet` 都是坏的。
* 令牌和 `JSESSIONID` 有时效；`.29` 偶尔短暂连不上（工具自带 4 次重试）。
* 服务器会为每次请求重新分配 store 文件名，别把 `path` 写死进代码。
* **请只在你有权访问的范围内使用**（本人可访问的馆藏 / 已获授权），不要批量转发。

---

## 8. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `pdfindex1.jsp` 字段全是 `null` | 该 fid 没在当前会话注册过。用 `--token` 自助注册，或 `--fid`+`--cookie` 复用浏览器会话 |
| `注册失败：personaliiifServlet 未返回 fid` | 令牌过期，或服务器上的文件已被清理。重新 `tokens` 一次拿新令牌 |
| `pdfboxServlet 500` | 页面令牌失效/过期，重跑一次（页面令牌是即时生成的） |
| `grab` 报"没有任何记录的 fid 等于 …" | 关键词检索没覆盖到那篇；换标题关键词，或直接用 `--token` |
| `--link` 取不到令牌 | 该链接要带门户会话；用 `fetch --link`（内部会先 warm），不要自己裸请求 |
| `.29` 连不上（`probe` 显示不可达） | 站点临时故障，稍后重试 |
