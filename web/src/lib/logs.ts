import { EMPTY_LOG_VIEW, type LogLine, type LogView, mergeLogs, onBoot } from '@llama-webui/shared';
import { create } from 'zustand';
import { api } from './api';
import { onWs, useWs } from './ws';

const MAX_LINES = 10_000;

/** Logs reçus du serveur, rattachés à son démarrage (bootId) : un redémarrage de llama-webui repart de zéro. */
export const useLogs = create<LogView>()(() => EMPTY_LOG_VIEW);

/** « Vider l'affichage » : masque les lignes reçues jusqu'ici (le ring du serveur n'est pas touché). */
export const hideCurrentLogs = () => useLogs.setState((s) => ({ hiddenBefore: s.seq }));

interface LogsResponse {
  lines: LogLine[];
  seq: number;
  bootId: string;
}

async function replay() {
  const asked = useLogs.getState();
  try {
    const r = await api<LogsResponse>(`/logs?since=${asked.seq}`);
    const now = useLogs.getState();
    if (r.bootId !== asked.bootId && asked.bootId !== null) {
      // Autre démarrage que celui des lignes demandées : on repart de zéro et on relit tout.
      useLogs.setState(onBoot(now, r.bootId));
      const all = await api<LogsResponse>('/logs?since=0');
      useLogs.setState((s) => mergeLogs(onBoot(s, all.bootId), all.lines, MAX_LINES));
    } else useLogs.setState(mergeLogs(onBoot(now, r.bootId), r.lines, MAX_LINES));
  } catch {
    // réessayé à la prochaine reconnexion
  }
}

let started = false;
export function startLogsSync() {
  if (started) return;
  started = true;
  // Le hello arrive avant toute ligne sur une nouvelle connexion : le changement de démarrage est vu en premier.
  onWs('hello', (m) => useLogs.setState((s) => onBoot(s, m.payload.bootId)));
  onWs('log', (m) => useLogs.setState((s) => mergeLogs(s, m.payload, MAX_LINES)));
  useWs.subscribe((s, prev) => {
    if (s.status === 'open' && prev.status !== 'open') void replay();
  });
}
