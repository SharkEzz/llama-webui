import { EMPTY_LOG_VIEW, type LogLine, type LogView, mergeLogs, onBoot } from '@llama-webui/shared';
import { create } from 'zustand';
import { api } from './api';
import { onWs, useWs } from './ws';

const MAX_LINES = 10_000;

/** Logs received from the server, tied to its boot (bootId): a llama-webui restart starts from scratch. */
export const useLogs = create<LogView>()(() => EMPTY_LOG_VIEW);

/** “Clear view”: hides the lines received so far (the server ring is left untouched). */
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
      // Different boot than the one of the requested lines: start over and reread everything.
      useLogs.setState(onBoot(now, r.bootId));
      const all = await api<LogsResponse>('/logs?since=0');
      useLogs.setState((s) => mergeLogs(onBoot(s, all.bootId), all.lines, MAX_LINES));
    } else useLogs.setState(mergeLogs(onBoot(now, r.bootId), r.lines, MAX_LINES));
  } catch {
    // retried on the next reconnect
  }
}

let started = false;
export function startLogsSync() {
  if (started) return;
  started = true;
  // The hello arrives before any line on a new connection: the boot change is seen first.
  onWs('hello', (m) => useLogs.setState((s) => onBoot(s, m.payload.bootId)));
  onWs('log', (m) => useLogs.setState((s) => mergeLogs(s, m.payload, MAX_LINES)));
  useWs.subscribe((s, prev) => {
    if (s.status === 'open' && prev.status !== 'open') void replay();
  });
}
