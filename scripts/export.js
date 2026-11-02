#!/usr/bin/env node
// export.js — 飞书云文档一键导出 Markdown 编排器
// 用法: node export.js <文档URL> [--out <目录>] [--headed] [--profile <目录>] [--port <9222>] [--keep-open]
//
// 流程: 启动浏览器 → 打开文档 → 采集 block → 补采表格行 → 下载图片/封面
//       → 提取嵌入卡片并渲染 PNG → 下载附件视频(如有) → 生成 Markdown → 校验
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith("--"));
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes("--" + name);

if (!url || !/feishu\.cn\/docx\/([A-Za-z0-9]+)/.test(url)) {
  console.error("用法: node export.js <飞书文档URL> [--out <目录>] [--headed] [--profile <目录>] [--port <9222>] [--keep-open]");
  console.error("  --headed   显示浏览器窗口 (用于扫码登录后导出含嵌入卡片/附件的文档)");
  process.exit(1);
}
const docToken = url.match(/feishu\.cn\/docx\/([A-Za-z0-9]+)/)[1];
const outDir = path.resolve(opt("out", "./feishu_export"));
const workDir = path.join(outDir, "work");
const profileDir = path.resolve(opt("profile", path.join(process.env.USERPROFILE || process.env.HOME || ".", ".feishu-export-profile")));
const port = opt("port", "9222");
process.env.FEISHU_EXPORT_CDP_PORT = port; // cdp.js 读取
const { CDP_PORT, jsonHttp, listTargets, connect, connectBrowser, getAllCookies, findBrowser } = require("./cdp.js");
const headed = flag("headed");
const keepOpen = flag("keep-open");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error("[export]", ...a);

const script = (name, ...args) => {
  log("→", name, ...args);
  execFileSync(process.execPath, [path.join(__dirname, name), ...args], { stdio: ["ignore", "ignore", "inherit"], cwd: outDir });
};

async function launchBrowser() {
  const exe = findBrowser();
  if (!exe) throw new Error("未找到 Chromium/Chrome/Edge, 请安装其中之一或设置 PATH");
  log("浏览器:", exe);
  const child = spawn(exe, [
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profileDir,
    "--remote-allow-origins=*",
    "--no-first-run",
    headed ? "--window-size=1400,900" : "--headless=new",
    "--window-size=1400,900",
    "about:blank",
  ], { stdio: "ignore", detached: false });
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { await jsonHttp(`http://127.0.0.1:${port}/json/version`); return child; } catch (e) {}
  }
  throw new Error("浏览器 CDP 端口未就绪");
}

async function openDoc() {
  // 首个标签可能被飞书安全检测重置, 用新开标签的方式打开
  const t = await jsonHttp(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, "PUT");
  return t.id;
}

async function waitRender(tabId, timeoutMs = 120000) {
  const page = await connect(tabId);
  let last = 0, stable = 0;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(2500);
    try {
      const s = await page.eval(`JSON.stringify({t:document.title.length,c:(document.body.innerText||'').length,b:document.querySelectorAll('[data-block-id]').length,login:(document.body.innerText||'').includes('登录/注册')})`);
      const d = JSON.parse(s);
      log(`  渲染中: blocks=${d.b} chars=${d.c} ${d.login ? "(未登录)" : "(已登录)"}`);
      if (d.b > 0) {
        if (d.b === last) { stable++; if (stable >= 2) { page.close(); return d; } }
        else stable = 0;
        last = d.b;
      }
    } catch (e) { /* 页面跳转中, 忽略 */ }
  }
  page.close();
  throw new Error("文档渲染超时");
}

