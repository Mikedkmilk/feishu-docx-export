#!/usr/bin/env node
// 从嵌入块 iframe 的嵌套 srcdoc 中提取用户原始 HTML
// 用法: node extract_srcdoc.js <输出json>
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
  const outFile = process.argv[2];
  const list = JSON.parse(await httpReq("http://127.0.0.1:9222/json/list"));
  const ver = JSON.parse(await httpReq("http://127.0.0.1:9222/json/version"));
  const targets = list.filter(t => t.type === "iframe" && /feishupkg|larksuite|blk_|larkoffice|feishu/i.test(t.url) && !/accounts.|session-tools|passport/.test(t.url));
  console.error(`iframe targets: ${targets.length}`);

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  await new Promise(res => { ws.onopen = res; });

  const results = [];
  for (const t of targets) {
    try {
      const att = await send("Target.attachToTarget", { targetId: t.id, flatten: true });
      const sid = att.sessionId;
      const r = await send("Runtime.evaluate", {
        expression: `(() => {
          const f = document.querySelector('iframe');
          if (!f || !f.srcdoc) return JSON.stringify({err: 'no srcdoc'});
          const sd = f.srcdoc;
          const key = (sd.match(/renderKey="([^"]+)"/) || [])[1] || '';
          const desc = (sd.match(/description" content="([^"]*)"/) || [])[1] || '';
          const parts = key.split(':');
          const origLen = parseInt(parts[2]) || 0;
          const start = sd.indexOf('<!doctype html>');
          return JSON.stringify({ key, desc, origLen, start, total: sd.length, html: sd });
        })()`,
        returnByValue: true,
      }, sid);
      const val = JSON.parse(r.result.value);
      val.targetId = t.id;
      results.push(val);
      console.error(`  ${t.id.slice(0, 8)}: desc="${(val.desc || val.err || '').slice(0, 40)}" origLen=${val.origLen}`);
      await send("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
    } catch (e) {
      console.error(`  ${t.id.slice(0, 8)} 失败: ${e.message.slice(0, 80)}`);
    }
  }
  fs.writeFileSync(outFile, JSON.stringify(results), "utf8");
  console.log(`提取 ${results.length} 个 srcdoc -> ${outFile}`);
  process.exit(0);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
