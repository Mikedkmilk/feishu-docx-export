# feishu-docx-export

一个 [ZCode](https://github.com/zcode-ai) skill：把飞书云文档（`feishu.cn/docx` 链接）一键导出为带图片、表格、嵌入卡片的本地 Markdown。

## 特性

- **一条命令**完成：内容块采集 → 表格 → 配图/封面下载 → 嵌入卡片渲染 → 附件视频下载 → Markdown 生成 → 一致性校验
- 保留标题层级、粗体/斜体/行内代码/链接、有序/无序列表（含真实编号）、引用块、高亮提示块、代码块
- 嵌入卡片（"文本绘图"等 HTML 卡片）渲染为高清 PNG 嵌入，HTML 源文件一并存档
- 附件视频（录屏等）自动下载并在 Markdown 中链接
- 基于 CDP 驱动本机 Chromium 内核浏览器，**零 npm 依赖**（Node 18+ 内置能力即可）
- 登录态持久化在独立 profile（`~/.feishu-export-profile`），扫码一次后续导出免登录

## 安装

把本仓库克隆到 ZCode 的技能目录：

```bash
# 用户级（所有项目可用）
git clone https://github.com/<you>/feishu-docx-export.git ~/.agents/skills/feishu-docx-export

# 或项目级
git clone https://github.com/<you>/feishu-docx-export.git <项目>/.agents/skills/feishu-docx-export
```

## 使用

在 ZCode 里直接说：

> 帮我把这个飞书文档导出为 markdown：https://my.feishu.cn/docx/xxxxxx

或手动运行：

```bash
# 公开文档，无头模式直接导出
node ~/.agents/skills/feishu-docx-export/scripts/export.js "https://my.feishu.cn/docx/xxxxxx" --out ./导出结果

# 文档含嵌入卡片/附件，或需要登录：加 --headed 弹出浏览器扫码
node scripts/export.js "https://my.feishu.cn/docx/xxxxxx" --out ./导出结果 --headed
```

## 工作原理（简要）

飞书 docx 页面是 SSR + 虚拟化渲染：脚本用 CDP 驱动浏览器滚动全页采集内容块（块 ID 即文档顺序），从 `tr[data-index]` 行容器补全虚拟化表格，按图片 token 拼接 CDN 地址下载配图，从嵌入卡片 iframe 的 srcdoc 提取原始 HTML 并离线渲染成 PNG，最后按块类型映射生成 Markdown。

细节与调试指南见 [references/internals.md](references/internals.md)。

## 已知边界

- 仅支持 `/docx/` 新版文档（wiki 链接、旧版 doc、在线表格不支持）
- 白板（画板）块无法转文本，保留占位说明
- 一次只开一个文档标签页（嵌入卡片按浏览器全局 iframe 提取）
- 请仅导出你有权访问的内容，尊重文档作者意愿与飞书服务条款

## 目录结构

```
├── SKILL.md                  # 技能入口（工作流 + 命令）
├── references/internals.md   # 内部机制与调试指南
└── scripts/
    ├── export.js             # 一键编排器
    ├── cdp.js                # CDP 共享库
    ├── collect_dom3.js       # 滚动采集内容块
    ├── recollect_tables.js   # 表格行补采
    ├── extract_srcdoc.js     # 嵌入卡片 HTML 提取
    ├── render_embeds.js      # 卡片渲染 PNG
    ├── md_gen.js             # 块 → Markdown
    ├── qa2.js                # 导出一致性校验
    └── neighbors.js          # 调试: 查块的文档内位置
```

## License

MIT
