# 兰大论文全文助手（Chrome / Firefox 插件）

把仓库里 Python 版 `lzu_fulltext` 的抓取流程搬进浏览器：**在你已经登录的门户会话里检索论文、
在阅读器页面上直接一键获取全文，并把阅读器渲染的页面合成一个图片版 PDF 下载**。

插件复用公开的阅读器接口（`pdfindex1.jsp` / `jumpServlet` / `pdfboxServlet`），
不破解 DRM、不绕过任何鉴权：能看到全文的前提仍然是**你的浏览器本身能打开那篇论文**。

- 产物仍是**图片版 PDF**（约 144 dpi，带站点水印），文字不可选、不可复制。
- 与 Python CLI 的关系：CLI 用 `requests` 自己维护会话来跑同样的流程；插件不自己存账号密码，
  直接借浏览器的 cookie，因此**不需要安装 Python、不需要手动拷 `JSESSIONID`**。
  CLI 一行没改，两种用法可以并存。

---

## 1. 安装

插件是**未上架商店的本地扩展**，需要开启浏览器的开发者模式加载。两个浏览器各有一套构建产物：

```
dist/chrome/      Chrome / Edge / 其它 Chromium 浏览器
dist/firefox/     Firefox
```

### Chrome（或 Edge）

1. `cd extension && npm install && npm run build`（或直接使用仓库里已构建好的 `dist/chrome/`）；
2. 地址栏打开 `chrome://extensions/`；
3. 右上角打开「开发者模式」；
4. 点「加载已解压的扩展程序」，选择 **`extension/dist/chrome`** 目录；
5. 工具栏出现蓝色图标即安装成功（可在拼图菜单里把它固定出来）。

要求 Chrome ≥ 116（用到 `offscreen` 文档生成下载 blob）。

### Firefox

1. `npm run build` 后得到 `dist/firefox/`（或用 `release/lzu-fulltext-firefox-1.0.1.xpi`）；
2. 地址栏打开 `about:debugging#/runtime/this-firefox`；
3. 点「临时载入附加组件…」，选择 **`dist/firefox/manifest.json`**；
4. 工具栏出现图标即成功。

要求 Firefox ≥ 115。注意「临时载入」在浏览器重启后会失效，需要重新载入一次
（自建签名流程见 [MDN: 签名与分发](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)，本仓库不包含签名证书）。

---

## 2. 三种用法

### A. 阅读器页面一键下载（最省事）

在门户里点到「查看全文」，等阅读器（`202.201.7.29`）把页面渲染出来后，
页面右下角会出现插件浮层：

```
┌──────────────────────────────┐
│ 论文全文                       │
│ 补播白刺花对能量摄入…      │
│ 200 页 · fid 5cff3489…        │
│ [ 获取全文 ]      [ 工作台 ]   │
└──────────────────────────────┘
```

点「获取全文」→ 后台自动读令牌里的页码、逐页抓图、合成 PDF，然后走浏览器下载。
浮层会实时显示「抓取页面 37/200」这样的进度，可随时取消。

### B. 从 popup 检索（不用先打开论文）

点工具栏图标 → 输入作者姓名或题名关键词 → 点「检索」：

- 列表来自门户检索（和 CLI 的 `search` 一样，默认每页 20 条）；
- 结果行会显示「有全文入口 / 无全文入口」，「下载全文」按钮只在有入口时可点；
- 「仅解析 fid」只解析不下载，适合先确认是哪一篇；
- 「解析全部 fid」批量解析当前结果（会顺带补全全文入口）。

「下载全文」的两种路径都由后台完成：行上已有 fid 就直接开下载；只有链接时，
后台先打开隐藏标签页走一遍真实跳转拿到 fid，再抓页面。

### C. 手上有令牌或直链

popup 里还有两个页签：

- **令牌**：粘贴 DRM 令牌（或包含 `personaliiifServlet?path=…` 的链接/HTML 片段），
  本地解析预览（题名/文件名/页数/存储路径），确认后下载。令牌解析在本地完成，不会上传到任何地方。
- **直链**：粘贴门户的 `onlinePDF?dbid=…&objid=…` 链接，插件自动跟随跳转拿 fid。

完整工作台（任务/历史/设置/日志/帮助）在 popup 右上角「工作台」，或 `chrome://extensions`
里点「扩展程序选项」打开。

---

