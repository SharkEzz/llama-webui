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

/** Tuning : matériel, modèle et préréglage en haut, recommandation expliquée, puis l'espace de sweep et ses résultats. */
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

  // ?sweep=<id> ouvre ce sweep ; sinon le sweep qui tourne s'affiche de lui-même.
  // Seul un changement de ?sweep ouvre ; openId est lu à jour sans relancer l'effet.
  const openWanted = useEffectEvent((id: number) => {
    if (id !== openId) void useTuning.getState().open(id);
  });
  useEffect(() => {
    if (wanted !== null) openWanted(wanted);
  }, [wanted]);
  useEffect(() => {
    if (wanted === null && liveId !== null && openId === null) void useTuning.getState().open(liveId);
  }, [wanted, liveId, openId]);
  // L'URL suit le sweep ouvert quand il change (lancement, fermeture, suppression) ; pas au montage, où ?sweep= attend encore.
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
    <div className="flex flex-col gap-6">
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
