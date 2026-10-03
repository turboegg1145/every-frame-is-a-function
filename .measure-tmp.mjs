import puppeteer from 'puppeteer-core';
import fs from 'fs'; import path from 'path';
const HOME = process.env.HOME || '';
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const root = path.join(HOME, '.cache/puppeteer/chrome');
  const vers = fs.readdirSync(root);
  for (const v of vers) for (const bin of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
    const p = path.join(root, v, bin); if (fs.existsSync(p)) return p;
  }
  throw new Error('no chrome');
}
const pages = process.argv[2].split(',');
const frames = (process.argv[3] || '0,1,30,90,179').split(',').map(Number);
const width = +(process.argv[4] || 1920);
const b = await puppeteer.launch({
  executablePath: findChrome(), headless: true, protocolTimeout: 900000,
  args: ['--allow-file-access-from-files', '--disable-accelerated-2d-canvas',
         '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio', '--no-sandbox'],
});
for (const file of pages) {
  const p = await b.newPage();
  await p.goto('file://' + path.resolve(file) + '?f=0&w=320&s=7', { waitUntil: 'load', timeout: 180000 });
  await p.waitForFunction('window.__ready===true', { timeout: 180000 });
  const total = await p.evaluate(() => window.RISO.total);
  const res = await p.evaluate((frs, w) => {
    const out = [];
    for (const n of frs) { const t0 = performance.now(); window.RISO.frame(n, w, 7); out.push([n, +(performance.now() - t0).toFixed(1)]); }
    return out;
  }, frames, width);
  console.log(path.basename(path.dirname(file)) + '/' + path.basename(file) + `  total=${total}  width=${width}`);
  console.log('  ' + res.map(([n, ms]) => `f${n}:${ms}ms`).join('  '));
  await p.close();
}
await b.close();
