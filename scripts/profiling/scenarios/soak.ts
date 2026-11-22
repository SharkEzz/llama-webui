// soak: the Dashboard left open five minutes, a light reading every 10 s; the page's heap and the server's memory are
// read after a forced garbage collection at both ends.
import { openPage } from '../browser.ts';
import { sleep } from '../instance.ts';
import { isRecord, num } from '../json.ts';
import { measure, type Scenario } from '../measure.ts';
import type { ScenarioResults } from '../results.ts';

const SECONDS = 300;
const EVERY = 10;
const MB = 2 ** 20;

export const soak: Scenario<'soak'> = {
  name: 'soak',
  run: async (ctx) => {
    const page = await openPage(ctx, '/');
    const session = await page.createCDPSession();
    await session.send('Performance.enable');
    await session.send('HeapProfiler.enable');
    const inspector = ctx.instance.inspector;
    await inspector.send('HeapProfiler.enable');
    const serverMemory = async () => {
      const m: unknown = await inspector.evaluate('process.memoryUsage()');
      return isRecord(m) ? { rssMb: num(m.rss) / MB, heapMb: num(m.heapUsed) / MB } : { rssMb: 0, heapMb: 0 };
    };
    const serverAfterGc = async () => {
      await inspector.send('HeapProfiler.collectGarbage');
      return serverMemory();
    };
    const readings: ScenarioResults['soak']['readings'] = [];
    const read = async (t: number) => {
      const { metrics } = await session.send('Performance.getMetrics');
      const m = new Map(metrics.map((x) => [x.name, x.value]));
      readings.push({
        t,
        heapMb: (m.get('JSHeapUsedSize') ?? 0) / MB,
        nodes: m.get('Nodes') ?? 0,
        listeners: m.get('JSEventListeners') ?? 0,
        serverRssMb: (await serverMemory()).rssMb,
      });
    };
    const start = await serverAfterGc();
    await session.send('HeapProfiler.collectGarbage');
    await read(0);
    const window = await measure(ctx, page, {
      id: 'soak',
      label: 'Dashboard, five minutes',
      ms: SECONDS * 1000,
      ws: true,
      during: async () => {
        for (let t = EVERY; t < SECONDS; t += EVERY) {
          await sleep(EVERY * 1000);
          await read(t);
        }
      },
    });
    await session.send('HeapProfiler.collectGarbage');
    await read(SECONDS);
    const end = await serverAfterGc();
    await session.detach();
    const first = readings[0];
    const last = readings.at(-1);
    if (first && last)
      ctx.log(
        `page heap ${first.heapMb.toFixed(1)} → ${last.heapMb.toFixed(1)} MiB, nodes ${String(first.nodes)} → ${String(last.nodes)}; server RSS ${start.rssMb.toFixed(0)} → ${end.rssMb.toFixed(0)} MiB`,
      );
    return { readings, serverAfterGc: { start, end }, windows: [window] };
  },
};
