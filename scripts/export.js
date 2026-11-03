#!/usr/bin/env node
// export.js — 飞书云文档一键导出 Markdown 编排器
// 用法: node export.js <文档URL> [--out <目录>] [--headed] [--profile <目录>] [--port <9222>] [--keep-open]
//
// 流程: 启动浏览器 → 打开文档 → (需要时自动弹出登录窗口) → 采集 block → 补采表格行
//       → 下载图片/封面(带鉴权降级重试) → 提取嵌入卡片并渲染 PNG → 下载附件视频(如有)
//       → 生成 Markdown → 校验
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
const profileDir = path.resolve(opt("profile", path.join(process.env.USERPROFILE || process.env.HOME || ".", ".feishu-export-profile")));
const port = opt("port", "9222");
process.env.FEISHU_EXPORT_CDP_PORT = port; // cdp.js 读取
const { jsonHttp, connect, getAllCookies, findBrowser } = require("./cdp.js");

const headed = flag("headed");
const keepOpen = flag("keep-open");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error("[export]", ...a);

const IMG_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const isImgBuf = (buf) => (buf[0] === 0x89 && buf[1] === 0x50) || (buf[0] === 0xff && buf[1] === 0xd8) || buf.slice(0, 3).toString() === "GIF" || buf.slice(8, 12).toString() === "WEBP";

const script = (name, ...a) => {
  log("→", name, ...a);
  execFileSync(process.execPath, [path.join(__dirname, name), ...a], { stdio: ["ignore", "ignore", "inherit"], cwd: outDir });
};

let browserChild = null;
let browserHeaded = false;

async function launchBrowser(headedMode) {
  const exe = findBrowser();
  if (!exe) throw new Error("未找到 Chromium/Chrome/Edge, 请安装其中之一");
  log("浏览器:", exe, headedMode ? "(可见窗口)" : "(无头)");
  const child = spawn(exe, [
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profileDir,
    "--remote-allow-origins=*",
    "--no-first-run",
    headedMode ? "--window-size=1400,900" : "--headless=new",
    "--window-size=1400,900",
    "about:blank",
  ], { stdio: "ignore" });
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

// 等待文档渲染; 若检测到登录墙返回 {needLogin:true}
async function waitRender(tabId, timeoutMs = 120000) {
  const page = await connect(tabId);
  let last = 0, stable = 0, loginWallStreak = 0;
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      await sleep(2500);
      try {
        const s = await page.eval(`JSON.stringify({t:document.title.length,c:(document.body.innerText||'').length,b:document.querySelectorAll('[data-block-id]').length,login:(document.body.innerText||'').includes('登录/注册')})`);
        const d = JSON.parse(s);
        log(`  渲染中: blocks=${d.b} chars=${d.c} ${d.login ? "(未登录)" : "(已登录)"}`);
        if (d.login && d.b <= 2 && d.c < 300) { loginWallStreak++; if (loginWallStreak >= 2) return { needLogin: true }; }
        else loginWallStreak = 0;
        if (d.b > 0) {
          if (d.b === last) { stable++; if (stable >= 2) return { ok: true, ...d }; }
          else stable = 0;
          last = d.b;
        }
      } catch (e) { /* 页面跳转中, 忽略 */ }
    }
  } finally { page.close(); }
  throw new Error("文档渲染超时");
}

// 检测页面登录态 (DOM 依据: 是否还有"登录/注册"入口)
async function isLoggedIn(tabId) {
  let page;
  try { page = await connect(tabId); } catch (e) { return false; }
  try {
    const s = await page.eval(`JSON.stringify({login:(document.body.innerText||'').includes('登录/注册'),b:document.querySelectorAll('[data-block-id]').length})`);
    const d = JSON.parse(s);
    return !d.login && d.b > 0;
  } catch (e) { return false; }
  finally { page.close(); }
}

