#!/usr/bin/env node
// 批量采集 file 块媒体: 逐块滚入视口 → 等 video/audio 渲染 → 抓 src → 下载
// 用法: node collect_files.js <tabId> <blocksFile> <filesDir>
const fs = require("fs");
const path = require("path");
const http = require("http");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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
  const filesDir = process.argv[4];
  const data = JSON.parse(fs.readFileSync(blocksFile, "utf8"));
  const fileBlocks = data.blocks.filter(b => b.type === "file");
  console.log(`file 块: ${fileBlocks.length} 个`);

  const list = JSON.parse(await httpReq("http://127.0.0.1:9222/json/list"));
  const tab = list.find(t => t.id === tabId);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); } };
  await new Promise(r => { ws.onopen = r; });
  const evalV = async (e) => {
    const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
    return r.result ? r.result.value : undefined;
  };

  // 全页慢扫: 每见到 file 块就记录其媒体 src (跨滚动轮次保留最新)
  const found = new Map(); // blockId -> src
  await evalV("document.querySelector('.bear-web-x-container').scrollTop = 0; 1");
  let last = -1, stag = 0, sweeps = 0;
  for (let i = 0; i < 150 && sweeps < 2 && found.size < fileBlocks.length; i++) {
    const got = JSON.parse(await evalV(`(() => {
      const out = [];
      for (const e of document.querySelectorAll('[data-block-id]')) {
        if ((e.getAttribute('data-block-type')||'') !== 'file') continue;
        const m = e.querySelector('video,audio');
        out.push({ id: e.getAttribute('data-block-id'), src: m ? (m.src || m.getAttribute('data-src') || '') : '' });
      }
      return JSON.stringify(out);
    })()`) || "[]");
    for (const x of got) if (x.src && x.src.startsWith("http")) found.set(x.id, x.src);
    const pos = JSON.parse(await evalV("(() => { const sc = document.querySelector('.bear-web-x-container'); sc.scrollTop = Math.min(sc.scrollTop + 450, sc.scrollHeight); return JSON.stringify({p: sc.scrollTop, m: sc.scrollHeight}); })()"));
    if (pos.p === last) { stag++; if (stag > 3) { sweeps++; await evalV("document.querySelector('.bear-web-x-container').scrollTop = 0; 1"); stag = 0; last = -1; await new Promise(r => setTimeout(r, 800)); continue; } }
    else stag = 0;
    last = pos.p;
    await new Promise(r => setTimeout(r, 380));
  }
  console.log(`捕获媒体 src: ${found.size}/${fileBlocks.length}`);

  // 提取 token 并下载
  fs.mkdirSync(filesDir, { recursive: true });
  let ok = 0, fail = 0;
  for (const b of fileBlocks) {
    const src = found.get(b.id);
    if (!src) { console.log(`  ✗ 块 ${b.id}: 未捕获 src`); fail++; continue; }
    const token = (src.match(/download\/video\/([A-Za-z0-9]+)/) || src.match(/download\/all\/([A-Za-z0-9]+)/) || [])[1];
    if (!token) { console.log(`  ✗ 块 ${b.id}: src 无 token (${src.slice(0, 80)})`); fail++; continue; }
    const out = path.join(filesDir, token + ".mp4");
    if (fs.existsSync(out) && fs.statSync(out).size > 10000) { ok++; b.fileToken = token; continue; } // 增量
    try {
      const res = await fetch(src, { headers: { "User-Agent": UA, Cookie: (await httpReq("http://127.0.0.1:9222/json/list"), fs.readFileSync(path.join(process.env.TEMP || "/tmp", "feishu_cookies.txt"), "utf8")), Referer: "https://bytedance.larkoffice.com/" } });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 200 && buf.length > 10000) { fs.writeFileSync(out, buf); ok++; b.fileToken = token; console.log(`  ✓ 块 ${b.id} -> ${token}.mp4 (${(buf.length / 1024 / 1024).toFixed(1)}MB)`); }
      else { fail++; console.log(`  ✗ 块 ${b.id}: HTTP ${res.status}, ${buf.length}B`); }
    } catch (e) { fail++; console.log(`  ✗ 块 ${b.id}: ${e.message.slice(0, 60)}`); }
  }
  fs.writeFileSync(blocksFile, JSON.stringify(data), "utf8");
  console.log(`下载完成: ${ok} 成功, ${fail} 失败`);
  process.exit(0);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
