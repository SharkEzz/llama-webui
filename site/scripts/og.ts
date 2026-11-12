/**
 * Renders the Open Graph image (public/og.png, 1200 × 630): wordmark, tagline and a slice of the Dashboard capture.
 * Run after recapturing the dashboard: `pnpm og`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = join(import.meta.dirname, '..');
const font = join(root, 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2');
const shot = join(root, 'public/screenshots/dashboard-dark.webp');
const out = join(root, 'public/og.png');

const html = `<!doctype html>
<html><head><style>
@font-face { font-family: Inter; src: url('file://${font}') format('woff2'); font-weight: 100 900; }
* { margin: 0; box-sizing: border-box; }
body {
  width: 1200px; height: 630px; overflow: hidden; font-family: Inter; color: #f2f4f7;
  background: radial-gradient(ellipse at top, #1b1f26, #111317);
}
.grid {
  position: absolute; inset: 0;
  background-image: linear-gradient(to right, #ffffff10 1px, transparent 1px), linear-gradient(to bottom, #ffffff10 1px, transparent 1px);
  background-size: 56px 56px; mask-image: radial-gradient(ellipse 80% 70% at 30% 0%, black 30%, transparent 75%);
}
.halo { position: absolute; left: 380px; top: 280px; width: 620px; height: 260px; border-radius: 50%;
  background: #3698ff; opacity: .28; filter: blur(80px); }
.brand { position: absolute; left: 64px; top: 56px; display: flex; align-items: center; gap: 12px; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
.brand b { color: #3698ff; font-weight: 700; }
.brand i { color: #8b93a1; font-style: normal; }
h1 { position: absolute; left: 64px; top: 124px; width: 1000px; font-size: 62px; line-height: 1.04; font-weight: 600; letter-spacing: -0.035em;
  background: linear-gradient(180deg, #f2f4f7 40%, #f2f4f79e); -webkit-background-clip: text; color: transparent; }
.window { position: absolute; left: 64px; top: 330px; width: 1072px; height: 380px; overflow: hidden; border-radius: 16px;
  box-shadow: 0 0 0 1px #ffffff1a, 0 30px 80px -20px #000; }
.window img { position: absolute; width: ${Math.round(1072 / 0.84)}px; left: ${-Math.round((1072 / 0.84) * 0.155)}px; top: ${-Math.round((1072 / 0.84) * 0.625 * 0.045)}px; }
</style></head><body>
<div class="grid"></div><div class="halo"></div>
<div class="brand">
  <svg viewBox="0 0 20 20" width="34" height="34"><rect x="2" y="11" width="4" height="7" rx="1.5" fill="#3698ff"/><rect x="8" y="7" width="4" height="11" rx="1.5" fill="#44d0c1"/><rect x="14" y="2" width="4" height="16" rx="1.5" fill="#fcb442"/></svg>
  <span>llama<i>-</i><b>webui</b></span>
</div>
<h1>A local control room for llama.cpp's llama-server.</h1>
<div class="window"><img src="file://${shot}"></div>
</body></html>`;

const file = '/tmp/llama-webui-og.html';
writeFileSync(file, html);
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.goto(`file://${file}`, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log(`og: ${out}`);
