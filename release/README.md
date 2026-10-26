# 发布包：兰大论文全文助手 1.0.1

构建日期：2026-10-26 ｜ 版本：1.0.1（可复现构建，ZIP 时间戳固定） ｜ 对应插件目录：[`extension/`](../extension/)

本目录存放可直接安装的浏览器扩展包。安装/使用/排查的完整说明见
[`extension/README.md`](../extension/README.md)。

## 文件

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `lzu-fulltext-chrome-1.0.1.zip` | 59 KB | Chrome / Edge 安装包（解压后「加载已解压的扩展程序」） |
| `lzu-fulltext-firefox-1.0.1.zip` | 58 KB | Firefox 安装包（解压后「临时载入附加组件」） |
| `lzu-fulltext-firefox-1.0.1.xpi` | 58 KB | Firefox 安装包（同一份 ZIP 的 `.xpi` 副本，可装入允许未签名扩展的 Firefox） |

`.zip` 与 `.xpi` 字节完全相同，校验和一致属正常。

## 校验和（SHA-256）

```
84747b7841bc9287b5791f4c3baff4b1eec10ca68718ab5971d524b1312d6b79  lzu-fulltext-chrome-1.0.1.zip
8f2997f0a1402e61442157b50ca97671bcd68e48fdace2726b317388a96a3971  lzu-fulltext-firefox-1.0.1.zip
8f2997f0a1402e61442157b50ca97671bcd68e48fdace2726b317388a96a3971  lzu-fulltext-firefox-1.0.1.xpi
```

本机校验：

```bash
sha256sum -c SHA256SUMS.txt
```

## Chrome / Edge

1. 解压 `lzu-fulltext-chrome-1.0.1.zip` 到固定目录（不要删除）；
2. 打开 `chrome://extensions` → 右上角开启「开发者模式」；
3. 「加载已解压的扩展程序」→ 选择解压出的目录（`manifest.json` 所在层）；
4. 建议把扩展固定到工具栏，打开论文门户/阅读器页面后点击图标使用。

## Firefox

方式一（临时载入，重启浏览器后失效，适合试用）：

1. 解压 `lzu-fulltext-firefox-1.0.1.zip`；
2. 打开 `about:debugging#/runtime/this-firefox` → 「临时载入附加组件」→ 选择解压目录里的 `manifest.json`。

方式二（`.xpi`，需要 Firefox 允许未签名扩展，如 Developer Edition / Nightly）：

1. `about:config` 将 `xpinstall.signatures.required` 设为 `false`；
2. `about:addons` → 齿轮 → 「从文件安装附加组件」→ 选择 `lzu-fulltext-firefox-1.0.1.xpi`。

升级时先移除旧版本再载入 1.0.1，并刷新已打开的论文门户/阅读器页面。

## 这个版本修了什么

- 修复 1.0.0 在 Firefox 下「桥接失败，改用后台 fetch：页面内请求失败：Permission denied to access property "constructor"」；
  改为纯 JS base64 编码，不再把跨 realm 的 `Uint8Array` 交给 `String.fromCharCode.apply`。
- Firefox 的扩展页不允许直接访问 `http://` 站点（混合内容拦截），因此 Firefox 固定走页面内桥接；
  连通性检测改为借用已打开的门户/阅读器标签页，未打开时显示黄点「未检测」而不是报错。
- 修复 Chrome 156 也暴露 `globalThis.browser` 导致的浏览器误判（改用 `runtime.getBrowserInfo` + UA 兜底）。
- 新增真浏览器端到端测试：Chrome 10/10、Firefox 12/12（Firefox 157，经 Marionette 临时安装 XPI）。
- 文档与测试里的示例身份更新为「侯扶江 / 补播白刺花…」示例数据（仅示意，不含任何真实读者信息）。

## 说明

本扩展只复用你有权访问的论文阅读器公开接口，把阅读器渲染的页面合成为图片版 PDF（保留水印、无文字层），
不绕过任何访问控制，也不存储账号密码。请只在你有权访问的范围内使用。