// 登录流程: 以可见模式(重)启动浏览器打开文档, 轮询等待用户手动登录
async function ensureLogin(tabId) {
  const alreadyLoggedIn = await isLoggedIn(tabId);
  if (alreadyLoggedIn) return tabId;
  console.error("\n──────────────────────────────────────────────");
  console.error("  检测到飞书未登录/登录过期, 即将弹出浏览器窗口。");
  console.error("  请在弹出的窗口中登录飞书 (右上角「登录/注册」, 支持扫码)。");
  console.error("  登录完成后脚本会自动继续, 无需其他操作。");
  console.error("──────────────────────────────────────────────\n");
  // 关闭无头实例, 以可见模式重启同一 profile (登录态写入 profile 供后续使用)
  if (browserChild) { try { browserChild.kill(); } catch (e) {} browserChild = null; await sleep(1500); }
  if (!browserHeaded) {
    browserChild = await launchBrowser(true);
    browserHeaded = true;
    tabId = await openDoc();
  } else {
    tabId = await openDoc();
  }
  // 轮询等待登录完成 (最多 10 分钟)
  const start = Date.now();
  while (Date.now() - start < 600000) {
    await sleep(4000);
    try {
      const list = await jsonHttp(`http://127.0.0.1:${port}/json/list`);
      const tab = list.find(t => t.id === tabId && t.type === "page");
      if (!tab) continue;
      if (await isLoggedIn(tabId)) {
        log("✓ 检测到登录成功, 继续导出...");
        // 登录后页面会刷新, 等待重新渲染
        const st = await waitRender(tabId);
        if (st.needLogin) continue;
        return tabId;
      }
    } catch (e) { /* 轮询中页面可能跳转 */ }
  }
  throw new Error("等待登录超时 (10 分钟)");
}

// 下载一张图片: 带鉴权失败后自动降级为匿名重试; 校验魔数, 防止把错误页存成图片
async function downloadImage(token, mountId, cookie) {
  const u = `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/${token}/?fallback_source=1&height=1280&mount_node_token=${mountId}&mount_point=docx_image&policy=equal&width=1280`;
  for (const [label, headers] of [["带登录态", { "User-Agent": UA, Cookie: cookie, Referer: "https://my.feishu.cn/" }], ["匿名重试", { "User-Agent": UA, Referer: "https://my.feishu.cn/" }]]) {
    try {
      const res = await fetch(u, { headers, redirect: "follow" });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 200 && buf.length > 500 && isImgBuf(buf)) {
        let ext = ".png";
        if (buf[0] === 0xff && buf[1] === 0xd8) ext = ".jpg";
        else if (buf.slice(0, 3).toString() === "GIF") ext = ".gif";
        else if (buf.slice(8, 12).toString() === "WEBP") ext = ".webp";
        return { buf, ext, via: label };
      }
      log(`  图片 ${token} ${label}失败: HTTP ${res.status}, ${buf.length}B`);
    } catch (e) { log(`  图片 ${token} ${label}异常: ${e.message.slice(0, 60)}`); }
  }
  return null;
}