async function main() {
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "images"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "embeds"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "files"), { recursive: true });
  const blocksFile = path.join("work", "dom_blocks.json");

  // 1. 启动浏览器 + 打开文档
  let child = null;
  try { await jsonHttp(`http://127.0.0.1:${port}/json/version`); log("复用已运行的浏览器 (port " + port + ")"); child = null; }
  catch (e) { child = await launchBrowser(); }
  const tabId = await openDoc();
  log("tab:", tabId);
  const state = await waitRender(tabId);
  const loggedIn = !state.login;

  // 2. 采集 block
  script("collect_dom3.js", tabId, blocksFile);
  // 3. 补采表格行
  script("recollect_tables.js", tabId, blocksFile);

  const blocksData = JSON.parse(fs.readFileSync(path.join(outDir, blocksFile), "utf8"));
  const { blocks, cellBlocks } = blocksData;
  const docTokenPage = blocks.find(b => b.type === "page");

  // 4. meta (标题/封面)
  let page = await connect(tabId);
  let meta = {};
  try {
    const m = await page.eval(`(function(){const cv=window.DATA&&window.DATA.clientVars;if(!cv||!cv.data)return '{}';const d=cv.data;const pid=Object.keys(d.meta_map||{})[0];const pg=d.block_map[pid];return JSON.stringify({title:(d.meta_map[pid]&&d.meta_map[pid].title)||'',coverToken:pg&&pg.data&&pg.data.cover&&pg.data.cover.token||null})})()`);
    meta = JSON.parse(m);
  } catch (e) { log("clientVars 不可用:", e.message.slice(0, 60)); }
  if (!meta.title && docTokenPage) meta.title = (docTokenPage.zoneHtml || "").replace(/<[^>]+>/g, "").trim();
  fs.writeFileSync(path.join(outDir, "work", "meta.json"), JSON.stringify(meta));
  log("标题:", meta.title);

  // 5. 下载图片 + 封面 (fetch + cookie)
  const cookie = await getAllCookies("feishu");
  const jobs = [];
  for (const b of blocks) if (b.type === "image" && b.imgToken) jobs.push({ id: b.id, token: b.imgToken });
  for (const arr of Object.values(cellBlocks)) for (const b of arr) if (b.type === "image" && b.imgToken && !jobs.find(j => j.id === b.id)) jobs.push({ id: b.id, token: b.imgToken });
  if (meta.coverToken) jobs.push({ id: "cover_" + meta.coverToken, token: meta.coverToken, cover: true });
  let ok = 0, fail = 0;
  for (const j of jobs) {
    const u = `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/${j.token}/?fallback_source=1&height=1280&mount_node_token=${j.cover ? docToken : j.id}&mount_point=docx_image&policy=equal&width=1280`;
    try {
      const res = await fetch(u, { headers: { "User-Agent": UA, Cookie: cookie, Referer: "https://my.feishu.cn/" } });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 200 && buf.length > 1000) { fs.writeFileSync(path.join(outDir, "images", j.id + ".img"), buf); ok++; }
      else { fail++; log("  图片失败", j.id, res.status); }
    } catch (e) { fail++; log("  图片异常", j.id, e.message.slice(0, 50)); }
  }
  log(`图片下载: ${ok} 成功, ${fail} 失败`);

  // 6. 嵌入卡片 (isv): 卡片 iframe 只在登录态渲染; 匿名时尝试提取会得到空结果
  const isvBlocks = blocks.filter(b => b.type === "isv");
  if (isvBlocks.length) {
    try {
        // 逐块滚入视口触发 iframe 渲染
        for (const b of isvBlocks) {
          await page.eval(`(()=>{const el=[...document.querySelectorAll('[data-block-id]')].find(e=>e.getAttribute('data-block-id')==='${b.id}');if(el)el.scrollIntoView({block:'center'});return 1})()`);
          await sleep(2500);
        }
        // 高度指纹: 块 id -> iframe 尺寸
        const dims = JSON.parse(await page.eval(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('[data-block-id]')].filter(e=>(e.getAttribute('data-block-type')||'')==='isv').map(e=>{const f=e.querySelector('iframe');return [e.getAttribute('data-block-id'),f?f.offsetWidth+'x'+f.offsetHeight:'']})))`));
        await page.close(); page = null;
        script("extract_srcdoc.js", path.join("work", "srcdoc.json"));
        // 记录每块的 OT html 长度 (clientVars chunk 内可直接精确匹配)
        let cvLens = {};
        try {
          const cvPage = await connect(tabId);
          const cv = JSON.parse(await cvPage.eval("JSON.stringify(window.DATA&&window.DATA.clientVars||{})"));
          cvPage.close();
          for (const b of isvBlocks) {
            const full = Object.keys(cv.data.block_map).find(k => k.startsWith(b.recordId));
            if (full) cvLens[b.id] = (cv.data.block_map[full].data.data.html || "").length;
          }
        } catch (e) {}
        // 匹配: 先按 OT 长度精确匹配, 再按渲染高度匹配
        const srcdocs = JSON.parse(fs.readFileSync(path.join(outDir, "work", "srcdoc.json"), "utf8")).filter(x => x.html);
        const rjobs = [], used = new Set();
        for (const b of isvBlocks) {
          let hit = null;
          if (cvLens[b.id]) hit = srcdocs.find(x => x.origLen === cvLens[b.id] && !used.has(x.targetId));
          rjobs.push({ block: b, pending: true, hit });
        }
        fs.writeFileSync(path.join(outDir, "work", "render_jobs.json"), "[]");
        // 先渲染所有 srcdoc 得到高度, 再与 iframe 高度匹配
        const stash = [];
        for (const x of srcdocs) {
          const tmpHtml = path.join("embeds", "_tmp_" + x.targetId.slice(0, 8) + ".html");
          fs.writeFileSync(path.join(outDir, tmpHtml), x.html);
          stash.push({ tmpHtml, x });
        }
        fs.writeFileSync(path.join(outDir, "work", "render_jobs.json"), JSON.stringify(stash.map(s => ({ htmlFile: s.tmpHtml, outPng: path.join("work", "_h_" + path.basename(s.tmpHtml) + ".png") }))));
        script("render_embeds.js", "embeds", "images", path.join("work", "render_jobs.json"));
        // 读取每个临时 PNG 的像素高度, 与块 iframe 高度匹配
        const pngHeights = {};
        for (const s of stash) {
          const png = path.join(outDir, "work", "_h_" + path.basename(s.tmpHtml) + ".png");
          const buf = fs.readFileSync(png);
          pngHeights[s.x.targetId] = buf.readUInt32BE(20); // PNG IHDR height
        }
        const finalJobs = [];
        const assigned = new Set();
        for (const job of rjobs) {
          const b = job.block;
          let x = job.hit;
          if (!x) {
            const dim = dims[b.id] || "";
            const bh = parseInt(dim.split("x")[1]) || 0;
            // 渲染像素高度(2x) 与 iframe CSS 高度比对, 容差 8px
            let cand = srcdocs.filter(s => !assigned.has(s.targetId) && Math.abs(pngHeights[s.targetId] / 2 - bh) <= 8);
            if (cand.length === 1) x = cand[0];
            else cand = srcdocs.filter(s => !assigned.has(s.targetId));
            if (!x && cand.length) x = cand[0]; // 兜底按剩余顺序
          }
          if (!x) { log("  卡片未匹配:", b.id); continue; }
          assigned.add(x.targetId);
          const hf = path.join("embeds", "isv_" + b.id + ".html");
          fs.writeFileSync(path.join(outDir, hf), x.html);
          finalJobs.push({ htmlFile: hf, outPng: path.join("images", "isv_" + b.id + ".png") });
          log("  卡片映射:", b.id, "<-", (x.desc || "").slice(0, 24));
        }
        fs.writeFileSync(path.join(outDir, "work", "render_jobs.json"), JSON.stringify(finalJobs));
        script("render_embeds.js", "embeds", "images", path.join("work", "render_jobs.json"));
        for (const s of stash) {
          fs.rmSync(path.join(outDir, s.tmpHtml), { force: true });
          fs.rmSync(path.join(outDir, "work", "_h_" + path.basename(s.tmpHtml) + ".png"), { force: true });
        }
        if (!finalJobs.length) log("⚠ 嵌入卡片未提取到内容(未登录?), 保留占位符。重新运行加 --headed 登录后可导出卡片。");
      } catch (e) {
        log("嵌入卡片提取失败(保留占位符):", e.message.slice(0, 120));
      }
  }

  // 7. 附件视频 (file 块): 登录态下从渲染后的 video.src 拿地址下载
  const fileBlocks = blocks.filter(b => b.type === "file");
  if (fileBlocks.length) {
    let pg = page || await connect(tabId);
    for (const b of fileBlocks) {
      try {
        await pg.eval(`(()=>{const el=[...document.querySelectorAll('[data-block-id]')].find(e=>e.getAttribute('data-block-id')==='${b.id}');if(el)el.scrollIntoView({block:'center'});return 1})()`);
        await sleep(3000);
        const src = await pg.eval(`(function(){const el=[...document.querySelectorAll('[data-block-id]')].find(e=>e.getAttribute('data-block-id')==='${b.id}');if(!el)return '';const m=el.querySelector('video,audio');return m?(m.src||''):''})()`);
        if (src && src.startsWith("http")) {
          const res = await fetch(src, { headers: { "User-Agent": UA, Cookie: cookie, Referer: "https://my.feishu.cn/" } });
          if (res.status === 200) {
            fs.writeFileSync(path.join(outDir, "files", b.id + ".mp4"), Buffer.from(await res.arrayBuffer()));
            log("附件已下载: files/" + b.id + ".mp4 (" + (res.headers.get("content-type") || "?") + ")");
          }
        }
      } catch (e) { log("附件下载失败", b.id, e.message.slice(0, 60)); }
    }
  }
  if (page) page.close();

  // 8. 生成 Markdown + 校验
  const env = { ...process.env, SRC_URL: url };
  log("→ md_gen.js");
  execFileSync(process.execPath, [path.join(__dirname, "md_gen.js"), blocksFile, path.join("work", "meta.json")], { stdio: "inherit", cwd: outDir, env });
  const mdName = fs.readdirSync(outDir).find(f => f.endsWith(".md"));
  if (mdName) {
    log("→ qa2.js");
    try { execFileSync(process.execPath, [path.join(__dirname, "qa2.js"), mdName, blocksFile], { stdio: "inherit", cwd: outDir }); } catch (e) {}
    console.log("\n✅ 完成: " + path.join(outDir, mdName));
  }

  if (!keepOpen && child) { try { child.kill(); } catch (e) {} process.exit(0); }
}

main().catch(e => { console.error("[export] 失败:", e.message); if (!keepOpen) process.exit(1); });
