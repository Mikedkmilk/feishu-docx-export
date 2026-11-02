// cdp.js — 共享 CDP (Chrome DevTools Protocol) 辅助函数, 零依赖
const http = require("http");
const CDP_PORT = process.env.FEISHU_EXPORT_CDP_PORT || 9222;

function httpReq(url, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: body ? { "Content-Type": "application/json" } : {} },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d)); }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const jsonHttp = async (url, method = "GET", body = null) => JSON.parse(await httpReq(url, method, body));

async function listTargets() {
  return jsonHttp(`http://127.0.0.1:${CDP_PORT}/json/list`);
}

async function browserWs() {
  const ver = await jsonHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
  return ver.webSocketDebuggerUrl;
}

// 连接到某个 target (页面), 提供 eval / send
async function connect(targetId, timeoutMs = 120000) {
  const list = await listTargets();
  const t = list.find(x => x.id === targetId);
  if (!t) throw new Error(`target ${targetId} 不存在`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("WS 连接失败")); });
  const timer = setTimeout(() => { try { ws.close(); } catch {} }, timeoutMs);
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++msgId;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  return {
    tabId: targetId,
    send,
    close: () => { clearTimeout(timer); try { ws.close(); } catch {} },
    // 在页面上下文执行 JS, 返回反序列化后的值
    eval: async (expression) => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval exception");
      return r.result ? r.result.value : undefined;
    },
  };
}

// 附着到浏览器级 WS, 可 attach 任意 target (OOPIF iframe 等)
async function connectBrowser(timeoutMs = 90000) {
  const wsUrl = await browserWs();
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("WS 连接失败")); });
  const timer = setTimeout(() => { try { ws.close(); } catch {} }, timeoutMs);
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const i = ++msgId;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId }));
  });
  return {
    send,
    close: () => { clearTimeout(timer); try { ws.close(); } catch {} },
    // attach 到指定 target 并在其上下文 eval
    evalInTarget: async (targetId, expression) => {
      const att = await send("Target.attachToTarget", { targetId, flatten: true });
      const sid = att.sessionId;
      try {
        await send("Runtime.enable", {}, sid).catch(() => {});
        const r = await send("Runtime.evaluate", { expression, returnByValue: true }, sid);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval exception");
        return r.result ? r.result.value : undefined;
      } finally {
        await send("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
      }
    },
  };
}

// 提取浏览器全部 cookie (含 HttpOnly), 返回 "k=v; k2=v2" 字符串
async function getAllCookies(domainFilter) {
  const list = await listTargets();
  const tab = list.find(t => t.type === "page");
  if (!tab) throw new Error("无可用页面 target");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("WS 连接失败")); });
  const r = await new Promise((resolve, reject) => {
    const i = ++msgId;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method: "Network.getAllCookies", params: {} }));
  });
  ws.close();
  const cookies = (r.cookies || []).filter(c => !domainFilter || c.domain.includes(domainFilter));
  return cookies.map(c => `${c.name}=${c.value}`).join("; ");
}

// 查找可用的 Chromium 内核浏览器
function findBrowser() {
  const candidates = [];
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || home + "\\AppData\\Local";
  // Playwright 缓存的 Chromium (任意版本)
  try {
    const fs = require("fs");
    const pwDir = require("path").join(local, "ms-playwright");
    for (const d of fs.readdirSync(pwDir)) {
      if (/^chromium(-\d+)?$/.test(d) && !d.includes("headless")) {
        candidates.push(require("path").join(pwDir, d, "chrome-win64", "chrome.exe"));
        candidates.push(require("path").join(pwDir, d, "chrome-win", "chrome.exe"));
      }
    }
  } catch (e) {}
  candidates.push(
    pf + "\\Google\\Chrome\\Application\\chrome.exe",
    pf86 + "\\Google\\Chrome\\Application\\chrome.exe",
    local + "\\Google\\Chrome\\Application\\chrome.exe",
    pf86 + "\\Microsoft\\Edge\\Application\\msedge.exe",
    pf + "\\Microsoft\\Edge\\Application\\msedge.exe",
    local + "\\Microsoft\\EdgeCore\\", // EdgeCore 目录下有版本号子目录, 下面特判
  );
  const fs = require("fs");
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      if (c.endsWith("\\")) {
        // EdgeCore/<version>/msedge.exe
        try {
          const sub = fs.readdirSync(c).filter(d => /^\d+\./.test(d)).sort().pop();
          const exe = require("path").join(c, sub, "msedge.exe");
          if (fs.existsSync(exe)) return exe;
        } catch (e) {}
        continue;
      }
      return c;
    }
  }
  return null;
}

module.exports = { CDP_PORT, httpReq, jsonHttp, listTargets, browserWs, connect, connectBrowser, getAllCookies, findBrowser };
