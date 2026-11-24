/**
 * Captures the app for the website, in dark and light, with the local Chromium (headless).
 *
 *   pnpm screenshots [name…] [--live] [--base http://192.168.0.20:7861] [--themes dark,light]
 *
 * Without names: every shot except `live` and `manual` ones; --live: the shots that need a running generation.
 *
 * Targets the demo instance (never the everyday one). The theme is switched through PATCH /api/settings and restored
 * at the end. Output: public/screenshots/<name>-<theme>.webp (1600 px wide) and <name>-<theme>-800.webp; an animated
 * shot (`animation`) is a looping WebP of its region, at its width and at 800 px.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { launch } from 'puppeteer-core';
import sharp from 'sharp';
import { cliArgs } from './argv.ts';
import { SHOTS } from './shots.ts';

const { values, positionals } = parseArgs({
  args: cliArgs(),
  allowPositionals: true,
  options: {
    base: { type: 'string', default: 'http://192.168.0.20:7861' },
    themes: { type: 'string', default: 'dark,light' },
    live: { type: 'boolean', default: false },
  },
});

const VIEWPORT = { width: 1600, height: 1000, deviceScaleFactor: 2 };
const outDir = join(import.meta.dirname, '..', 'public', 'screenshots');
const base = values.base.replace(/\/$/, '');
// Each is sent to PATCH /api/settings as it is written, which refuses an unknown theme
const themes = values.themes.split(',');
const shots = positionals.length
  ? SHOTS.filter((s) => positionals.includes(s.name))
  : SHOTS.filter((s) => !s.manual && Boolean(s.live) === values.live);
if (shots.length === 0) throw new Error(`No shot named ${positionals.join(', ')}`);

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json' } });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Frames of an animation, each resized to `width`, as one looping WebP. */
async function writeAnimation(pngs: Uint8Array[], delay: number[], width: number, quality: number, file: string) {
  const resized = await Promise.all(pngs.map((png) => sharp(png).resize({ width }).png().toBuffer()));
  await sharp(resized, { join: { animated: true } })
    .webp({ quality, delay, loop: 0, effort: 6 })
    .toFile(file);
}

const failures: string[] = [];
const settings = await api('/api/settings');
const initialTheme: unknown =
  typeof settings === 'object' && settings !== null ? Reflect.get(settings, 'theme') : undefined;
await mkdir(outDir, { recursive: true });
const browser = await launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  defaultViewport: VIEWPORT,
  args: ['--hide-scrollbars', '--force-color-profile=srgb'],
});

try {
  for (const theme of themes) {
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ theme }) });
    for (const shot of shots) {
      const page = await browser.newPage();
      try {
        if (shot.viewport) await page.setViewport({ ...VIEWPORT, ...shot.viewport });
        if (!shot.motion) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        await shot.beforeLoad?.(page);
        await page.goto(`${base}${shot.path}`, { waitUntil: 'networkidle2' });
        if (shot.readyText) await page.waitForSelector(`::-p-text(${shot.readyText})`, { timeout: 15_000 });
        if (shot.goneText) {
          await page.waitForFunction(
            (text) => !document.body.textContent.includes(text),
            { timeout: 30_000 },
            shot.goneText,
          );
        }
        await shot.prepare?.(page);
        await new Promise((r) => setTimeout(r, shot.delayMs ?? 1200));
        if (shot.animation) {
          const { clip, play } = shot.animation;
          const pngs: Uint8Array[] = [];
          const delay: number[] = [];
          await play(page, async (holdMs) => {
            pngs.push(await page.screenshot({ type: 'png', clip }));
            delay.push(holdMs);
          });
          await page.close();
          const file = join(outDir, `${shot.name}-${theme}`);
          await writeAnimation(pngs, delay, clip.width, 80, `${file}.webp`);
          await writeAnimation(pngs, delay, 800, 76, `${file}-800.webp`);
          console.log(`✓ ${shot.name}-${theme} (${pngs.length} frames)`);
          continue;
        }
        const png = await page.screenshot({ type: 'png' });
        await page.close();

        const file = join(outDir, `${shot.name}-${theme}`);
        await sharp(png).resize({ width: 1600 }).webp({ quality: 86 }).toFile(`${file}.webp`);
        await sharp(png).resize({ width: 800 }).webp({ quality: 82 }).toFile(`${file}-800.webp`);
        console.log(`✓ ${shot.name}-${theme}`);
      } catch (error) {
        failures.push(`${shot.name}-${theme}`);
        console.error(`✗ ${shot.name}-${theme}: ${error instanceof Error ? error.message : String(error)}`);
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
