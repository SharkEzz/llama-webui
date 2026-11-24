import { useEffect, useState } from 'react';
import { useDebugCapture } from '@/lib/debug/capture';
import { fmt, formatBytes, formatTime } from '@/lib/format';
import { Empty, Facts, ms, Section, Table } from './parts';

/** The JS heap, where the browser tells it (Chromium). */
function heap(): { used: number; limit: number } | undefined {
  const memory: unknown = Reflect.get(performance, 'memory');
  if (typeof memory !== 'object' || memory === null) return undefined;
  const used: unknown = Reflect.get(memory, 'usedJSHeapSize');
  const limit: unknown = Reflect.get(memory, 'jsHeapSizeLimit');
  return typeof used === 'number' && typeof limit === 'number' ? { used, limit } : undefined;
}

/** Frames per second and the heap, measured every half second while the panel is shown. */
function useFrameRate() {
  const [sample, setSample] = useState<{ fps: number; heap: ReturnType<typeof heap> } | null>(null);
  useEffect(() => {
    let frames = 0;
    let from = performance.now();
    let id = requestAnimationFrame(function tick(t) {
      frames++;
      if (t - from >= 500) {
        setSample({ fps: (frames * 1000) / (t - from), heap: heap() });
        frames = 0;
        from = t;
      }
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, []);
  return sample;
}

/** The page's smoothness, its navigations and, in development, the renders of its parts. */
export function PerfPanel() {
  const perf = useDebugCapture((s) => s.view.perf);
  const renders = useDebugCapture((s) => s.view.renders);
  const sample = useFrameRate();
  const { longTasks: lt, interactions: ix } = perf;

  return (
    <div className="flex flex-col gap-4 pt-3">
      <Section title="Page">
        <Facts
          items={[
            ['Frame rate', sample ? `${fmt(sample.fps, 0)} fps` : '—'],
            [
              'JS heap',
              sample?.heap ? `${formatBytes(sample.heap.used)} of ${formatBytes(sample.heap.limit)}` : 'not reported',
            ],
            ['Long tasks', lt.count === 0 ? 'none' : `${lt.count}, ${ms(lt.totalMs)} in all, worst ${ms(lt.worstMs)}`],
            [
              'Interactions',
              ix.count === 0
                ? 'none over 40 ms'
                : `${ix.count} over 40 ms, worst ${ms(ix.worst?.ms)} (${ix.worst?.name ?? ''}), last ${ms(ix.last?.ms)} (${ix.last?.name ?? ''})`,
            ],
          ]}
        />
      </Section>

      <Section title="Navigations">
        {perf.navigations.length === 0 ? (
          <Empty>No navigation since the capture started.</Empty>
        ) : (
          <Table head={['At', 'Page', 'Until rendered']}>
            {perf.navigations.toReversed().map((n) => (
              <tr key={`${n.at}-${n.path}`}>
                <td className="px-1.5 py-0.5">{formatTime(n.at)}</td>
                <td className="px-1.5 py-0.5 font-mono">{n.path}</td>
                <td className="px-1.5 py-0.5">{n.ms === undefined ? 'nothing to load' : ms(n.ms)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="React renders">
        {!import.meta.env.DEV ? (
          <Empty>Render metrics need a development build (pnpm dev): React does not time renders in production.</Empty>
        ) : renders.length === 0 ? (
          <Empty>No render since the capture started.</Empty>
        ) : (
          <Table head={['Part', 'Commits', 'Since nav.', 'Mounts', 'Mean', 'Worst', 'Last', 'Base']}>
            {renders
              .toSorted((a, b) => b.sumMs - a.sumMs)
              .map((r) => (
                <tr key={r.id}>
                  <td className="px-1.5 py-0.5 font-mono">{r.id}</td>
                  <td className="px-1.5 py-0.5">{r.commits}</td>
                  <td className="px-1.5 py-0.5">{r.sinceNavigation}</td>
                  <td className="px-1.5 py-0.5">{r.mounts}</td>
                  <td className="px-1.5 py-0.5">{ms(r.sumMs / r.commits)}</td>
                  <td className="px-1.5 py-0.5">{ms(r.maxMs)}</td>
                  <td className="px-1.5 py-0.5">{ms(r.lastMs)}</td>
                  <td className="px-1.5 py-0.5">{ms(r.baseMs)}</td>
                </tr>
              ))}
          </Table>
        )}
      </Section>
    </div>
  );
}
