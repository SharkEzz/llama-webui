import { useEffect, useEffectEvent, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { useModels } from '@/lib/models';
import { startTuningSync, useTuning } from '@/lib/tuning';
import { HardwareCard } from './HardwareCard';
import { ModelCard } from './ModelCard';
import { PresetPicker } from './PresetPicker';
import { RecommendationCard } from './RecommendationCard';
import { SpaceEditor } from './SpaceEditor';
import { SweepCard } from './SweepCard';
import { SweepHistory } from './SweepHistory';

/** Tuning: hardware, model and preset at the top, the explained recommendation, then the sweep space and its results. */
export function TuningPage() {
  const [params, setParams] = useSearchParams();
  const wanted = Number(params.get('sweep')) || null;
  const openId = useTuning((s) => s.current?.sweep.id ?? null);
  const liveId = useTuning((s) => s.sweepLive?.sweepId ?? null);

  useEffect(() => {
    startTuningSync();
    const s = useTuning.getState();
    void s.loadHardware();
    void s.loadSweeps();
    if (!useModels.getState().list) void useModels.getState().refresh();
  }, []);

  // ?sweep=<id> opens that sweep; otherwise the running sweep shows up on its own.
  // Only a change of ?sweep opens one; openId is read fresh without re-running the effect.
  const openWanted = useEffectEvent((id: number) => {
    if (id !== openId) void useTuning.getState().open(id);
  });
  useEffect(() => {
    if (wanted !== null) openWanted(wanted);
  }, [wanted]);
  useEffect(() => {
    if (wanted === null && liveId !== null && openId === null) void useTuning.getState().open(liveId);
  }, [wanted, liveId, openId]);
  // The URL follows the open sweep when it changes (launch, close, delete); not on mount, where ?sweep= is still pending.
  const prevOpen = useRef(openId);
  const syncUrl = useEffectEvent(() => {
    if (openId !== wanted) setParams(openId === null ? {} : { sweep: String(openId) }, { replace: true });
  });
  useEffect(() => {
    if (prevOpen.current === openId) return;
    prevOpen.current = openId;
    syncUrl();
  }, [openId]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl font-semibold tracking-tight">Tuning</h1>
      <div className="grid items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <HardwareCard />
        <ModelCard />
        <PresetPicker />
      </div>
      <RecommendationCard />
      <SweepCard />
      <SpaceEditor />
      <SweepHistory />
    </div>
  );
}
