#!/usr/bin/env node
// 用法: node md_gen.js <blocks_v3.json> <meta.json> [输出文件名]
// meta.json: {title, coverToken} (取自 clientVars); 封面需先下载为 images/cover_<token>.png
const fs = require("fs");
const path = require("path");

const [blocksFile, metaFile, outName] = process.argv.slice(2);
const { blocks, cellBlocks } = JSON.parse(fs.readFileSync(blocksFile, "utf8"));
let docTitle = "", coverToken = null;
if (metaFile && fs.existsSync(metaFile)) {
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  docTitle = meta.title || "";
  coverToken = meta.coverToken || null;
}

// ---------- 1. 图片文件映射 ----------
const EXT_BY_MAGIC = (buf) => {
  if (buf.length < 12) return ".bin";
  if (buf[0] === 0x89 && buf[1] === 0x50) return ".png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  if (buf.slice(0, 3).toString() === "GIF") return ".gif";
  if (buf.slice(8, 12).toString() === "WEBP") return ".webp";
  return ".bin";
};
const imgFile = {};
for (const id of fs.existsSync("images") ? fs.readdirSync("images") : []) {
  const m = id.match(/^(\w+)\.(img|png|jpe?g|gif|webp)$/);
  if (!m) continue;
  const bid = m[1], fp = path.join("images", id);
  if (id.endsWith(".img")) {
    const ext = EXT_BY_MAGIC(fs.readFileSync(fp));
    const fn = bid + ext;
    fs.renameSync(fp, path.join("images", fn));
    imgFile[bid] = "images/" + fn;
  } else imgFile[bid] = "images/" + id;
}
if (fs.existsSync("images/cover.png")) imgFile["__cover_doc1__"] = "images/cover.png";
if (coverToken && fs.existsSync(`images/cover_${coverToken}.png`)) imgFile["__cover__"] = `images/cover_${coverToken}.png`;
console.log("图片文件:", Object.keys(imgFile).length);

// ---------- 2. 内联 HTML -> markdown ----------
function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function inlineHtmlToMd(html) {
  const lines = html.split(/<div[^>]*class="[^"]*ace-line[^"]*"[^>]*>/);
  const mdLines = [];
  for (const seg of lines) {
    const runs = [];
    const styleStack = [{}];
    const re = /<[^>]+>|[^<]+/g;
    let m;
    while ((m = re.exec(seg))) {
      const tok = m[0];
      if (tok[0] === "<") {
        if (/^<span\b/i.test(tok)) {
          const cur = { ...styleStack[styleStack.length - 1] };
          const style = (tok.match(/style="([^"]*)"/) || [])[1] || "";
          const cls = (tok.match(/class="([^"]*)"/) || [])[1] || "";
          if (/font-weight:\s*(bold|bold(er)?|[6-9]00)/i.test(style)) cur.bold = true;
          if (/font-style:\s*italic/i.test(style)) cur.italic = true;
          if (/text-decoration[^;]*underline/i.test(style) && !/line-through/i.test(style)) cur.u = true;
          if (/line-through/i.test(style)) cur.strike = true;
          if (/inline-code/.test(cls)) cur.code = true;
          styleStack.push(cur);
        } else if (/^<\/span/i.test(tok)) {
          if (styleStack.length > 1) styleStack.pop();
        } else if (/^<a\b/i.test(tok)) {
          const cur = { ...styleStack[styleStack.length - 1] };
          let href = (tok.match(/href="([^"]*)"/) || [])[1] || "";
          try { href = decodeURIComponent(href); } catch (e) {}
          if (/^javascript:/i.test(href)) href = "";
          cur.href = href;
          styleStack.push(cur);
        } else if (/^<\/a/i.test(tok)) {
          if (styleStack.length > 1) styleStack.pop();
        } else if (/^<br\b/i.test(tok)) {
          runs.push({ t: "\n", s: styleStack[styleStack.length - 1] });
        }
      } else {
        const text = decodeEntities(tok).replace(/\u200B/g, "");
        if (text) runs.push({ t: text, s: styleStack[styleStack.length - 1] });
      }
    }
    const merged = [];
    for (const r of runs) {
      const key = JSON.stringify([!!r.s.bold, !!r.s.italic, !!r.s.code, !!r.s.u, !!r.s.strike, r.s.href || ""]);
      const last = merged[merged.length - 1];
      if (last && last.key === key) last.t += r.t;
      else merged.push({ ...r, key });
    }
    let out = "";
    for (const r of merged) {
      let t = r.t;
      if (r.s.code) { out += "`" + t + "`"; continue; }
      if (r.s.href) {
        const inner = (r.s.bold ? "**" : "") + (r.s.italic ? "*" : "") + t + (r.s.italic ? "*" : "") + (r.s.bold ? "**" : "");
        out += `[${inner}](${r.s.href})`;
        continue;
      }
      if (r.s.bold) t = `**${t}**`;
      if (r.s.italic) t = `*${t}*`;
      if (r.s.strike) t = `~~${t}~~`;
      if (r.s.u) t = `<u>${t}</u>`;
      out += t;
    }
    mdLines.push(out);
  }
  return mdLines.filter(l => l.trim().length).join("  \n");
}