## 3. 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 抓取方式 | 自动 | `bridge`（页面内请求，最稳）/ `bg`（后台请求）/ `auto`（先桥接，失败再后台） |
| 页面分辨率 | 150 | 阅读器接口的 `resolution` 参数；150 ≈ 144 dpi，调高更清晰但更慢、文件更大 |
| 并发抓页 | 2 | 同时抓几页；服务器对并发敏感，建议 1–3 |
| 文件名来源 | 令牌题名 | `令牌题名`（`infoname`）/ `原始文件名`（`filename`）/ `fid` |
| 下载时询问位置 | 关 | 打开后每次弹出「另存为」 |
| 检索后自动解析 fid | 关 | 打开后每次检索都会批量开隐藏标签页解析，页面多时会很慢 |

任务进度写在 `storage.session`，MV3 后台被回收后重启会标成「已中断」，重新点一次即可。

---

## 4. 构建 / 测试 / 打包

```bash
cd extension
npm install

npm run build          # 生成 dist/chrome 与 dist/firefox
npm run package        # 生成 /data/workspaces/lzu-plugin/release/*.zip（Firefox 另有 .xpi）
npm run icons          # 重新生成 assets/icons/*.png（纯 Node，无 Pillow 依赖）

npm test                    # = test:unit + test:integration（66 项，纯 Node，无需浏览器）
npm run test:unit
npm run test:integration

npm run test:e2e            # Chrome 端到端：真 Chromium + 本地 mock 门户/阅读器
npm run test:e2e:firefox    # Firefox 端到端：真 Firefox（Marionette）+ 同一套 mock
npm run test:all            # test + 两个浏览器 E2E
npm run lint:firefox        # web-ext lint 检查 Firefox 清单/打包
npm run smoke:live          # 只读冒烟：真实门户检索 + 令牌解码（不碰 .29）
```

### E2E 说明

`npm run test:e2e` 会构建扩展，然后在**真实 Chromium** 里加载 `dist/chrome`，
用 `tests/mock/servers.mjs` 起一个本地门户 + 阅读器（`--host-resolver-rules` 把
`202.201.7.17`/`202.201.7.29` 指到回环地址），跑两遍完整流程：

1. 阅读器页面浮层「获取全文」→ 下载完成；
2. popup 检索 → 后台补全全文入口 → 「下载全文」→ 下载完成。

下载到的 PDF 用 **pdfjs-dist**（独立解析器，不是我们自己的代码）复核页数与页面尺寸，
结果写 `tests/e2e/out/report.json`。

本机没有浏览器时可以让脚本把工作区同步到远程 Docker 主机上跑（默认 `nucbox`）：

```bash
npm run test:e2e -- --mode=docker
# 可覆盖：LZU_E2E_SSH_CONFIG / LZU_E2E_SSH_HOST / LZU_E2E_REMOTE_DIR / LZU_E2E_IMAGE
```

默认镜像 `mcr.microsoft.com/playwright:v1.64.1-noble`（自带 Chromium、Firefox 与 Xvfb）。

### Firefox E2E（Marionette）

Playwright 不支持给 Firefox 装扩展，所以 Firefox E2E 走的是 Firefox 自带的 **Marionette** 协议
（`tests/e2e/lib/marionette.mjs` 是一个 200 行的零依赖客户端）：临时安装未签名 XPI →
打开扩展页 → 从扩展页调 `runtime.sendMessage` 走完整检索/下载流程 →
校验下载的 PDF。假域名用 Firefox 的 `network.dns.localDomains` 指到 `127.0.0.1`，
mock 门户/阅读器共用 `127.0.0.1:80`（用 `Host` 头区分，见 `startMockWorld({ singlePort: true })`）。

```bash
npm run test:e2e:firefox               # 本机有 Firefox 就本地跑，否则走远程 Docker
npm run test:e2e:firefox -- --mode=docker
```

同样支持 `LZU_E2E_SSH_CONFIG / LZU_E2E_SSH_HOST / LZU_E2E_REMOTE_DIR / LZU_E2E_IMAGE` 覆盖；
本机跑可用 `LZU_FIREFOX_BIN=/path/to/firefox` 指定浏览器。

### 测试用的真实数据

`tests/fixtures/` 里是**真实抓包**（2026-10 采集，只是数据，不含任何账号信息）：

