#!/usr/bin/env node
// 表格恢复: 慢速全页扫描, 按文档顺序抓取每张完整渲染的 <table> outerHTML,
// 按顺序替换 blocks 数据里 table 块的 tableHtml (用于行渲染不全的会话)
// 用法: node table_recovery.js <tabId> <blocksFile>
const fs = require("fs");
const http = require("http");

function httpReq(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET" }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
    });
    req.on("error", reject); req.end();
  });
}

async function main() {
  const tabId = process.argv[2];
  const blocksFile = process.argv[3];
  const data = JSON.parse(fs.readFileSync(blocksFile, "utf8"));
  const tables = data.blocks.filter(b => b.type === "table");
  if (!tables.length) { console.log("数据里没有表格块"); process.exit(0); }

  const list = JSON.parse(await httpReq("http://127.0.0.1:9222/json/list"));
  const tab = list.find(t => t.id === tabId);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); } };
  await new Promise(r => { ws.onopen = r; });
  const evalV = async (e) => {
    const r = await send("Runtime.evaluate", { expression: e, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
    return r.result ? r.result.value : undefined;
  };

  const SNAP = `(() => {
    const out = [];
    // 表格可能挂在带/不带 data-block-id 的块上, 按 class 兜底匹配
    const seen = new Set();
    for (const t of document.querySelectorAll('.docx-table-block table, [data-block-type=table] table')) {
      const blk = t.closest('[data-block-id]');
      const key = blk ? blk.getAttribute('data-block-id') : 'tbl-' + out.length;
      if (seen.has(key)) continue;
      seen.add(key);
      const rows = [...t.querySelectorAll('tr')].map(r => [...r.querySelectorAll('td,th')].map(c => (c.innerText || '').replace(/\\u200B/g, '').trim().slice(0, 40)));
      out.push({ key, html: t.outerHTML, rows, firstRow: (rows[0] || []).join('|') });
    }
    return JSON.stringify(out);
  })()`;

  // 慢速全页扫描, 每个 key 保留行数最多的版本
  const best = new Map(); // key -> {html, rows, firstRow}
  await evalV("document.querySelector('.bear-web-x-container').scrollTop = 0; 1");
  let last = -1, stag = 0, sweepDone = 0;
  for (let i = 0; i < 120 && sweepDone < 2; i++) {
    const got = JSON.parse(await evalV(SNAP) || "[]");
    for (const t of got) {
      const prev = best.get(t.firstRow);
      if (!prev || t.html.length > prev.html.length) best.set(t.firstRow, t);
    }
    const pos = await evalV("(() => { const sc = document.querySelector('.bear-web-x-container'); sc.scrollTop = Math.min(sc.scrollTop + 350, sc.scrollHeight); return JSON.stringify({p: sc.scrollTop, m: sc.scrollHeight}); })()");
    const { p, m } = JSON.parse(pos);
    if (p === last) { stag++; if (stag > 3) { sweepDone++; await evalV("document.querySelector('.bear-web-x-container').scrollTop = 0; 1"); stag = 0; last = -1; await new Promise(r => setTimeout(r, 600)); continue; } }
    else stag = 0;
    last = p;
    await new Promise(r => setTimeout(r, 350));
  }

  const captured = [...best.values()];
  console.log(`捕获 ${captured.length} 张表格 (数据里 ${tables.length} 张)`);
  captured.forEach((c, i) => console.log(`  [${i}] ${c.rows.length} 行 x ${c.rows[0] ? c.rows[0].length : 0} 列 | 首行: ${c.firstRow.slice(0, 50)}`));

  if (captured.length >= tables.length) {
    // 按文档顺序 1:1 替换
    tables.forEach((t, i) => {
      const c = captured[i];
      if (c) { t.tableHtml = c.html; t.rows = c.rows; }
    });
    fs.writeFileSync(blocksFile, JSON.stringify(data), "utf8");
    console.log("✓ 已按文档顺序替换 tableHtml/rows");
  } else {
    console.log("✗ 捕获数量不足, 未替换");
    process.exit(1);
  }
  process.exit(0);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
