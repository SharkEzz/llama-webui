/**
 * Captures the app for the website, in dark and light, with the local Chromium (headless).
 *
 *   bun scripts/screenshots.ts [name…] [--live] [--base http://192.168.0.20:7861] [--themes dark,light]
 *
 * Without names: every shot except `live` and `manual` ones; --live: the shots that need a running generation.
 *
 * Targets the demo instance (never the everyday one). The theme is switched through PATCH /api/settings and restored
 * at the end. Output: public/screenshots/<name>-<theme>.webp (1600 px wide) and <name>-<theme>-800.webp.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { SHOTS } from './shots.ts';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    base: { type: 'string', default: 'http://192.168.0.20:7861' },
    themes: { type: 'string', default: 'dark,light' },
    live: { type: 'boolean', default: false },
  },
});

const VIEWPORT = { width: 1600, height: 1000, deviceScaleFactor: 2 };
const outDir = join(import.meta.dir, '..', 'public', 'screenshots');
const base = values.base.replace(/\/$/, '');
const themes = values.themes.split(',') as ('dark' | 'light')[];
const shots = positionals.length
  ? SHOTS.filter((s) => positionals.includes(s.name))
  : SHOTS.filter((s) => !s.manual && !!s.live === values.live);
if (shots.length === 0) throw new Error(`No shot named ${positionals.join(', ')}`);

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json' } });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const failures: string[] = [];
const { theme: initialTheme } = (await api('/api/settings')) as { theme: string };
await mkdir(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  defaultViewport: VIEWPORT,
  // SwiftShader gives the Topology page (WebGL) a GPU-less renderer in headless mode.
  args: ['--hide-scrollbars', '--force-color-profile=srgb', '--enable-unsafe-swiftshader'],
});

try {
  for (const theme of themes) {
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ theme }) });
    for (const shot of shots) {
      const page = await browser.newPage();
      try {
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        await page.goto(`${base}${shot.path}`, { waitUntil: 'networkidle2' });
        if (shot.readyText) await page.waitForSelector(`::-p-text(${shot.readyText})`, { timeout: 15_000 });
        if (shot.goneText) {
          await page.waitForFunction(
            (text) => !document.body.textContent?.includes(text),
            { timeout: 30_000 },
            shot.goneText,
          );
        }
        await shot.prepare?.(page);
        await new Promise((r) => setTimeout(r, shot.delayMs ?? 1200));
        const png = await page.screenshot({ type: 'png' });
        await page.close();

        const file = join(outDir, `${shot.name}-${theme}`);
        await sharp(png).resize({ width: 1600 }).webp({ quality: 86 }).toFile(`${file}.webp`);
        await sharp(png).resize({ width: 800 }).webp({ quality: 82 }).toFile(`${file}-800.webp`);
        console.log(`✓ ${shot.name}-${theme}`);
      } catch (error) {
        failures.push(`${shot.name}-${theme}`);
        console.error(`✗ ${shot.name}-${theme}: ${(error as Error).message}`);
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ theme: initialTheme }) });
}
if (failures.length) {
  console.error(`${failures.length} failed: ${failures.join(', ')}`);
  process.exit(1);
}
