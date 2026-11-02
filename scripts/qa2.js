#!/usr/bin/env node
// QA v2: 校验生成的 markdown 与采集数据的一致性
const fs = require("fs");
const f = process.argv[2];
const blocksFile = process.argv[3];
const md = fs.readFileSync(f, "utf8");
console.log("文件:", f);
console.log("总长:", md.length, "| 图片:", (md.match(/!\[/g) || []).length, "| 表格行:", (md.match(/^\|/gm) || []).length, "| 代码块:", (md.match(/```/g) || []).length / 2);
if (blocksFile) {
  const { blocks } = JSON.parse(fs.readFileSync(blocksFile, "utf8"));
  const used = new Set([...md.matchAll(/images\/(\w+)\./g)].map(m => m[1]));
  const imgs = blocks.filter(b => b.type === "image");
  const miss = imgs.filter(b => !used.has(b.id));
  console.log("图片块:", imgs.length, "| md未引用:", miss.length, miss.length ? JSON.stringify(miss.map(b => b.id)) : "✓ 全部引用");
  const isv = blocks.filter(b => b.type === "isv");
  const isvMiss = isv.filter(b => !used.has("isv_" + b.id) && !md.includes("images/isv_" + b.id + ".png"));
  console.log("嵌入块:", isv.length, "| 未引用:", isvMiss.length ? JSON.stringify(isvMiss.map(b => b.id)) : "✓ 全部引用");
  const tables = blocks.filter(b => b.type === "table");
  const rowsInData = tables.reduce((s, t) => s + (Array.isArray(t.rows) ? t.rows.length : 0), 0);
  console.log("表格:", tables.length, "| 数据行:", rowsInData, "| md 行(含分隔):", (md.match(/^\|/gm) || []).length);
}
console.log("残留HTML:", (md.match(/<div|<span/g) || []).length, "| ZWSP:", md.includes("\u200B") ? "有" : "无");
console.log("--- 标题结构 ---");
for (const l of md.split("\n")) if (/^#{1,4} /.test(l)) console.log("  " + l);
