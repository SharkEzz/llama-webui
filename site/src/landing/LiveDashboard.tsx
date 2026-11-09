import { AppWindow } from './dashboard/AppWindow';
import { DashboardReplica } from './dashboard/DashboardReplica';
import { useOnScreen, usePrefersReducedMotion, useSimulation } from './useSimulation';

/**
 * The hero visual: the app's Dashboard, recreated in React and fed by a replay of a measured session. It ticks once
 * per second while on screen, and stands up from a slight tilt as it scrolls into view (`scroll-tilt`, pure CSS).
 * With reduced motion, it is a still, flat frame.
 */
export function LiveDashboard() {
  const reduced = usePrefersReducedMotion();
  const [ref, onScreen] = useOnScreen<HTMLElement>();
  const frame = useSimulation(onScreen && !reduced);

  return (
    <figure ref={ref} className="relative">
      <div
        className="halo absolute -top-24 left-[8%] -z-10 h-80 w-1/2 opacity-50 [--halo:var(--tone-blue)] dark:opacity-100"
        aria-hidden="true"
      />
      <div
        className="halo absolute top-1/3 right-0 -z-10 h-96 w-2/5 opacity-50 [--halo:var(--tone-teal)] dark:opacity-100"
        aria-hidden="true"
      />
      <div className="scroll-tilt-scope">
        <div className="scroll-tilt rounded-xl shadow-[0_40px_120px_-30px] shadow-black/50" aria-hidden="true">
          <AppWindow>
            <DashboardReplica frame={frame} />
          </AppWindow>
        </div>
      </div>
      <figcaption className="mx-auto mt-6 max-w-[64ch] text-center text-sm text-muted-foreground text-pretty">
        The Dashboard page, replaying a real session: Qwen3.8 27B with MTP drafting, split across an RTX 5070 Ti and an
        RTX 5060 Ti.
      </figcaption>
    </figure>
  );
}
