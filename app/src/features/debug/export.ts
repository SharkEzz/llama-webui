import { snapshot } from '@/lib/debug/capture';
import { redact, toPlain } from '@/lib/debug/json';
import { heapUsed } from '@/lib/debug/perf';
import { debugStores } from '@/lib/debug/stores';
import { formatBytes } from '@/lib/format';
import { useHealth } from '@/lib/health';

/**
 * The page and its browser, label and value: what an issue asks first. The server's machine is in the `monitor` store
 * (`navigator.deviceMemory` is left out: rounded, capped at 8 GiB and absent outside HTTPS or localhost).
 */
export function environment(): [string, string][] {
  const { bootIds } = snapshot().ws;
  const heap = heapUsed();
  return [
    ['Version', useHealth.getState().health?.version ?? '—'],
    ['Build', import.meta.env.DEV ? 'development (pnpm dev)' : 'production'],
    ['Boot id', bootIds.at(-1)?.bootId ?? '—'],
    ['Page', location.href],
    ['Browser', navigator.userAgent],
    ['Language', `${navigator.language}, ${Intl.DateTimeFormat().resolvedOptions().timeZone}`],
    ['Viewport', `${innerWidth} × ${innerHeight} at ${devicePixelRatio}×`],
    ['Screen', `${screen.width} × ${screen.height}`],
    ['Theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light'],
    ['Browser CPU threads', String(navigator.hardwareConcurrency)],
    ['JS heap', heap ? `${formatBytes(heap.used)} of ${formatBytes(heap.limit)}` : 'not reported'],
    ['Online', navigator.onLine ? 'yes' : 'no'],
  ];
}

/** The state of each store loaded, as JSON holds it. */
export function storeStates(): Record<string, unknown> {
  return Object.fromEntries([...debugStores()].map(([name, store]) => [name, toPlain(store.getState())]));
}

/** `llama-webui-debug-2026-11-24T02-37-13.json`, in the page's time zone. */
export function exportName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `llama-webui-debug-${date}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}.json`;
}

/**
 * Everything the window shows, as one JSON file: the environment, the capture and the stores. `privateData` false
 * (the default) redacts it (`redact`).
 */
export function exportCapture(privateData: boolean): void {
  const at = new Date();
  const capture = snapshot(at.getTime());
  // Redacted, a store's change keeps the keys it changed, not their values: they hold the chat's text under keys
  // `redact` cannot know (a message in a list), and they are in `stores` as they are now.
  if (!privateData)
    capture.storeChanges = capture.storeChanges.map(({ id, at: changedAt, store, keys }) => ({
      id,
      at: changedAt,
      store,
      keys,
      prev: {},
      next: {},
    }));
  const plain = toPlain({
    exportedAt: at.toISOString(),
    redacted: !privateData,
    environment: Object.fromEntries(environment()),
    capture,
    stores: storeStates(),
  });
  const data = privateData ? plain : redact(plain);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = exportName(at);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
