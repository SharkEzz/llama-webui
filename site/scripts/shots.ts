/**
 * Screens of the app captured for the website (see screenshots.ts). Each shot is taken in dark and light.
 * `prepare` puts the page in the state to show (open a sheet, type in an editor…); keep it deterministic.
 *
 * Shots tagged `live` need a generation running (bun scripts/demo-seed.ts generate) and are captured on their own:
 *   bun scripts/screenshots.ts --live
 * Shots tagged `manual` are only captured when named (their state can't be recreated once the demo is seeded).
 */
import type { Page } from 'puppeteer-core';

export interface Shot {
  /** Output base name: public/screenshots/<name>-<theme>.webp */
  name: string;
  /** App route, e.g. "/dashboard". */
  path: string;
  /** Text that must be visible before capturing. */
  readyText?: string;
  /** Text that must have disappeared before capturing (spinners, "Checking..."). */
  goneText?: string;
  prepare?: (page: Page) => Promise<void>;
  /** Extra settle time after `prepare` (charts, animations). */
  delayMs?: number;
  /** Needs a generation in progress. */
  live?: boolean;
  /** Only captured when named on the command line. */
  manual?: boolean;
}

const byText = (text: string) => `::-p-text(${JSON.stringify(text)})`;

/**
 * Clicks through the DOM (element.click()) rather than at mouse coordinates: the app scrolls inside its main column,
 * so coordinate clicks can land on another element after a scroll.
 */
async function click(page: Page, selector: string) {
  const el = await page.waitForSelector(selector, { visible: true, timeout: 15_000 });
  // Text selectors can match an inner node (even an icon's SVG): click the interactive ancestor.
  await el?.evaluate((e) => {
    const target = e.closest('button, a, label, input, [role="checkbox"], [role="tab"], [role="radio"]') ?? e;
    (target as HTMLElement).click();
  });
}

/**
 * The app scrolls inside its main column, not the window: bring the visible element whose own text is exactly `text`
 * (or starts with it) to the top of its scroll container. Waits first, so the page's own auto-scroll (chat) is done.
 */
async function scrollTo(page: Page, text: string, block: 'start' | 'center' | 'end' = 'start') {
  await new Promise((r) => setTimeout(r, 1500));
  await page.waitForFunction(
    (t, b) => {
      const matches = [...document.querySelectorAll<HTMLElement>('body *')].filter(
        (e) => e.childElementCount === 0 && e.offsetParent !== null && e.textContent?.trim().startsWith(t),
      );
      matches[0]?.scrollIntoView({ block: b as ScrollLogicalPosition });
      return matches.length > 0;
    },
    { timeout: 15_000 },
    text,
    block,
  );
}

/** Clicks the button whose visible text is exactly `label` (more reliable than ::-p-text, which can match icons). */
async function clickButton(page: Page, label: string) {
  await page.waitForFunction(
    (text) => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
      button?.click();
      return !!button;
    },
    { timeout: 15_000 },
    label,
  );
}

/** Base UI selects ignore synthetic clicks on their options: pick with the keyboard instead. */
async function selectOption(page: Page, trigger: string, option: string) {
  await page.focus(trigger);
  await page.keyboard.press('ArrowDown');
  await page.waitForSelector('[role="option"]', { visible: true });
  for (let i = 0; i < 30; i++) {
    const highlighted = await page.evaluate(
      () => document.querySelector('[role="option"][data-highlighted]')?.textContent ?? '',
    );
    if (highlighted === option) break;
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role="option"]', { hidden: true });
}

async function scrollMainToBottom(page: Page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 20 && getComputedStyle(el).overflowY.match(/auto|scroll/)) {
        el.scrollTop = el.scrollHeight;
      }
    }
  });
}

