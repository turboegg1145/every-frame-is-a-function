#!/usr/bin/env node
/* =====================================================================
   逐帧渲染器。原理：页面把「第 n 帧」画成一张 PNG（toDataURL），
   这里开 N 个标签页并行地要帧、写盘，最后交给 ffmpeg 编码。
   不用 page.screenshot()：截图受 CSS / 设备像素比影响，
   toDataURL 返回的就是画布上真实的像素。

     node render.mjs [输出目录=frames] [seed=7] [宽度] [标签页数=4]

   环境变量：
     HTML=film/index.html   要渲染的页面
     AR=16:9                画幅（页面按它决定 16:9 还是 9:16 的构图）
     START=0 END=720        只渲一段
     RESUME=1               跳过已经存在的帧（断了接着渲）
     SHEET=out/sheet.png    不渲染视频，只出一张拉片（联系表）
     SHEET_N=24 SHEET_W=480 SHEET_FROM=0 SHEET_TO=719
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

/* ---------- 找到 Chrome。优先用环境变量，其次 puppeteer 的缓存目录（最高版本） ---------- */
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;          // ① 显式指定优先
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const HOME = process.env.HOME || '';
  // ② 系统里正经装的那一个（apt / .deb / 用户级解包都认）
  for (const p of [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
    HOME + '/.local/bin/google-chrome', HOME + '/.local/bin/google-chrome-stable',
    HOME + '/.local/opt/google-chrome-stable/opt/google/chrome/chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/usr/bin/brave-browser', '/usr/bin/microsoft-edge',
  ]) if (fs.existsSync(p)) return p;
  // ③ 都没装，就用 puppeteer 下到缓存里的
  const root = path.join(HOME, '.cache/puppeteer/chrome');
  if (fs.existsSync(root)) {
    // 目录名可能是 154.0.8037.57 也可能是 linux-154.0.8037.57：按版本号倒序
    const ver = d => (d.match(/\d+(\.\d+)+/) || ['0'])[0].split('.').map(Number);
    const vers = fs.readdirSync(root).sort((a, b) => {
      const pa = ver(a), pb = ver(b);
      for (let i = 0; i < 4; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
      return 0;
    });
    for (const v of vers) for (const bin of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = path.join(root, v, bin);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('找不到 Chrome：装一个（apt install google-chrome-stable，或 npx puppeteer browsers install chrome），'
    + '或用 CHROME=/path/to/chrome 指定');
}


const [,, dirArg = 'frames', seedS = '7', widthS = '', tabsS = '4'] = process.argv;
const dir = dirArg, seed = +seedS, tabs = Math.max(1, +tabsS);
let width = +widthS;
const html = path.resolve(process.env.HTML || 'film/index.html');
if (!fs.existsSync(html)) { console.error(`没有这个文件：${html}（用 HTML= 指定）`); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });
const url = 'file://' + html + `?f=0&w=320&s=${seed}` + (process.env.AR ? `&ar=${process.env.AR}` : '');

const launch = {
  executablePath: findChrome(),
  headless: true,
  protocolTimeout: 900000,
  // 关掉 GPU 光栅：加速画布在几次 readback 之后会退回软件光栅，
  // 于是同一个帧在新标签页和用过的标签页里像素不同，逐帧渲染就花了。
  args: ['--allow-file-access-from-files', '--disable-accelerated-2d-canvas',
         '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio', '--no-sandbox'],
};
const b = await puppeteer.launch(launch);
const p0 = await b.newPage();
await p0.goto(url, { waitUntil: 'load', timeout: 180000 });
await p0.waitForFunction('window.__ready===true', { timeout: 180000 });
const total = await p0.evaluate(() => window.RISO.total);
if (!width) width = await p0.evaluate(() => (typeof AR !== 'undefined' && AR < 1 ? 1080 : 1920));
const plates = await p0.evaluate(() => window.RISO.plates);
const fps = await p0.evaluate(() => window.RISO.fps);

/* ---------- 模式二：只出一张拉片（联系表），给人眼看的自检工具 ---------- */
if (process.env.SHEET) {
  const n = +(process.env.SHEET_N || 24), cw = +(process.env.SHEET_W || 480);
  const f0 = +(process.env.SHEET_FROM || 0), f1 = process.env.SHEET_TO ? +process.env.SHEET_TO : total - 1;
  const u = await p0.evaluate((n, cw, f0, f1) => window.RISO.contact(n, cw, f0, f1), n, cw, f0, f1);
  fs.mkdirSync(path.dirname(path.resolve(process.env.SHEET)), { recursive: true });
  fs.writeFileSync(process.env.SHEET, Buffer.from(u.split(',')[1], 'base64'));
  console.log(`拉片 ${n} 格 -> ${process.env.SHEET}（${f0}..${f1}）`);
  await b.close();
  process.exit(0);
}

const START = +(process.env.START || 0), END = Math.min(total, +(process.env.END || total));
const count = END - START;
console.log(`${total} 帧 = ${(total / fps).toFixed(1)}s @ ${fps}fps，渲染 ${START}..${END - 1}，宽度 ${width}，${tabs} 个标签页`);
console.log('分镜： ' + plates.map(p => `${p.name}:${p.len}(${(p.len / fps).toFixed(1)}s)`).join('  '));

let next = START, done = 0, failed = 0;
const t0 = Date.now();
async function worker() {
  const p = await b.newPage();
  p.on('pageerror', e => console.error('页面报错：', e.message));
  p.on('console', m => { if (m.type() === 'error') console.error('控制台：', m.text()); });
  await p.goto(url, { waitUntil: 'load', timeout: 180000 });
  await p.waitForFunction('window.__ready===true', { timeout: 180000 });
  while (true) {
    const n = next++; if (n >= END) break;
    const out = path.join(dir, `f${String(n).padStart(5, '0')}.png`);
    if (process.env.RESUME && fs.existsSync(out)) { done++; continue; }
    try {
      const u = await p.evaluate((n, w, s) => window.RISO.frame(n, w, s), n, width, seed);
      fs.writeFileSync(out, Buffer.from(u.split(',')[1], 'base64'));
    } catch (e) { failed++; console.error('第', n, '帧失败：', e.message); }
    done++;
    if (done % 60 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`${done}/${count}  ${el.toFixed(0)}s，约剩 ${(el / done * (count - done)).toFixed(0)}s`);
    }
  }
  await p.close();
}
await Promise.all(Array.from({ length: tabs }, worker));
await b.close();
console.log(`完成 ${done - failed} 帧，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s${failed ? `，${failed} 帧失败` : ''}`);
if (failed) process.exit(1);
