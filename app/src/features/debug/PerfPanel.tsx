import { type PerfSample, SAMPLES, useDebugCapture } from '@/lib/debug/capture';
import { fmt, formatBytes, formatTime } from '@/lib/format';
import { ms } from './helpers';
import { Empty, Facts, Section, Table } from './parts';

/** A line of the last minute's samples, scaled from 0 to its highest value. */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(...values, 1);
  const step = 100 / (SAMPLES - 1);
  const offset = (SAMPLES - values.length) * step;
  const points = values.map((v, i) => `${(offset + i * step).toFixed(2)},${(30 - (v / max) * 28).toFixed(2)}`);
  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      className="h-6 w-32 shrink-0 text-tone-blue"
      role="img"
      aria-label={label}
    >
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** The last minute of a sample's value: its line, its last value, its range. */
function History({
  samples,
  pick,
  unit,
}: {
  samples: PerfSample[];
  pick: (s: PerfSample) => number | undefined;
  unit: (v: number) => string;
}) {
  const values = samples.flatMap((s) => {
    const v = pick(s);
    return v === undefined ? [] : [v];
  });
  if (values.length === 0) return <span className="text-muted-foreground">not reported</span>;
  return (
    <span className="flex items-center gap-3">
      <Sparkline values={values} label={`last ${unit(values.at(-1)!)}`} />
      <span className="min-w-0 truncate text-muted-foreground">
        now {unit(values.at(-1)!)}, between {unit(Math.min(...values))} and {unit(Math.max(...values))}
      </span>
    </span>
  );
}

/** Good, needs improvement or poor, by the thresholds of Web Vitals. */
function rating(value: number, good: number, poor: number): string {
  return value <= good ? 'good' : value <= poor ? 'needs improvement' : 'poor';
}

/** The page's smoothness, its navigations and, in development, the renders of its parts. */
export function PerfPanel() {
  const perf = useDebugCapture((s) => s.view.perf);
  const renders = useDebugCapture((s) => s.view.renders);
  const { longTasks: lt, interactions: ix, lcp, layoutShifts: shifts } = perf;

  return (
    <div className="flex flex-col gap-4 pt-3">
      <Section title="Last minute">
        <p className="text-xs text-muted-foreground">Sampled every half second while this window is open.</p>
        <Facts
          items={[
            [
              'Frame rate',
              <History key="fps" samples={perf.samples} pick={(s) => s.fps} unit={(v) => `${fmt(v, 0)} fps`} />,
            ],
            ['JS heap', <History key="heap" samples={perf.samples} pick={(s) => s.heap} unit={formatBytes} />],
          ]}
        />
      </Section>

      <Section title="Page">
        <Facts
          items={[
            ['Largest paint', lcp ? `${ms(lcp.ms)} (${rating(lcp.ms, 2500, 4000)}), ${lcp.element}` : 'not reported'],
            [
              'Layout shifts',
              shifts.count === 0
                ? 'none'
                : `CLS ${fmt(shifts.worstWindow, 3)} (${rating(shifts.worstWindow, 0.1, 0.25)}), ${shifts.count} shifts, ${fmt(shifts.total, 3)} in all`,
            ],
            ['Long tasks', lt.count === 0 ? 'none' : `${lt.count}, ${ms(lt.totalMs)} in all, worst ${ms(lt.worstMs)}`],
            [
              'Interactions',
              ix.count === 0
                ? 'none over 40 ms'
                : `${ix.count} over 40 ms, worst ${ms(ix.worst?.ms)} (${ix.worst?.name ?? ''}, ${rating(ix.worst?.ms ?? 0, 200, 500)}), last ${ms(ix.last?.ms)} (${ix.last?.name ?? ''})`,
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
