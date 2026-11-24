import { useState } from 'react';
import { useDebugCapture } from '@/lib/debug/capture';
import { formatBytes, formatTime } from '@/lib/format';
import { ms } from './helpers';
import { Chip, Empty, Facts, Section, SHOWN, Table } from './parts';

/** The timings of the page's load, from the navigation entry of the document. */
function pageLoad(): [string, string][] {
  const [nav] = performance.getEntriesByType('navigation');
  if (!(nav instanceof PerformanceNavigationTiming)) return [['Page load', 'not reported']];
  return [
    ['Loaded at', formatTime(performance.timeOrigin)],
    ['First byte', ms(nav.responseStart)],
    ['DOM ready', ms(nav.domContentLoadedEventEnd)],
    ['Load event', nav.loadEventEnd > 0 ? ms(nav.loadEventEnd) : 'not yet'],
    ['Document', `${formatBytes(nav.transferSize)} transferred, ${formatBytes(nav.decodedBodySize)} uncompressed`],
  ];
}

/** What the page loaded besides its API calls: scripts (the chunk of each page), style sheets, fonts, images. */
export function LoadsPanel() {
  const resources = useDebugCapture((s) => s.view.resources);
  const [type, setType] = useState<string | null>(null);
  const types = [...new Set(resources.map((r) => r.type))].toSorted();
  const shown = resources
    .filter((r) => type === null || r.type === type)
    .slice(-SHOWN)
    .toReversed();
  const transferred = resources.reduce((sum, r) => sum + r.transferBytes, 0);
  const cached = resources.filter((r) => r.cached).length;

  return (
    <div className="flex flex-col gap-4 pt-3">
      <Section title="Page">
        <Facts
          items={[
            ...pageLoad(),
            ['Files', `${resources.length}, ${formatBytes(transferred)} transferred, ${cached} from the cache`],
          ]}
        />
      </Section>

      <Section
        title={`Files (last ${shown.length} of ${resources.length})`}
        actions={
          <div className="flex flex-wrap justify-end gap-1">
            <Chip pressed={type === null} onClick={() => setType(null)}>
              all
            </Chip>
            {types.map((t) => (
              <Chip key={t} pressed={type === t} onClick={() => setType(t)}>
                {t}
              </Chip>
            ))}
          </div>
        }
      >
        {shown.length === 0 ? (
          <Empty>No file loaded since the capture started.</Empty>
        ) : (
          <Table head={['At', 'File', 'Type', 'Transferred', 'Size', 'Time']}>
            {shown.map((r) => (
              <tr key={r.id}>
                <td className="px-1.5 py-0.5">{formatTime(r.at)}</td>
                <td className="w-full max-w-0 truncate px-1.5 py-0.5 font-mono" title={r.name}>
                  {r.name}
                </td>
                <td className="px-1.5 py-0.5">{r.type}</td>
                <td className="px-1.5 py-0.5">{r.cached ? 'cache' : formatBytes(r.transferBytes)}</td>
                <td className="px-1.5 py-0.5">{formatBytes(r.bytes)}</td>
                <td className="px-1.5 py-0.5">{ms(r.ms)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}
