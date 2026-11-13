import type { Monitor } from '../monitor/monitor';

/** The monitor without collectors: no snapshot yet, an empty history (contract suite, `LLAMA_WEBUI_TEST_MONITOR=stub`). */
export const stubMonitor = {
  latest: () => null,
  dump: () => ({ intervalMs: 1000, capacity: 0, at: 0, times: [], series: {} }),
  configure: async () => {},
  stop: () => {},
  nvidiaSource: 'nvml',
  nvmlSystem: null,
  onSnapshot: () => () => {},
  setModelPathResolver: () => {},
} as unknown as Monitor;
