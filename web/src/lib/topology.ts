import type { ModelPlacement, TopologyGraph } from '@llama-webui/shared';
import { create } from 'zustand';
import { api } from './api';
import { onWs, useWs } from './ws';

interface TopologyState {
  /** Graphe matériel (sysfs) ; null tant qu'il n'a pas été lu. */
  graph: TopologyGraph | null;
  /** Répartition du modèle chargé ; null sans serveur géré ou tant que les logs ne l'ont pas donnée. */
  placement: ModelPlacement | null;
  /** La dernière lecture de /api/topology a échoué. */
  error: boolean;
}

export const useTopology = create<TopologyState>()(() => ({ graph: null, placement: null, error: false }));

/** Numéro du dernier placement reçu par le WS : une réponse REST partie avant lui ne doit pas l'écraser. */
let placementSeq = 0;
let requestSeq = 0;

/** Relit le graphe (l'état courant des liens change avec les états d'énergie) et le placement. */
export async function refreshTopology(): Promise<void> {
  const req = ++requestSeq;
  const seenPlacement = placementSeq;
  try {
    const r = await api<{ graph: TopologyGraph; placement: ModelPlacement | null }>('/topology');
    if (req !== requestSeq) return; // une relecture plus récente est partie : elle fera foi
    useTopology.setState(
      placementSeq === seenPlacement
        ? { graph: r.graph, placement: r.placement, error: false }
        : { graph: r.graph, error: false },
    );
  } catch {
    if (req === requestSeq) useTopology.setState({ error: true });
  }
}

let started = false;
/** Alimente le store : messages « placement » + relecture à chaque (re)connexion. */
export function startTopologySync(): void {
  if (started) return;
  started = true;
  onWs('placement', (m) => {
    placementSeq++;
    useTopology.setState({ placement: m.payload });
  });
  useWs.subscribe((s, prev) => {
    if (s.status === 'open' && prev.status !== 'open') void refreshTopology();
  });
}