export const SHOTS: Shot[] = [
  // Captured on the empty demo instance, before `demo-seed.ts setup`.
  { name: 'setup', path: '/setup', readyText: 'Welcome to llama-webui', goneText: 'Checking…', manual: true },
  { name: 'launchpad', path: '/', readyText: 'Launch pad', goneText: 'Loading' },
  { name: 'dashboard', path: '/dashboard', readyText: 'Throughput', live: true, delayMs: 4000 },
  { name: 'system', path: '/system', readyText: 'NVIDIA GeForce RTX 5070 Ti', live: true, delayMs: 4000 },
  { name: 'topology', path: '/topology', readyText: 'Generating', live: true, delayMs: 6000 },
  { name: 'server', path: '/server', readyText: 'Effective command' },
  {
    name: 'profiles',
    path: '/profiles',
    readyText: 'Qwen3.8 27B · chat (MTP)',
    prepare: async (page) => {
      // The first profile (27B) is selected on load.
      await page.waitForFunction(() => {
        const area = [...document.querySelectorAll('textarea')].find((t) => t.value.includes('--spec-type'));
        area?.focus();
        area?.setSelectionRange(area.value.length, area.value.length);
        return !!area;
      });
      await page.keyboard.type('\n--f', { delay: 60 });
      await page.waitForSelector('[cmdk-item]');
    },
  },
  { name: 'models', path: '/models', readyText: 'Qwen3.8-27B' },
  {
    name: 'models-hf',
    path: '/models',
    readyText: 'Qwen3.8-27B',
    prepare: async (page) => {
      await clickButton(page, 'Download');
      const search = await page.waitForSelector('input[placeholder^="Search GGUF models"]');
      await search?.type('unsloth/Qwen3.8-27B-GGUF');
      await page.keyboard.press('Enter');
      await page.waitForSelector(byText('UD-Q4_K_XL'), { timeout: 30_000 });
    },
    delayMs: 1500,
  },
  {
    name: 'chat',
    path: '/chat/1',
    readyText: 'Tensor split for two GPUs',
    prepare: (page) => scrollTo(page, 'I have two GPUs'),
  },
  { name: 'chat-stats', path: '/chat/1', readyText: 'Tensor split for two GPUs', prepare: scrollMainToBottom },
  { name: 'benchmark', path: '/bench', readyText: 'History', prepare: (page) => scrollTo(page, 'History') },
  {
    name: 'benchmark-compare',
    path: '/bench',
    readyText: 'History',
    prepare: async (page) => {
      await click(page, '[aria-label="Select run #2 for comparison"]');
      await click(page, '[aria-label="Select run #3 for comparison"]');
      await clickButton(page, 'Compare (2)');
      await page.waitForSelector(byText('Comparing 2 runs'));
    },
  },
  {
    name: 'tuning',
    path: '/tuning',
    readyText: 'Recommendation',
    prepare: async (page) => {
      await selectOption(page, '[aria-label="Starting profile"]', 'Qwen3.8 Flash-Next · 70 GB MoE');
      // Loading the profile resets the preset: wait for its recommendation before picking one.
      await page.waitForSelector(byText('experts of the first'), { timeout: 30_000 });
      await page.waitForFunction(
        () => {
          const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('100 GB model'));
          const radio = label?.querySelector('input');
          if (radio && !radio.checked) radio.click();
          return radio?.checked;
        },
        { polling: 500, timeout: 15_000 },
      );
      await scrollTo(page, 'Recommendation');
    },
    delayMs: 2500,
  },
  {
    name: 'tuning-sweep',
    path: '/tuning?sweep=1',
    readyText: 'Exploration (llama-bench)',
    prepare: (page) => scrollTo(page, 'Exploration (llama-bench)', 'center'),
  },
  { name: 'logs', path: '/logs', readyText: 'Auto-follow' },
  { name: 'settings', path: '/settings', readyText: 'Run setup again' },
  {
    name: 'settings-monitoring',
    path: '/settings',
    readyText: 'Run setup again',
    prepare: (page) => clickButton(page, 'Monitoring'),
  },
];
