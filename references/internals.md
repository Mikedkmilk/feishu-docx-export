# 管线内部机制（深入理解 / 调试时读）

这份文档记录飞书 docx 页面的渲染机制与各脚本的原理。正常导出用 `export.js` 即可，以下内容用于排查异常。

## 页面渲染机制

- 文档是 **SSR + 虚拟化渲染**：DOM 里只保留可视区附近的块（`[data-block-id]`），滚动时动态挂载/回收。所以必须边滚动边采集（`collect_dom3.js`，每步 500px、带停顿）。
- **采集顺序 = 真实 DOM 顺序，切勿按 id 排序**。SSR 会给晚挂载的 portal 内容（表格单元格、嵌入卡片、callout/网格子块）分配靠后的 id，id 顺序 ≠ 文档顺序；按 id 排序会把 callout 子块等挪离真实位置、产生错误的父块归属（第 1 篇实测把整段 PRD 内容挂到了一个空文本块下）。
- `back_ref_list`（相关文档反链面板）不是正文且 depth=0，会把 page 挤出深度栈吞掉后续全部块，建树前必须剔除。
- **SSR 块 id 每次页面加载都会变**，跨加载引用资产必须用稳定标识：图片用 `imgToken`（`images/img_<token>.<ext>`）、嵌入卡片用 `recordId` 前 16 位（`images/isv_<rec16>.png`、`embeds/isv_<rec16>.html`）、附件视频用文件 token（`files/<token>.mp4`）。
- 每块正文在 `data-zone-id == 块id` 的 zone 元素里；内联样式是 span 的内联 CSS（`font-weight:bold` / `italic` / `inline-code` 类），`md_gen.js` 的 `inlineHtmlToMd` 按此转 Markdown。
- 多行文本按 `.ace-line` 分行，行内零宽字符 `\u200B` 需剔除。

## 引用容器与高亮块（callout）的整块包裹

飞书的引用块（quote/quote_container）和高亮块（callout）是**容器**：图标、说明行、有序/无序列表等都是其子块。Markdown 里必须把自身文本与全部子块渲染进**同一个 blockquote**（`renderQuoted`）：

- 子块先渲染进缓冲区，逐行加 `> ` 前缀；已是 `>` 开头的行透传（避免嵌套引块）；空行转 `>` 保持引块连续。
- callout 的图标（emoji）在块的图标槽里、不在任何 zone/子块中——采集时用"克隆块元素→删掉全部子块与 zone→取剩余文本里的 emoji"提取（`collect_dom3.js` 的 icon 字段）。
- 纯 emoji 行与下一非空行合并（图标与首条内容在飞书中视觉同行）；`<br/>` 噪声行过滤；掐头去尾空引行，避免渲染出空盒子。

## 表格是虚拟化的

`<table>` 元素里通常只有第一行，完整行在 `tr[data-index]` 行容器里：

```
tr[data-index=0] → td[data-block-id=A], td[data-block-id=B]...
tr[data-index=1] → ...
```

`recollect_tables.js` 按 `tr[data-index]` 采集完整网格（保留行数最多的版本），单元格内容从 `cellBlocks[tdId]` 取（采集时表格内块单独归档，避免和主流程混淆）。表格 HTML 里的 `<td>` 顺序即行主序。

## 嵌入卡片（isv 块）

- "第三方嵌入块"实际是**自包含 HTML 卡片**：用户原始 HTML 就存在文档数据里（`window.DATA.clientVars.data.block_map[recordId].data.data.html`），匿名也能拿到，SPA 渲染失败只显示 error-view。
- 登录后块渲染为 `blk_*.feishupkg.com` 的跨域 iframe（OOPIF）。`/json/list` 会给出 type=iframe 的独立 target，必须连**浏览器级** WebSocket + `Target.attachToTarget{flatten:true}`（直连 target 的 WS 会超时）。
- 卡片 iframe 内部还有一层嵌套 iframe，其 `srcdoc` = 沙箱引导脚本 + **用户原始 HTML 原文**。`renderKey="3:default:<原始字节数>:<hash>"`，但不要按 doctype+长度切（srcdoc 自己也有 doctype），取**最后一个 `</script>` 之后的整段**即可（含主题 style，可独立渲染）。
- 被虚拟化回收的 iframe：`ifr.src = ifr.src` 强刷后 target 会重新出现。
- 卡片与块的对应关系：优先用 OT recordId → clientVars 里 HTML 长度精确匹配；缺失时用"渲染像素高度 ÷2 ≈ iframe CSS 高度"指纹匹配。

## 图片与附件下载

图片 URL 无需等懒加载，直接按 token 拼接（`mount_node_token` = 图片块自身 id）：

```
https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/{imageToken}/
  ?fallback_source=1&height=1280&mount_node_token={blockId}&mount_point=docx_image&policy=equal&width=1280
```

需要浏览器 Cookie（CDP `Network.getAllCookies` 提取，含 HttpOnly）。文件魔数判断扩展名（PNG/JPEG/GIF/WEBP）。

file/video 块：登录态下滚到块处，读渲染后的 `video.src`（`/space/api/box/stream/download/video/{token}/`），带 Cookie 下载。

## 登录

- 登录态存在 `--user-data-dir` profile 里，跨进程持久。
- 匿名打开的标签页可能被安全检测重置成 about:blank——用 `PUT /json/new?<url>` 新开标签即可。
- 页面是否登录看 DOM 有无"登录/注册"字样（`/space/api/user/` 接口判断不可靠）。
- 首次匿名加载后登录，需要刷新页面 isv iframe 才会渲染。

## 已知的坑

- **一次只开一个文档标签**：嵌入卡片 iframe target 是浏览器全局的，多文档同开会把 A 文档的卡片提到 B 文档。
- **标签页可能进入"半水合"坏状态**：滚动容器存在但滚动不生效、块不再挂载（采集只拿到十几块）。遇到就关掉该标签重开新的。
- callout/白板等模块的渲染是间歇性的（同一环境有时不加载）；callout 不渲染时图标抓不到，白板始终无法导出，保留占位符。
- `back_ref_list`（相关文档反链面板）不是正文且 depth=0，建树前必须剔除。
- `md_gen.js` 对 `docx-heading1/2/3/4` 的映射是 `##`~`#####`（文档标题占 `#`）。
