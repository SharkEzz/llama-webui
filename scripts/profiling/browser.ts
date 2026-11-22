// Headless Chromium on the GPU, the pages of the app it opens, and the component census of a page.
import { type Browser, type CDPSession, type Page, launch } from 'puppeteer-core';
import { clientOrigins } from './analyze/origins.ts';
import { now, sleep, startTime } from './instance.ts';
import { arr, isRecord, num, str } from './json.ts';
import { type Context, sourcemaps } from './measure.ts';
import type { Census, PageLoad, ResourceKind } from './results.ts';
import type { RunDir } from './run-dir.ts';

export const CHROME_FLAGS = [
  '--no-first-run',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--window-size=1920,1080',
  // Hardware compositing through ANGLE on EGL (checked by `SystemInfo.getInfo`): headless falls back to software otherwise.
  '--use-gl=angle',
  '--use-angle=gl-egl',
  '--ignore-gpu-blocklist',
  '--enable-gpu',
  // A page with no window on screen must not be throttled as a background tab.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

export async function startBrowser(
  run: RunDir,
  chromePath: string,
): Promise<{ browser: Browser; gpuCompositing: string | null; version: string }> {
  const browser = await launch({
    executablePath: chromePath,
    headless: true,
    args: CHROME_FLAGS,
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    protocolTimeout: 300_000,
    // The run's own handlers close Chromium through the undo.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  const pid = browser.process()?.pid ?? null;
  run.writeState({ ...run.readState(), chromePid: pid, chromeStart: pid === null ? null : startTime(pid) });
  const session = await browser.target().createCDPSession();
  const info = await session.send('SystemInfo.getInfo');
  await session.detach();
  const status: unknown = info.gpu.featureStatus;
  const gpuCompositing = isRecord(status) ? str(status.gpu_compositing) || null : null;
  if (gpuCompositing !== 'enabled')
    process.stdout.write('warning: Chromium is compositing in software, blur costs will be overstated\n');
  // The blank tab Chromium opens with is closed once a page of the app is open (`openPage`).
  return { browser, gpuCompositing, version: await browser.version() };
}

/** Runs in the page before any script: counts React commits and long tasks, records paints, and the census. */
const INIT = `(() => {
  const P = (window.__profiling = { commits: 0, census: false, censusCommits: 0, rendered: new Map(), longTasks: [], paints: {}, lcp: 0 });
  const stamp = new WeakMap();
  let n = 0;
  const fnOf = (type) => typeof type === 'function' ? type : type && typeof type === 'object' ? (typeof type.render === 'function' ? type.render : type.type ? fnOf(type.type) : null) : null;
  const walk = (root) => {
    n++;
    P.censusCommits++;
    let f = root;
    outer: while (f) {
      const seen = stamp.get(f);
      stamp.set(f, n);
      // A fiber object that was not in the tree of the previous commit was worked on in this one; PerformedWork (1) says its function ran.
      if (seen !== n - 1 && (f.flags & 1) && (f.tag === 0 || f.tag === 11 || f.tag === 14 || f.tag === 15)) {
        const fn = fnOf(f.type);
        if (fn) {
          const r = P.rendered.get(fn);
          if (r) r.count++;
          else P.rendered.set(fn, { count: 1, name: fn.name });
        }
      }
      if (f.child) { f = f.child; continue; }
      for (;;) {
        if (f === root) break outer;
        if (f.sibling) { f = f.sibling; break; }
        f = f.return;
        if (!f) break outer;
      }
    }
  };
  const hook = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject(r) { const id = hook.renderers.size + 1; hook.renderers.set(id, r); return id; },
    checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {}, setStrictMode() {},
    onCommitFiberRoot(id, root) { P.commits++; if (P.census) { try { walk(root.current); } catch (e) { P.censusError = String(e); } } },
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  const observe = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch {} };
  observe('longtask', (e) => P.longTasks.push({ start: e.startTime, dur: e.duration }));
  observe('paint', (e) => { P.paints[e.name] = e.startTime; });
  observe('largest-contentful-paint', (e) => { P.lcp = e.startTime; });
})()`;

function browserOf(ctx: Context): Browser {
  if (ctx.browser === null) throw new Error('Chromium is not started');
  return ctx.browser;
}

/** A page with the dark scheme, motion allowed and the init script, in a new browser context when `fresh`. */
async function newPage(ctx: Context, fresh: boolean): Promise<Page> {
  const browser = browserOf(ctx);
  const context = fresh ? await browser.createBrowserContext() : browser.defaultBrowserContext();
  const page = await context.newPage();
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ]);
  await page.evaluateOnNewDocument(INIT);
  return page;
}

/** Closes a page, and its browser context when it had its own. */
export async function closePage(page: Page): Promise<void> {
  const context = page.browserContext();
  await page.close();
  if (context !== context.browser().defaultBrowserContext()) await context.close();
}

/** Closes every open page (Chromium keeps running with no page). */
export async function closePages(ctx: Context): Promise<void> {
  for (const page of await browserOf(ctx).pages()) await page.close();
}

/** Resolves on the first `/ws` snapshot the page receives. */
async function firstSnapshot(session: CDPSession): Promise<() => Promise<void>> {
  await session.send('Network.enable');
  let resolve = () => undefined as void;
  const got = new Promise<void>((r) => (resolve = r));
  session.on('Network.webSocketFrameReceived', (ev) => {
    if (ev.response.payloadData.includes('"type":"snapshot"')) resolve();
  });
  return async () => {
    const timeout = sleep(30_000).then(() => Promise.reject(new Error('the page received no /ws snapshot in 30 s')));
    await Promise.race([got, timeout]);
  };
}

/** Opens a page of the app (closing the others): ready once it has its first `/ws` snapshot, plus a fixed 3 s. */
export async function openPage(ctx: Context, path: string, options: { fresh?: boolean } = {}): Promise<Page> {
  const before = await browserOf(ctx).pages();
  const page = await newPage(ctx, options.fresh === true);
  for (const other of before) await other.close();
  const session = await page.createCDPSession();
  const snapshot = await firstSnapshot(session);
  await page.goto(`${ctx.instance.baseUrl}${path}`, { waitUntil: 'load' });
  await snapshot();
  await session.detach();
  await sleep(3000);
  return page;
}

// ---------------------------------------------------------------- census

interface Location {
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
}

/** Where a function was defined, from its `[[FunctionLocation]]`. */
async function locationOf(session: CDPSession, objectId: string): Promise<Location | null> {
  const { internalProperties } = await session.send('Runtime.getProperties', { objectId, ownProperties: true });
  const v: unknown = internalProperties?.find((p) => p.name === '[[FunctionLocation]]')?.value?.value;
  return isRecord(v)
    ? { scriptId: str(v.scriptId), lineNumber: num(v.lineNumber), columnNumber: num(v.columnNumber) }
    : null;
}

/** Counts, over `ms`, the components whose function runs at each React commit; names resolved by the source maps. */
export async function census(ctx: Context, page: Page, ms: number): Promise<Census> {
  await page.evaluate(`(() => {
    const P = window.__profiling;
    P.rendered = new Map();
    P.censusCommits = 0;
    P.census = true;
  })()`);
  await sleep(ms);
  const raw: unknown = await page.evaluate(`(() => {
    const P = window.__profiling;
    P.census = false;
    return { commits: P.censusCommits, error: P.censusError ?? null, counts: [...P.rendered.values()] };
  })()`);
  const result = isRecord(raw) ? raw : {};
  if (typeof result.error === 'string') throw new Error(`census: ${result.error}`);
  const counts = arr(result.counts).map((c) =>
    isRecord(c) ? { count: num(c.count), name: str(c.name) } : { count: 0, name: '' },
  );
  const commits = num(result.commits);

  // The functions themselves, in the same order, then their source location.
  const session = await page.createCDPSession();
  const scripts = new Map<string, string>();
  session.on('Debugger.scriptParsed', (ev) => scripts.set(ev.scriptId, ev.url));
  await session.send('Debugger.enable');
  await session.send('Debugger.disable');
  const list = await session.send('Runtime.evaluate', { expression: '[...window.__profiling.rendered.keys()]' });
  const fns = list.result.objectId
    ? (await session.send('Runtime.getProperties', { objectId: list.result.objectId, ownProperties: true })).result
    : [];
  const originOf = clientOrigins(sourcemaps(ctx));
  const merged = new Map<string, { name: string; module: string; renders: number }>();
  for (const prop of fns) {
    const index = Number(prop.name);
    const objectId = prop.value?.objectId;
    const c = counts[index];
    if (!Number.isInteger(index) || objectId === undefined || c === undefined) continue;
    const at = await locationOf(session, objectId);
    const o =
      at === null
        ? { fn: c.name || '(anonymous)', module: '(unknown)' }
        : originOf({
            functionName: c.name,
            url: scripts.get(at.scriptId) ?? '',
            lineNumber: at.lineNumber,
            columnNumber: at.columnNumber,
          });
    const key = `${o.fn}\u0000${o.module}`;
    const m = merged.get(key);
    if (m) m.renders += c.count;
    else merged.set(key, { name: o.fn, module: o.module, renders: c.count });
  }
  await session.detach();
  const components = [...merged.values()]
    .map((m) => ({
      name: m.name,
      module: m.module,
      renders: m.renders,
      perCommit: commits > 0 ? m.renders / commits : 0,
    }))
    .toSorted((a, b) => b.renders - a.renders);
  return { commits, totalRenders: components.reduce((a, c) => a + c.renders, 0), components };
}

// ---------------------------------------------------------------- page load

const KIND_OF_TYPE: Record<string, ResourceKind> = {
  Document: 'html',
  Script: 'js',
  Stylesheet: 'css',
  Font: 'font',
  XHR: 'api',
  Fetch: 'api',
};

/** What a counter grew by; a reload in a new renderer process starts it again from zero. */
const grown = (before: number, after: number) => (after >= before ? after - before : after);

/** One load of a page: a new browser context when cold; warm is a reload once the cache is filled. */
export async function loadPage(ctx: Context, path: string, cache: 'cold' | 'warm'): Promise<PageLoad> {
  const { load, page } = await loadAndKeep(ctx, path, cache);
  await closePage(page);
  return load;
}

/** `loadPage`, the page left open, with the API calls of the load and their duration (request to its last byte). */
export async function loadAndKeep(
  ctx: Context,
  path: string,
  cache: 'cold' | 'warm',
): Promise<{ load: PageLoad; page: Page; apiCalls: { url: string; ms: number }[] }> {
  await closePages(ctx);
  const page = await newPage(ctx, cache === 'cold');
  const url = `${ctx.instance.baseUrl}${path}`;
  const session = await page.createCDPSession();
  await session.send('Network.enable');
  await session.send('Performance.enable');
  if (cache === 'warm') await page.goto(url, { waitUntil: 'networkidle2' });
  const requests = new Map<
    string,
    { kind: ResourceKind; url: string; start: number; end: number; wire: number; decoded: number }
  >();
  let t0 = 0;
  // Set by the frame handler: an object, so that the wait below sees it change.
  const ws = { snapshotAt: 0 };
  session.on('Network.requestWillBeSent', (ev) => {
    if (t0 === 0) t0 = ev.timestamp;
    const kind = ev.request.url.includes('/api/') ? 'api' : (KIND_OF_TYPE[ev.type ?? ''] ?? 'other');
    const short = ev.request.url.startsWith(ctx.instance.baseUrl)
      ? ev.request.url.slice(ctx.instance.baseUrl.length)
      : ev.request.url;
    requests.set(ev.requestId, { kind, url: short, start: ev.timestamp, end: 0, wire: 0, decoded: 0 });
  });
  session.on('Network.dataReceived', (ev) => {
    const r = requests.get(ev.requestId);
    if (r) r.decoded += ev.dataLength;
  });
  session.on('Network.loadingFinished', (ev) => {
    const r = requests.get(ev.requestId);
    if (r) {
      r.wire = ev.encodedDataLength;
      r.end = ev.timestamp;
    }
  });
  session.on('Network.webSocketFrameReceived', (ev) => {
    if (ws.snapshotAt === 0 && t0 !== 0 && ev.response.payloadData.includes('"type":"snapshot"'))
      ws.snapshotAt = (ev.timestamp - t0) * 1000;
  });
  const before = new Map((await session.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  if (cache === 'warm') await page.reload({ waitUntil: 'networkidle2' });
  else await page.goto(url, { waitUntil: 'networkidle2' });
  const end = now() + 30_000;
  while (ws.snapshotAt === 0 && now() < end) await sleep(50);
  await sleep(3000);
  const timing: unknown = await page.evaluate(`(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const P = window.__profiling;
    return { ttfb: nav.responseStart, load: nav.loadEventEnd, fcp: P.paints['first-contentful-paint'] ?? 0, lcp: P.lcp };
  })()`);
  const after = new Map((await session.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await session.detach();
  const t = isRecord(timing) ? timing : {};
  const byKind: PageLoad['byKind'] = {
    html: { count: 0, bytes: 0 },
    js: { count: 0, bytes: 0 },
    css: { count: 0, bytes: 0 },
    font: { count: 0, bytes: 0 },
    api: { count: 0, bytes: 0 },
    other: { count: 0, bytes: 0 },
  };
  for (const r of requests.values()) {
    byKind[r.kind].count++;
    byKind[r.kind].bytes += r.wire;
  }
  const list = [...requests.values()];
  const load: PageLoad = {
    cache,
    ttfbMs: num(t.ttfb),
    fcpMs: num(t.fcp),
    lcpMs: num(t.lcp),
    loadMs: num(t.load),
    scriptMs: grown(before.get('ScriptDuration') ?? 0, after.get('ScriptDuration') ?? 0) * 1000,
    firstSnapshotMs: ws.snapshotAt,
    requests: list.length,
    wireBytes: list.reduce((a, r) => a + r.wire, 0),
    decodedBytes: list.reduce((a, r) => a + r.decoded, 0),
    byKind,
  };
  const apiCalls = list
    .filter((r) => r.kind === 'api' && r.url.startsWith('/api/') && r.end > 0)
    .map((r) => ({ url: r.url, ms: (r.end - r.start) * 1000 }));
  return { load, page, apiCalls };
}
