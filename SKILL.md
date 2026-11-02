---
name: feishu-docx-export
description: 导出飞书云文档（my.feishu.cn / 各租户 feishu.cn 的 /docx/ 链接）为带图片、表格、嵌入卡片的 Markdown 文件。当用户给出 feishu.cn/docx 链接并要求导出、爬取、转 Markdown/转本地文件，或想批量备份飞书文档时使用——即使用户只说"爬这个页面"或"保存这个文档"，只要链接是 feishu.cn/docx 就应触发。
---

# 飞书云文档导出 Markdown

把 `https://<域名>/docx/<token>` 形式的飞书文档完整导出为本地 Markdown（含配图、封面、表格、代码块、嵌入卡片，可选附件视频）。

## 快速开始（一条命令）

```bash
node scripts/export.js "https://my.feishu.cn/docx/xxxxxxxx" --out ./输出目录
```

- 依赖：Node 18+、任意 Chromium 内核浏览器（自动探测 Playwright 缓存的 Chromium / Chrome / Edge，零 npm 依赖）。
- 登录态保存在 `~/.feishu-export-profile`，首次导出公开文档无需登录。
- 导出产物：`<out>/标题.md` + `images/`（配图与嵌入卡片 PNG）+ `embeds/`（卡片 HTML 源文件）+ `files/`（附件视频，如有）+ `work/`（中间数据）。

## 何时需要登录（--headed）

公开分享的文档无需登录。出现以下情况时用 `--headed` 重新运行，在弹出的窗口里登录（支持扫码）：

- 导出的 md 里嵌入卡片是占位符（`🧩 第三方嵌入块`）——嵌入卡片 iframe 只对登录用户渲染。
- 文档本身需要登录才能看（页面显示"登录/注册"）。
- 想下载文档内嵌的视频附件。

登录态会保存在 profile 里，之后的无头运行也能用。

## 命令参数

```
node scripts/export.js <URL> [--out <目录>] [--headed] [--profile <目录>] [--port <9222>] [--keep-open]
```

导出完成后脚本会自动跑一致性校验（图片/卡片/表格引用核对），逐项确认"✓ 全部引用"再交付。

## 手动分步管线（脚本失败时的兜底）

分步脚本都在 `scripts/` 下，按序执行（详细机制见 references/internals.md）：

```bash
node scripts/collect_dom3.js <tabId> work/dom_blocks.json   # 滚动采集全部内容块
node scripts/recollect_tables.js <tabId> work/dom_blocks.json # 表格行补采
node scripts/extract_srcdoc.js work/srcdoc.json              # 提取嵌入卡片 HTML
node scripts/render_embeds.js embeds images work/render_jobs.json # 卡片渲染 PNG
node scripts/md_gen.js work/dom_blocks.json work/meta.json   # 生成 Markdown
node scripts/qa2.js <标题>.md work/dom_blocks.json           # 校验
```

`<tabId>` 从 `curl http://127.0.0.1:9222/json/list` 获取。调试块的文档内位置可用 `node scripts/neighbors.js <tabId> <块ID>`。

## 已知边界

- 仅支持 `/docx/` 新版文档；`/wiki/` 链接、旧版 doc、在线表格不支持。
- 白板（画板）块无法转文本，保留占位说明。
- 部分需登录的第三方嵌入应用（如未安装的扩展）可能仍显示占位符。
- 一次只开一个文档标签页（嵌入卡片按 iframe target 全局提取，多标签会串）。
- 只导出你有权访问的内容，尊重文档作者意愿与飞书服务条款。
