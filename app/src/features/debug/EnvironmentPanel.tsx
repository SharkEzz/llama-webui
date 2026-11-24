import { useDebugCapture } from '@/lib/debug/capture';
import { environment } from './export';
import { Facts, Section } from './parts';

/** The page, its browser and the server's version: what an issue asks first. */
export function EnvironmentPanel() {
  // Read again at each publication of the capture (the viewport, the heap, the boot id change).
  useDebugCapture((s) => s.view.at);
  return (
    <div className="flex flex-col gap-4 pt-3">
      <Section title="Environment">
        <Facts items={environment()} />
      </Section>
    </div>
  );
}
