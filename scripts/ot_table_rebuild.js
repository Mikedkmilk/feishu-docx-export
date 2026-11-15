#!/usr/bin/env node
// 从 OT clientVars 重建表格: rows_id × columns_id → cell_set → 单元格子块文本
// 用法: node ot_table_rebuild.js <clientvars.json> <blocksFile>
const fs = require("fs");

const [cvFile, blocksFile] = process.argv.slice(2);
const cv = JSON.parse(fs.readFileSync(cvFile, "utf8"));
const bm = cv.data.block_map;
const data = JSON.parse(fs.readFileSync(blocksFile, "utf8"));

const apoolText = (t) => {
  if (!t || !t.initialAttributedTexts) return "";
  const x = t.initialAttributedTexts.text || {};
  return Object.keys(x).sort((a, b) => (+a) - (+b)).map(k => x[k]).join("");
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let patched = 0;
for (const t of data.blocks.filter(b => b.type === "table")) {
  const rec = t.recordId || "";
  const full = Object.keys(bm).find(k => rec.startsWith(k.slice(0, 14)) && bm[k].data.type === "table");
  if (!full) { console.log(`table ${t.id}: recordId ${rec.slice(0, 14)} 不在 OT chunk, 保留原样`); continue; }
  const ot = bm[full].data;
  const grid = [];
  for (const rid of ot.rows_id) {
    const row = [];
    for (const cid of ot.columns_id) {
      const entry = ot.cell_set[rid + cid];
      let txt = "";
      if (entry && entry.block_id) {
        const cell = bm[entry.block_id];
        if (cell && cell.data.children) txt = cell.data.children.map(c2 => apoolText(bm[c2] && bm[c2].data.text)).filter(Boolean).join(" ");
        else if (cell && cell.data.text) txt = apoolText(cell.data.text);
      }
      row.push(esc((txt || "").replace(/\u200B/g, "").trim()));
    }
    grid.push(row);
  }
  const html = "<table>" + grid.map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("") + "</table>";
  t.tableHtml = html;
  t.cellTexts = grid; // md_gen 优先用文本矩阵 (tableToMd 的 td 需带 data-block-id 才能取到内容)
  delete t.rows;
  console.log(`✓ table ${t.id}: 重建 ${grid.length} 行 x ${grid[0].length} 列 | 首行: ${grid[0].join(" | ").slice(0, 60)}`);
  patched++;
}
fs.writeFileSync(blocksFile, JSON.stringify(data), "utf8");
console.log(`替换完成: ${patched} 张表格`);