| 文件 | 内容 |
| --- | --- |
| `portal/resultlist.html` | 门户检索「侯扶江」的结果页（20 行 / 标称 77 条） |
| `portal/docinfo-empty.html` | 一条没有全文入口的论文信息页 |
| `portal/docinfo-link.html` | 一条有 `onlinePDF` 链接的论文信息页 |
| `portal/token.json` | 真实 501 字符 DRM 令牌 + 302 响应头（用于令牌编解码测试） |
| `images/school.jpg` | 真实 1024×750 JPEG（mock 页面图） |

重新抓一遍（只读，需要能访问门户）：

```bash
npm run fixtures:capture            # 默认关键词「侯扶江」
node tests/fixtures/capture.mjs 牦牛
```

---

## 5. 权限与隐私

清单里只要了这些权限，都有明确用途：

| 权限 | 用途 | 说明 |
| --- | --- | --- |
| `storage` | 设置、任务状态、历史、日志 | 全部在 `browser.storage` 本地，不上传 |
| `downloads` | 保存 PDF | 只调用 `downloads.download` |
| `cookies` | 清理阅读器会话 | 注册重试时清 `202.201.7.29` 的 `JSESSIONID` |
| `offscreen`（仅 Chrome） | 生成 PDF 的 blob URL | service worker 里不能可靠地把 blob URL 交给下载接口 |
| `host_permissions` | `202.201.7.17` / `202.201.7.29` | 只访问这两个站点，没有 `<all_urls>` |

- 插件**不采集、不上传**任何数据；没有统计、没有远程配置、没有账号密码。
- 抓下来的页面图片只在本机内存里合成 PDF，临时 blob 在下载后 180 秒内回收。
- 令牌解析完全在本地（`protocol.js` 是 `drm.py` 的 JS 实现）。
- 仓库里不含任何凭证；`tests/fixtures/portal/token.json` 是**已过期**的测试数据。

---

## 6. 限制与故障排查

* **图片版 PDF**：文字不可选，需要 OCR 请自己再处理；每页带站点水印（通常含 IP + 时间）。
* **必须能访问校内站点**：`202.201.7.29` 通常只在校内网可达；校外请先连 VPN。
  连不上时浮层/popup 会提示「阅读器 202.201.7.29 可能只在校内网可达」。
* **需要登录/有权限**：门户部分记录没有全文入口（列表里显示「无全文入口」），插件不会也不该绕过。
* **Firefox 走「页面内桥接」**：Firefox 把 `moz-extension://` 当安全上下文，扩展页/后台直接
  `fetch('http://202.201.7.17/…')` 会被当**混合内容**拦截（`NetworkError`）。所以插件在门户/阅读器
  页面里用 content script 发同源请求（带真实 cookie），后台只负责调度。装好扩展后**已经打开的旧标签页要刷新一次**，
  content script 才会注入。
* **令牌有时效**：`personaliiifServlet` 的令牌和页面令牌都是即时生成的，过期就重新点一次；
  失败重试是安全的（会重新注册）。
* **请只在你有权访问的范围内使用**（本人可访问的馆藏 / 已获授权），不要批量转发。

| 现象 | 原因 / 处理 |
| --- | --- |
| 阅读器页面没有浮层 | 该页不是阅读器主页面（`pdfindex1.jsp`）；等页面渲染完再刷新一次 |
| 弹「获取全文」后一直 0 页 | 令牌过期 → 回门户重新点一次「查看全文」；或检查 VPN |
| 下载被拦 / 无文件 | Chrome 设置里允许该扩展下载；或打开「下载时询问位置」再试 |
| popup 显示「门户不可达」 | 不在校内网 / 门户维护；工具本身不重试门户连通性时请点「重新检测」 |
| Firefox 重启后插件消失 | 临时载入的扩展重启即失效，重新 `about:debugging` 载入 |
| Firefox 状态点是黄色（未检测） | Firefox 不允许扩展页直接探测 `http://` 站点；先在门户/阅读器打开一个标签页，再点「重新检测」 |
| Firefox 报「桥接失败…Permission denied to access property "constructor"」 | 1.0.0 的 bug（content script 里 base64 用了跨 realm 的 `fromCharCode.apply`），1.0.1 已修复；刷新扩展与页面后重试 |
| Chrome 156+ 下载/probe 行为异常 | 1.0.0 把 `globalThis.browser` 当 Firefox 判据，而 Chrome 156 也提供了该命名空间；1.0.1 改用 `runtime.getBrowserInfo` 判断 |
| 任务显示「已中断（后台重启）」 | MV3 service worker 被回收；点一次重新下载即可 |

