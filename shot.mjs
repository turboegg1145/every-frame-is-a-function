/* 静帧取样：node shot.mjs 0 100 250 563 ...  -> shots/f00000.png
   给人眼看的自检工具，比整片渲染快得多。 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || '';
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(HOME, '.cache/puppeteer/chrome');
  if (fs.existsSync(root)) {
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
  throw new Error('找不到 Chrome');
}

const frames = process.argv.slice(2).map(Number).filter(n => !Number.isNaN(n));
if (!frames.length) { console.error('用法：node shot.mjs <帧号...>'); process.exit(1); }
const seed = +(process.env.SEED || 7);
const width = +(process.env.W || 1920);
const html = path.resolve(process.env.HTML || 'film/index.html');
const outDir = process.env.OUT || 'shots';
fs.mkdirSync(outDir, { recursive: true });

const b = await puppeteer.launch({
  executablePath: findChrome(), headless: true, protocolTimeout: 900000,
  args: ['--allow-file-access-from-files', '--disable-accelerated-2d-canvas',
         '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio', '--no-sandbox'],
});
const p = await b.newPage();
p.on('pageerror', e => console.error('页面报错：', e.message));
await p.goto('file://' + html + `?f=0&w=320&s=${seed}`, { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction('window.__ready===true', { timeout: 120000 });

const t0 = Date.now();
for (const n of frames) {
  const u = await p.evaluate((n, w, s) => window.RISO.frame(n, w, s), n, width, seed);
  const out = path.join(outDir, `f${String(n).padStart(5, '0')}.png`);
  fs.writeFileSync(out, Buffer.from(u.split(',')[1], 'base64'));
  console.log(`${out}  ${t0 && ''}`);
}
console.log(`${frames.length} 张，${((Date.now() - t0) / 1000).toFixed(1)}s`);
await b.close();
