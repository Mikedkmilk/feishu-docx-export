#!/usr/bin/env node
// QA v3: 校验生成的 markdown 与采集数据的一致性 (兼容 token / 块 id 两种资产命名)
const fs = require("fs");
const f = process.argv[2];
const blocksFile = process.argv[3];
const md = fs.readFileSync(f, "utf8");
console.log("文件:", f);
console.log("总长:", md.length, "| 图片:", (md.match(/!\[/g) || []).length, "| 表格行:", (md.match(/^\|/gm) || []).length, "| 代码块:", (md.match(/```/g) || []).length / 2);
if (blocksFile) {
  const { blocks, cellBlocks } = JSON.parse(fs.readFileSync(blocksFile, "utf8"));
  const mdRefs = [...new Set([...md.matchAll(/images\/([\w]+)\.(\w+)/g)].map(m => m[1]))];
  const mdRefSet = new Set(mdRefs);
  // 磁盘文件名集合 (images/ 下全部文件去扩展名)
  const disk = new Set(fs.readdirSync("images").map(x => x.replace(/\.[^.]+$/, "")));
  // 收集所有图片块 (主流程 + 单元格内); 每块候选名: img_<token> 与块 id (兼容两种命名)
  const imgs = [];
  for (const b of blocks) if (b.type === "image") imgs.push(b);
  for (const arr of Object.values(cellBlocks || {})) for (const b of arr) if (b.type === "image") imgs.push(b);
  const missRef = [], missFile = [];
  for (const b of imgs) {
    const cands = [...new Set([b.imgToken ? "img_" + b.imgToken : null, b.id].filter(Boolean))];
    if (!cands.some(c => mdRefSet.has(c))) missRef.push(b.id);
    if (!cands.some(c => disk.has(c))) missFile.push(b.id);
  }
  console.log("图片块:", imgs.length, "| 未入md:", missRef.length ? JSON.stringify(missRef) : "✓", "| 本地缺文件:", missFile.length ? JSON.stringify(missFile) : "✓");
  // md 里引用了却不在磁盘上的
  const badRef = mdRefs.filter(r => !disk.has(r));
  console.log("md引用但缺文件:", badRef.length ? JSON.stringify(badRef) : "✓");
  // 嵌入卡片: recordId 或块 id 两种命名都认
  const isv = blocks.filter(b => b.type === "isv");
  const isvMiss = isv.filter(b => {
    const cands = [...new Set([(b.recordId || "").slice(0, 16), b.id].filter(Boolean))];
    return !cands.some(c => disk.has("isv_" + c));
  });
  const isvInMd = (md.match(/images\/isv_/g) || []).length;
  console.log("嵌入块:", isv.length, "| md引用:", isvInMd, "| 无渲染图:", isvMiss.length ? JSON.stringify(isvMiss.map(b => b.id)) : "✓ 全部有图");
  const tables = blocks.filter(b => b.type === "table");
  const rowsInData = tables.reduce((s, t) => s + (Array.isArray(t.rows) ? t.rows.length : 0), 0);
  console.log("表格:", tables.length, "| 数据行:", rowsInData, "| md 行(含分隔):", (md.match(/^\|/gm) || []).length);
  // callout 图标
  const cos = blocks.filter(b => b.type === "callout");
  const withIcon = cos.filter(b => b.icon).length;
  console.log("callout:", cos.length, "| 有图标:", withIcon);
}
console.log("残留HTML:", (md.match(/<div|<span/g) || []).length, "| ZWSP:", md.includes("\u200B") ? "有" : "无");
console.log("--- 标题结构 ---");
for (const l of md.split("\n")) if (/^#{1,4} /.test(l)) console.log("  " + l);