---

## 7. 代码结构

```
extension/
  package.json                 构建/测试脚本（零运行时依赖）
  manifest.chrome.json         Chrome MV3 清单（service_worker + offscreen）
  manifest.firefox.json        Firefox MV3 清单（background.scripts + gecko id）
  src/lib/                     纯逻辑，无浏览器 API，Node 里可测
    protocol.js                DRM 令牌编解码（drm.py 的 JS 实现）
    http.js                    request 注入 + 重试 + 错误分类（GoneError 等）
    portal.js                  门户检索 / docinfo / onlinePDF 链接解析
    reader.js                  阅读器页面解析（meta / 页数 / 页面 URL）
    pdf.js                     图片 → PDF（JPEG 原字节 /DCTDecode，自写写出器）
    pipeline.js                注册 → 读 meta → 抓页 → 合成 PDF
    settings.js                设置默认值与读写
    ext.js                     browser/chrome API 小工具、日志
  src/background/              MV3 后台
    main.js                    消息路由 + 任务编排（唯一有状态的地方）
    tabs.js                    隐藏标签页 = 会话载体、等待导航、向 content script 发消息
    transport.js               bridge 优先的请求通道 + 连通性探测
    downloads.js               Chrome offscreen / Firefox 直接 blob / data URL 兜底
    offscreen.js               生成 blob URL 的 offscreen 文档
  src/content/                 内容脚本（v1 只做阅读页浮层 + 门户 docinfo 页按钮）
    bridge.js                  同源 fetch 桥 + 页面 meta/fid 读取
    panel.js                   shadow DOM 浮层
    reader.js / portal.js      两个站点的挂载
  src/ui/                      popup + 工作台（共用 shared-view.js）
  scripts/                     build.mjs（esbuild）/ zip.mjs（自写 ZIP）/ make-icons.mjs
                               e2e.mjs（Chrome）/ e2e-firefox.mjs（Firefox）
  tests/                       unit / integration / e2e / mock / fixtures
    e2e/chrome.mjs             Playwright 驱动 Chromium 加载扩展
    e2e/firefox.mjs            Marionette 驱动 Firefox 临时安装 XPI
    e2e/lib/marionette.mjs     零依赖 Marionette 客户端（装扩展 / chrome 上下文 / 执行脚本）
    mock/servers.mjs           复刻门户与阅读器（支持 singlePort 模式给 Firefox 用）
```

数据流（一次下载）：

```
popup/浮层 ──start──▶ background/main.js
                      ├─ resolveTarget(): 令牌/链接/fid → 开隐藏标签页真实导航 → fid
                      ├─ content bridge（同源 fetch）注册 + 读 meta
                      ├─ pipeline.downloadDocument(): 并发抓 jumpServlet → pdfboxServlet
                      │    └─ pdf.buildPdf(): 只拼接，不解码 JPEG
                      └─ downloads.saveBytes(): blob → downloads.download
                           └─ 逐条 task-update 广播回 popup / 浮层
```

为什么这样分层：`src/lib` 不碰浏览器 API，所以能在 Node 里用真实抓包 fixture 跑单测/集成测试；
`background` 负责「浏览器才有的东西」（标签页、下载、消息）；`content` 负责「页面才有的东西」
（真实 cookie 的同源请求、DOM 浮层）；UI 只渲染状态。

---

## 8. 与 Python CLI 的对照

| 能力 | CLI | 插件 |
| --- | --- | --- |
| 会话 | 自己维护 `requests` 会话 | 复用浏览器 cookie |
| 检索 | `search` / `fids` | popup「检索」 |
| 拿 fid | `tokens` / `fids` / `--link` | 链接→隐藏标签页跳转 / 检索行解析 |
| 抓页 | `fetch` / `grab` | 后台任务，带进度与取消 |
| 输出 | `out/*.pdf` | 浏览器下载目录 |
| 批量 | 脚本循环 | 每次一条（门户对并发敏感） |

协议细节与 `lzu_fulltext/README.md` 一致；两边共用同一套路由、同一套令牌格式，
改协议时请同步改 `src/lib/protocol.js` 与 `lzu_fulltext/drm.py`。