async function main() {
  fs.mkdirSync(path.join(outDir, "work"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "images"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "embeds"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "files"), { recursive: true });
  const blocksFile = path.join("work", "dom_blocks.json");

  // 1. 启动浏览器 + 打开文档
  try { await jsonHttp(`http://127.0.0.1:${port}/json/version`); log("复用已运行的浏览器 (port " + port + ")"); }
  catch (e) { browserChild = await launchBrowser(headed); browserHeaded = headed; }
  let tabId = await openDoc();
  let st = await waitRender(tabId);
  // 登录墙: 自动弹出登录窗口
  if (st.needLogin) tabId = await ensureLogin(tabId);

  // 2. 采集 block + 补采表格行
  script("collect_dom3.js", tabId, blocksFile);
  script("recollect_tables.js", tabId, blocksFile);
  const blocksData = JSON.parse(fs.readFileSync(path.join(outDir, blocksFile), "utf8"));
  const { blocks, cellBlocks } = blocksData;
  const pageBlock = blocks.find(b => b.type === "page");

  // 3. meta (标题/封面)
  let meta = {};
  {
    const page = await connect(tabId);
    try {
      const m = await page.eval(`(function(){const cv=window.DATA&&window.DATA.clientVars;if(!cv||!cv.data)return '{}';const d=cv.data;const pid=Object.keys(d.meta_map||{})[0];const pg=d.block_map[pid];return JSON.stringify({title:(d.meta_map[pid]&&d.meta_map[pid].title)||'',coverToken:pg&&pg.data&&pg.data.cover&&pg.data.cover.token||null})})()`);
      meta = JSON.parse(m);
    } catch (e) { log("clientVars 不可用:", e.message.slice(0, 60)); }
    page.close();
  }
  if (!meta.title && pageBlock) meta.title = (pageBlock.zoneHtml || "").replace(/<[^>]+>/g, "").trim();
  fs.writeFileSync(path.join(outDir, "work", "meta.json"), JSON.stringify(meta));
  log("标题:", meta.title);

  // 4. 下载图片 + 封面 (token 命名, 鉴权降级重试)
  const cookie = await getAllCookies("feishu");
  const jobs = [];
  for (const b of blocks) if (b.type === "image" && b.imgToken) jobs.push({ id: b.id, token: b.imgToken });
  for (const arr of Object.values(cellBlocks || {})) for (const b of arr) if (b.type === "image" && b.imgToken && !jobs.find(j => j.id === b.id)) jobs.push({ id: b.id, token: b.imgToken });
  if (meta.coverToken) jobs.push({ id: "cover_" + meta.coverToken, token: meta.coverToken, cover: true, mount: docToken });
  let ok = 0, fail = 0;
  const failedJobs = [];
  const IMG_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
  for (const j of jobs) {
    // 封面用 cover_<token> 命名 (md_gen 按 meta.coverToken 查找), 其余用 img_<token>
    const ref = j.cover ? "cover_" + j.token : "img_" + j.token;
    if (!j.cover && IMG_EXTS.some(e => fs.existsSync(path.join(outDir, "images", ref + e)))) { ok++; continue; } // 增量跳过
    const r = await downloadImage(j.token, j.cover ? docToken : j.id, cookie);
    if (r) { fs.writeFileSync(path.join(outDir, "images", ref + r.ext), r.buf); ok++; }
    else { fail++; failedJobs.push(j); }
  }
  log(`图片下载: ${ok} 成功, ${fail} 失败 (共 ${jobs.length})`);
  // 大面积失败 → 多为登录态问题, 弹登录窗口后重试
  if (fail > 0 && fail >= jobs.length * 0.5) {
    log("⚠ 图片大面积下载失败, 疑似登录态过期/无权限, 触发登录流程后重试...");
    tabId = await ensureLogin(tabId);
    const cookie2 = await getAllCookies("feishu");
    ok = 0; fail = 0;
    for (const j of failedJobs) {
      const ref = j.cover ? "cover_" + j.token : "img_" + j.token;
      const r = await downloadImage(j.token, j.cover ? docToken : j.id, cookie2);
      if (r) { fs.writeFileSync(path.join(outDir, "images", ref + r.ext), r.buf); ok++; }
      else fail++;
    }
    log(`重试图片下载: ${ok} 成功, ${fail} 失败`);
  }

  // 5. 嵌入卡片 (isv): 卡片 iframe 只对登录用户渲染。
  //    登录态检测用"卡片 iframe 是否实际渲染"这一直接信号 (DOM 文本检测不可靠),
  //    提取不全时自动弹登录窗口, 用户手动登录后自动重试一轮。
  const isvBlocks = blocks.filter(b => b.type === "isv");
  let finalJobs = [];
  if (isvBlocks.length) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let stash = [];
      try {
        // 第 1 轮先预检: 滚到首个卡片处看 iframe 是否渲染; 未渲染则弹登录窗口
        if (attempt === 1) {
          const probe = await connect(tabId);
          await probe.eval(`(()=>{const el=[...document.querySelectorAll('[data-block-id]')].find(e=>(e.getAttribute('data-block-type')||'')==='isv');if(el)el.scrollIntoView({block:'center'});return 1})()`);
          await sleep(3000);
          const iframeOk = await probe.eval(`(()=>{const el=[...document.querySelectorAll('[data-block-id]')].find(e=>(e.getAttribute('data-block-type')||'')==='isv');return el&&el.querySelector('iframe')?'yes':'no'})()`);
          probe.close();
          if (iframeOk !== "yes") tabId = await ensureLogin(tabId);
        }
        const page = await connect(tabId);
        for (const b of isvBlocks) {
          await page.eval(`(()=>{const el=[...document.querySelectorAll('[data-block-id]')].find(e=>e.getAttribute('data-block-id')==='${b.id}');if(el)el.scrollIntoView({block:'center'});return 1})()`);
          await sleep(2500);
        }
        // 强刷未挂载的 iframe (虚拟化回收后 target 会消失)
        await page.eval(`(()=>{for(const e of document.querySelectorAll('[data-block-id]')){if((e.getAttribute('data-block-type')||'')!=='isv')continue;const f=e.querySelector('iframe');if(f&&!f.src)f.src=f.src||f.getAttribute('data-src')||'';}})()`);
        const dims = JSON.parse(await page.eval(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('[data-block-id]')].filter(e=>(e.getAttribute('data-block-type')||'')==='isv').map(e=>{const f=e.querySelector('iframe');return [e.getAttribute('data-block-id'),f?f.offsetWidth+'x'+f.offsetHeight:'']})))`));
        page.close();
        script("extract_srcdoc.js", path.join("work", "srcdoc.json"));
        // OT 长度精确匹配 (clientVars chunk 内的卡片)
        const cvLens = {};
        try {
          const cvPage = await connect(tabId);
          const cv = JSON.parse(await cvPage.eval("JSON.stringify(window.DATA&&window.DATA.clientVars||{})"));
          cvPage.close();
          for (const b of isvBlocks) {
            const full = Object.keys(cv.data.block_map || {}).find(k => k.startsWith(b.recordId));
            if (full) cvLens[b.id] = ((cv.data.block_map[full].data.data || {}).html || "").length;
          }
        } catch (e) {}
        const srcdocs = JSON.parse(fs.readFileSync(path.join(outDir, "work", "srcdoc.json"), "utf8")).filter(x => x.html);
        // 渲染全部 srcdoc, 量高度用于指纹匹配
        stash = srcdocs.map(x => ({ x, tmpHtml: path.join("embeds", "_tmp_" + x.targetId.slice(0, 8) + ".html") }));
        for (const s of stash) fs.writeFileSync(path.join(outDir, s.tmpHtml), s.x.html);
        fs.writeFileSync(path.join(outDir, "work", "render_jobs.json"), JSON.stringify(stash.map(s => ({ htmlFile: s.tmpHtml, outPng: path.join("work", "_h_" + path.basename(s.tmpHtml) + ".png") }))));
        script("render_embeds.js", "embeds", "images", path.join("work", "render_jobs.json"));
        const pngHeights = {};
        for (const s of stash) {
          const png = path.join(outDir, "work", "_h_" + path.basename(s.tmpHtml) + ".png");
          if (fs.existsSync(png)) pngHeights[s.x.targetId] = fs.readFileSync(png).readUInt32BE(20);
        }
        // 匹配: OT 长度精确 → iframe 高度指纹 → 剩余顺序兜底
        const assigned = new Set();
        for (const b of isvBlocks) {
          let x = null;
          if (cvLens[b.id]) x = srcdocs.find(s => s.origLen === cvLens[b.id] && !assigned.has(s.targetId));
          if (!x) {
            const bh = parseInt(((dims[b.id] || "").split("x")[1]) || "0") || 0;
            const cand = srcdocs.filter(s => !assigned.has(s.targetId) && pngHeights[s.targetId] && Math.abs(pngHeights[s.targetId] / 2 - bh) <= 8);
            if (cand.length === 1) x = cand[0];
          }
          if (!x) {
            const cand = srcdocs.filter(s => !assigned.has(s.targetId));
            if (cand.length === 1) x = cand[0];
          }
          if (!x) { log("  卡片未匹配:", b.id); continue; }
          assigned.add(x.targetId);
          const hf = path.join("embeds", "isv_" + (b.recordId || b.id).slice(0, 16) + ".html");
          fs.writeFileSync(path.join(outDir, hf), x.html);
          finalJobs.push({ htmlFile: hf, outPng: path.join("images", "isv_" + (b.recordId || b.id).slice(0, 16) + ".png") });
          log("  卡片映射:", b.id, "<-", (x.desc || "").slice(0, 24));
        }
      } catch (e) {
        log("嵌入卡片提取异常:", e.message.slice(0, 120));
      } finally {
        for (const s of stash) {
          fs.rmSync(path.join(outDir, s.tmpHtml), { force: true });
          fs.rmSync(path.join(outDir, "work", "_h_" + path.basename(s.tmpHtml) + ".png"), { force: true });
        }
      }
      if (finalJobs.length >= isvBlocks.length) break;
      if (attempt === 1) {
        log(`卡片仅 ${finalJobs.length}/${isvBlocks.length} 提取成功, 弹出登录窗口后自动重试...`);
        tabId = await ensureLogin(tabId);
        // 登录后重置结果, 全量重试
        finalJobs = [];
      }
    }
    // 兜底: 历史导出提取过的卡片资产按 recordId 存档于 ~/.feishu-export-cache, 直接复用
    const cacheDir = path.join(process.env.USERPROFILE || process.env.HOME || ".", ".feishu-export-cache");
    for (const b of isvBlocks) {
      const rec = (b.recordId || "").slice(0, 16);
      if (!rec || finalJobs.find(j => j.outPng.includes("isv_" + rec + "."))) continue;
      const cp = path.join(cacheDir, "isv_" + rec + ".png"), ch = path.join(cacheDir, "isv_" + rec + ".html");
      if (fs.existsSync(cp) && fs.existsSync(ch)) {
        const hf = path.join("embeds", "isv_" + rec + ".html");
        fs.mkdirSync(path.join(outDir, "embeds"), { recursive: true });
        fs.copyFileSync(ch, path.join(outDir, hf));
        finalJobs.push({ htmlFile: hf, outPng: path.join("images", "isv_" + rec + ".png") });
        log("  卡片映射(历史缓存):", b.id, "<-", rec);
      }
    }
    // 成功的卡片写入缓存, 供后续导出兜底
    if (finalJobs.length) {
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        for (const j of finalJobs) {
          if (fs.existsSync(path.join(outDir, j.htmlFile))) fs.copyFileSync(path.join(outDir, j.htmlFile), path.join(cacheDir, path.basename(j.htmlFile)));
          if (fs.existsSync(path.join(outDir, j.outPng))) fs.copyFileSync(path.join(outDir, j.outPng), path.join(cacheDir, path.basename(j.outPng)));
        }
      } catch (e) {}
    }
    fs.writeFileSync(path.join(outDir, "work", "render_jobs.json"), JSON.stringify(finalJobs));
    if (finalJobs.length) script("render_embeds.js", "embeds", "images", path.join("work", "render_jobs.json"));
    if (finalJobs.length < isvBlocks.length) {
      log(`⚠ 卡片 ${finalJobs.length}/${isvBlocks.length} 提取成功; 未成功的保留占位符`);
    }
  }

  // 6. 附件视频 (file 块): 登录态下从渲染后的 video.src 拿地址下载
  const fileBlocks = blocks.filter(b => b.type === "file");
  if (fileBlocks.length) {
    if (!(await isLoggedIn(tabId))) tabId = await ensureLogin(tabId);
    const pg = await connect(tabId);
    for (const b of fileBlocks) {
      try {
        await pg.eval(`(()=>{const el=[...document.querySelectorAll('[data-block-id]')].find(e=>e.getAttribute('data-block-id')==='${b.id}');if(el)el.scrollIntoView({block:'center'});return 1})()`);
        await sleep(3000);
        const src = await pg.eval(`(function(){const el=[...document.querySelectorAll('[data-block-id]')].find(e=>e.getAttribute('data-block-id')==='${b.id}');if(!el)return '';const m=el.querySelector('video,audio');return m?(m.src||''):''})()`);
        if (src && src.startsWith("http")) {
          const res = await fetch(src, { headers: { "User-Agent": UA, Cookie: await getAllCookies("feishu"), Referer: "https://my.feishu.cn/" } });
          if (res.status === 200) {
            const token = (src.match(/download\/video\/([A-Za-z0-9]+)/) || [])[1] || b.id;
            fs.writeFileSync(path.join(outDir, "files", token + ".mp4"), Buffer.from(await res.arrayBuffer()));
            log("附件已下载: files/" + token + ".mp4");
          }
        }
      } catch (e) { log("附件下载失败", b.id, e.message.slice(0, 60)); }
    }
    pg.close();
  }

  // 7. 生成 Markdown + 校验
  const env = { ...process.env, SRC_URL: url };
  log("→ md_gen.js");
  execFileSync(process.execPath, [path.join(__dirname, "md_gen.js"), blocksFile, path.join("work", "meta.json")], { stdio: "inherit", cwd: outDir, env });
  const mdName = fs.readdirSync(outDir).find(f => f.endsWith(".md"));
  if (mdName) {
    log("→ qa2.js");
    try { execFileSync(process.execPath, [path.join(__dirname, "qa2.js"), mdName, blocksFile], { stdio: "inherit", cwd: outDir }); } catch (e) {}
    console.log("\n✅ 完成: " + path.join(outDir, mdName));
  }

  if (!keepOpen && browserChild) { try { browserChild.kill(); } catch (e) {} }
  process.exit(0);
}

main().catch(e => { console.error("[export] 失败:", e.message); if (!keepOpen) process.exit(1); });