const zoneToMd = (b) => (b.zoneHtml ? inlineHtmlToMd(b.zoneHtml).replace(/\u200B/g, "").trim() : "");

// 代码块: 逐行取纯文本 (不做内联 markdown 转换)
function zoneToCode(b) {
  if (!b.zoneHtml) return "";
  const segs = b.zoneHtml.split(/<div[^>]*class="[^"]*ace-line[^"]*"[^>]*>/);
  const lines = segs.map(s => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\u200B/g, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

// ---------- 3. 表格 ----------
function cellContent(cellId) {
  const inner = cellBlocks[cellId] || [];
  const parts = [];
  for (const b of inner) {
    if (["text", "heading1", "heading2", "quote", "quote_container", "callout", "bullet", "ordered"].includes(b.type)) {
      const s = zoneToMd(b);
      if (s) parts.push(s.replace(/\n/g, "<br>").replace(/\|/g, "\\|"));
    } else if (b.type === "image") {
      if (imgFile[b.id]) parts.push(`![](${imgFile[b.id]})`);
    }
  }
  return parts.join("<br>");
}

function tableToMd(tableHtml) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let trM;
  while ((trM = trRe.exec(tableHtml))) {
    const cells = [];
    const tdRe = /<td[^>]*>/g;
    let tdM;
    while ((tdM = tdRe.exec(trM[1]))) {
      const tag = tdM[0];
      const bid = (tag.match(/data-block-id="(\w+)"/) || [])[1];
      cells.push(bid ? cellContent(bid) : "");
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return "";
  const nCols = Math.max(...rows.map(r => r.length));
  for (const r of rows) while (r.length < nCols) r.push("");
  const out = ["| " + rows[0].join(" | ") + " |", "|" + Array(nCols).fill(" --- ").join("|") + "|"];
  for (let i = 1; i < rows.length; i++) out.push("| " + rows[i].join(" | ") + " |");
  return out.join("\n");
}

// ---------- 4. 块树 ----------
// SSR id 即文档顺序; 图片懒加载引发的布局重排可能让采集顺序乱, 按 id 排序恢复
blocks.sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
const nodes = blocks.map(b => ({ ...b, children: [] }));
const stack = [];
const roots = [];
for (const n of nodes) {
  while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
  if (!stack.length) roots.push(n);
  else stack[stack.length - 1].children.push(n);
  stack.push(n);
}

// ---------- 5. 渲染 ----------
const md = [];

function renderChildren(children, listAnc) {
  for (const c of children) { c.__listAnc = listAnc; render(c); }
}

function render(n) {
  const t = n.type;
  const text = zoneToMd(n);
  const anc = n.__listAnc || 0;

  if (t === "page") {
    md.push("# " + (text || docTitle || "飞书文档"), "");
    if (imgFile["__cover__"]) { md.push(`![cover](${imgFile["__cover__"]})`, ""); }
    renderChildren(n.children, 0);
    return;
  }
  if (t === "grid" || t === "grid_column" || t === "view") {
    renderChildren(n.children, anc);
    return;
  }
  if (t === "heading1" || t === "heading2" || t === "heading3" || t === "heading4") {
    const lvl = t === "heading1" ? 2 : t === "heading2" ? 3 : t === "heading3" ? 4 : 5;
    md.push("", "#".repeat(lvl) + " " + text, "");
    renderChildren(n.children, 0);
    return;
  }
  if (t === "code") {
    const code = zoneToCode(n);
    md.push("", "```text\n" + code + "\n```", "");
    renderChildren(n.children, 0);
    return;
  }
  if (t === "text") {
    if (text) md.push("  ".repeat(anc) + text);
    else md.push("");
    renderChildren(n.children, anc);
    return;
  }
  if (t === "bullet") {
    md.push("  ".repeat(anc) + "- " + text);
    renderChildren(n.children, anc + 1);
    return;
  }
  if (t === "ordered") {
    md.push("  ".repeat(anc) + (n.order || "1.") + " " + text);
    renderChildren(n.children, anc + 1);
    return;
  }
  if (t === "quote" || t === "quote_container") {
    if (text) md.push("> " + text.replace(/\n/g, "\n> "));
    renderChildren(n.children, 0);
    return;
  }
  if (t === "callout") {
    const lines = text.split("\n");
    md.push("", "> " + lines.join("\n> ").replace(/^> $/gm, ">"), "");
    renderChildren(n.children, 0);
    return;
  }
  if (t === "image") {
    const file = imgFile[n.id];
    const cap = (n.caption || "").replace(/\u200B/g, "").trim();
    md.push("");
    if (file) md.push(`![${cap || "image"}](${file})`);
    else md.push(`<!-- 图片缺失 token=${n.imgToken} -->`);
    if (cap) md.push(`*${cap}*`);
    md.push("");
    return;
  }
  if (t === "table") {
    md.push("");
    let tbl = "";
    if (Array.isArray(n.rows) && n.rows.length) {
      // tr[data-index] 行容器采集的完整网格
      const grid = n.rows.map(r => r.map(id => cellContent(id)));
      const nCols = Math.max(...grid.map(r => r.length));
      for (const r of grid) while (r.length < nCols) r.push("");
      const out = ["| " + grid[0].join(" | ") + " |", "|" + Array(nCols).fill(" --- ").join("|") + "|"];
      for (let i = 1; i < grid.length; i++) out.push("| " + grid[i].join(" | ") + " |");
      tbl = out.join("\n");
    } else if (n.tableHtml) {
      tbl = tableToMd(n.tableHtml);
    }
    md.push(tbl || "<!-- 空表格 -->", "");
    return;
  }
  if (t === "divider") {
    md.push("", "---", "");
    return;
  }
  if (t === "whiteboard") {
    md.push("", "> 🖊️ **白板内容**（飞书画板，无法导出为文本，请查看原文档）", "");
    return;
  }
  if (t === "isv") {
    const png = "images/isv_" + n.id + ".png";
    md.push("");
    if (fs.existsSync(png)) {
      md.push(`![嵌入卡片](images/isv_${n.id}.png)`);
    } else {
      const info = (n.isvData || "").replace(/\u200B/g, " ").replace(/\s+/g, " ").trim();
      md.push("> 🧩 **第三方嵌入块**（" + (info || "登录后可见") + "）");
    }
    md.push("");
    return;
  }
  if (t === "file") {
    const vid = "files/" + n.id + ".mp4";
    md.push("");
    if (fs.existsSync(vid)) {
      md.push(`▶️ **嵌入视频**（31 秒录屏）: [点击播放](files/${n.id}.mp4)`);
    } else {
      const clean = (n.fileHtml || "")
        .replace(/<img[\s\S]*?(\/>|>|$)/g, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/\u200B/g, " ")
        .replace(/\s+/g, " ").trim();
      md.push(`> 🎙️ **音频/附件**: ${clean.slice(0, 80) || "飞书附件"}（请到原文档查看/下载）`);
    }
    md.push("");
    return;
  }
  if (t === "back_ref_list" || t === "back_ref") {
    return; // 相关文档反链面板, 非正文内容
  }
  if (text) md.push(text);
  renderChildren(n.children, anc);
}

render(nodes.find(n => n.type === "page") || roots[0]);

let outMd = md.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
const srcUrl = process.env.SRC_URL || "https://my.feishu.cn/docx";
const header = `<!-- 来源: ${srcUrl} -->\n<!-- 导出时间: ${new Date().toISOString()} -->\n\n`;
const safeTitle = docTitle.replace(/[\\/:*?"<>|]/g, "-").trim() || "feishu_doc";
const outFile = outName || safeTitle + ".md";
fs.writeFileSync(outFile, header + outMd, "utf8");
console.log("完成 ->", outFile, "|", outMd.length, "字符");
