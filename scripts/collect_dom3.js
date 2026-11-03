#!/usr/bin/env node
// 采集 v3: 单轮滚动 + 原地更新 + 表格 portal 容器按 td 归属采集单元格内容
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

function cdpEval(tabId, expression, timeoutMs = 120000) {
  return httpReq(`${CDP}/json/list`).then((list) => {
    const tabs = JSON.parse(list);
    const tab = tabs.find((t) => t.id === tabId) || tabs.find((t) => t.type === "page");
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
          else if (msg.result && msg.result.exceptionDetails) reject(new Error(msg.result.exceptionDetails.exception?.description || "eval exception"));
          else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
        }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("WS error")); };
    });
  });
}

// 主采集: 每块自己的 zone + 表格 html + 图片 token; 单元格内块单独归到 cellMap
const COLLECT_FN = `(window.__collect3 = window.__collect3 || function(){
  const out = {blocks: [], cellBlocks: {}};
  for (const e of document.querySelectorAll('[data-block-id]')) {
    const id = e.getAttribute('data-block-id');
    const type = e.getAttribute('data-block-type') || (e.className.match(/docx-([a-z_0-9]+)-block/) || [])[1] || 'unknown';
    const inCell = e.closest('td[data-block-id]');
    const cellId = inCell ? inCell.getAttribute('data-block-id') : null;
    const zones = [...e.querySelectorAll('[data-zone-id]')].filter(z => z.getAttribute('data-zone-id') === id);
    const zoneHtml = zones.map(z => z.innerHTML).join('\\n');
    const imgTokenEl = e.querySelector('[image-token]');
    const rec = {
      id, type,
      recordId: e.getAttribute('data-record-id') || '',
      zoneHtml,
      tableHtml: type === 'table' ? (e.querySelector('table') ? e.querySelector('table').outerHTML : '') : '',
      order: type === 'ordered' ? ((e.querySelector('.order') || {}).innerText || '').trim() : '',
      imgToken: imgTokenEl ? imgTokenEl.getAttribute('image-token') : null,
      caption: type === 'image' ? (((e.querySelector('[class*=caption]') || {}).innerText) || '').slice(0, 300) : '',
      // callout 图标: 剔除所有子块与 zone 后剩余的 emoji 文本 (图标渲染在块的图标槽里, 不在任何 zone 中)
      icon: type === 'callout' ? (() => {
        try {
          const clone = e.cloneNode(true);
          clone.querySelectorAll('[data-block-id]').forEach(x => x.remove());
          clone.querySelectorAll('[data-zone-id]').forEach(x => x.remove());
          const t = (clone.innerText || '').replace(/\\u200B/g, '').trim();
          const m = t.match(/[\\p{Extended_Pictographic}][\\uFE0F\\u200D]?/u);
          return m ? m[0] : '';
        } catch (err) { return ''; }
      })() : '',
      fileHtml: type === 'file' ? e.innerHTML.slice(0, 5000) : '',
      isvData: type === 'isv' ? (e.innerText || '').slice(0, 100) : '',
      depth: (() => { let d = 0, p = e.parentElement; while (p) { if (p.hasAttribute && p.hasAttribute('data-block-id')) d++; p = p.parentElement; } return d; })(),
    };
    if (cellId) {
      if (!out.cellBlocks[cellId]) out.cellBlocks[cellId] = [];
      if (!out.cellBlocks[cellId].some(b => b.id === id)) out.cellBlocks[cellId].push(rec);
    } else {
      out.blocks.push(rec);
    }
  }
  return out;
})()`;

const SCROLL_FN = `(() => {
  const sc = document.querySelector('.bear-web-x-container') || document.scrollingElement;
  const before = sc.scrollTop;
  sc.scrollTop = Math.min(before + 500, sc.scrollHeight);
  return JSON.stringify({ after: sc.scrollTop, max: sc.scrollHeight });
})()`;

async function main() {
  const tabId = process.argv[2];
  const outFile = process.argv[3];
  await cdpEval(tabId, `document.querySelector('.bear-web-x-container').scrollTop = 0; 'top'`);
  const blocks = [];            // 有序主流程块
  const index = {};             // id -> block 引用
  const cellBlocks = {};        // cellId -> [block]
  let stagnant = 0;
  for (let i = 0; i < 500; i++) {
    const got = await cdpEval(tabId, COLLECT_FN);
    if (got && Array.isArray(got.blocks)) {
      for (const b of got.blocks) {
        if (index[b.id]) Object.assign(index[b.id], b);
        else { index[b.id] = b; blocks.push(b); }
      }
      for (const [cid, arr] of Object.entries(got.cellBlocks || {})) {
        if (!cellBlocks[cid]) cellBlocks[cid] = [];
        for (const b of arr) {
          const ex = cellBlocks[cid].find(x => x.id === b.id);
          if (ex) Object.assign(ex, b);
          else cellBlocks[cid].push(b);
        }
      }
    }
    const pos = JSON.parse(await cdpEval(tabId, SCROLL_FN) || "{}");
    stagnant = (pos.after !== undefined && pos.after >= pos.max - 5) ? stagnant + 1 : 0;
    if (stagnant >= 5) break;
    await new Promise(r => setTimeout(r, 300));
  }
  require("fs").writeFileSync(outFile, JSON.stringify({ blocks, cellBlocks }, null, 1), "utf8");
  const types = {};
  for (const b of blocks) types[b.type] = (types[b.type] || 0) + 1;
  const cellCount = Object.values(cellBlocks).reduce((s, a) => s + a.length, 0);
  console.log(`主流程块 ${blocks.length}, 单元格内块 ${cellCount} (分布在 ${Object.keys(cellBlocks).length} 个 cell) -> ${outFile}`);
  console.log("类型:", JSON.stringify(types));
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
