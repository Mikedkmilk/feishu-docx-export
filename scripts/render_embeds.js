#!/usr/bin/env node
// 把嵌入块 HTML 渲染成 PNG: 打开文件 -> 量高度 -> 2x 截图
// 用法: node render_embeds.js <embeds目录> <images输出目录> <文件名列表json>
const fs = require("fs");
const path = require("path");
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
  const [embedsDir, imagesDir, listFile] = process.argv.slice(2);
  const files = JSON.parse(fs.readFileSync(listFile, "utf8")); // [{htmlFile, outPng}]
  const ver = JSON.parse(await httpReq("http://127.0.0.1:9222/json/version"));

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const events = [];
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
      return;
    }
    events.push(msg);
  };
  await new Promise(res => { ws.onopen = res; });
  const created = await send("Target.createTarget", { url: "about:blank" });
  const targetId = created.targetId;
  const att = await send("Target.attachToTarget", { targetId, flatten: true });
  const sid = att.sessionId;
  await send("Page.enable", {}, sid);

  for (const job of files) {
    const fileUrl = encodeURI("file:///" + path.resolve(job.htmlFile).replace(/\\/g, "/"));
    await send("Page.navigate", { url: fileUrl }, sid);
    // 等待加载完成且 body 有实际内容
    let dim = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const m = await send("Runtime.evaluate", {
          expression: "JSON.stringify({rs:document.readyState,url:location.href.slice(0,60),h:document.body?document.body.scrollHeight:0,hasEl:document.querySelectorAll('.card,.steps,.concl,div').length})",
          returnByValue: true,
        }, sid);
        const s = JSON.parse(m.result.value);
        if (s.rs === "complete" && s.h > 50) { dim = s; break; }
      } catch (e) {}
    }
    if (!dim) { console.log(`${job.outPng}: 加载失败`); continue; }
    const m2 = await send("Runtime.evaluate", {
      expression: `(() => {
        const root = document.querySelector('.html-box-app-root') || document.body;
        const b = root.getBoundingClientRect();
        return JSON.stringify({ w: Math.ceil(b.width), h: Math.ceil(b.height) });
      })()`,
      returnByValue: true,
    }, sid);
    const size = JSON.parse(m2.result.value);
    const scale = 2;
    await send("Emulation.setDeviceMetricsOverride", {
      width: Math.max(704, size.w), height: size.h + 4, deviceScaleFactor: scale, mobile: false,
    }, sid);
    await new Promise(r => setTimeout(r, 400));
    const shot = await send("Page.captureScreenshot", { format: "png" }, sid);
    fs.writeFileSync(job.outPng, Buffer.from(shot.data, "base64"));
    console.log(`${path.basename(job.outPng)}: ${size.w}x${size.h} @${scale}x (el=${dim.hasEl})`);
    await send("Emulation.clearDeviceMetricsOverride", {}, sid);
  }
  process.exit(0);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
