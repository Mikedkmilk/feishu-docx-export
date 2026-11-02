#!/usr/bin/env node
// 补采表格 v2: 按 tr[data-index] 行容器采集 (虚拟化表格的行不在 <table> html 里)
// 用法: node recollect_tables.js <tabId> <blocksFile>
const fs = require("fs");

const http = require("http");
const CDP = "http://127.0.0.1:9222";
function httpReq(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET" }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
    });
    req.on("error", reject); req.end();
  });
}
function cdpEval(tabId, expression, timeoutMs = 60000) {
  return httpReq(`${CDP}/json/list`).then((list) => {
    const tab = JSON.parse(list).find((t) => t.id === tabId);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(tab.webSocketDebuggerUrl);
      const id = Math.floor(Math.random() * 1e9);
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("CDP timeout")); }, timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else if (msg.result && msg.result.exceptionDetails) reject(new Error("eval exception"));
          else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
        }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("WS error")); };
    });
  });
}

const SNAP_FN = `(() => {
  const out = [];
  for (const e of document.querySelectorAll('[data-block-id]')) {
    if (!e.className.includes('table-block')) continue;
    const id = e.getAttribute('data-block-id');
    const rows = [...e.querySelectorAll('tr[data-index]')].map(r => ({
      i: parseInt(r.getAttribute('data-index')),
      tds: [...r.querySelectorAll('td[data-block-id]')].map(td => td.getAttribute('data-block-id')),
    }));
    out.push({ id, rows });
  }
  return JSON.stringify(out);
})()`;

async function main() {
  const tabId = process.argv[2];
  const blocksFile = process.argv[3];
  const data = JSON.parse(fs.readFileSync(blocksFile, "utf8"));
  const best = {}; // tableId -> {i: tds[]} 完整行映射
  const cnt = {};
  for (let pass = 0; pass < 3; pass++) {
    await cdpEval(tabId, `document.querySelector('.bear-web-x-container').scrollTop = 0; 'top'`);
    await new Promise(r => setTimeout(r, 800));
    let stagnant = 0, lastPos = -1;
    for (let i = 0; i < 300; i++) {
      const got = JSON.parse(await cdpEval(tabId, SNAP_FN) || "[]");
      for (const t of got) {
        if (!best[t.id]) best[t.id] = {};
        for (const r of t.rows) {
          if (r.tds.length && (!best[t.id][r.i] || r.tds.length > best[t.id][r.i].length)) best[t.id][r.i] = r.tds;
        }
      }
      const pos = JSON.parse(await cdpEval(tabId, `(()=>{const sc=document.querySelector('.bear-web-x-container');sc.scrollTop+=300;return JSON.stringify({after:sc.scrollTop,max:sc.scrollHeight})})()`) || "{}");
      if (pos.after === lastPos) stagnant++; else stagnant = 0;
      lastPos = pos.after;
      if (stagnant > 5) break;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  for (const b of data.blocks) if (b.type === "table" && best[b.id]) {
    const rows = Object.entries(best[b.id]).map(([i, tds]) => ({ i: +i, tds })).sort((a, b) => a.i - b.i);
    b.rows = rows.map(r => r.tds);
  }
  fs.writeFileSync(blocksFile, JSON.stringify(data), "utf8");
  console.log("表格行采集结果:");
  for (const b of data.blocks) if (b.type === "table") {
    const rows = b.rows || [];
    const cells = rows.reduce((s, r) => s + r.length, 0);
    console.log(`  table ${b.id}: ${rows.length} 行, ${cells} 单元格, 列数=${Math.max(0, ...rows.map(r => r.length))}`);
  }
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
