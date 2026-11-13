import type { ServerView } from '@llama-webui/shared';
import { BenchGate } from './bench/gate';
import { LogBuffer } from './logs/buffer';
import { Monitor, type MonitorSettings } from './monitor/monitor';
import { Supervisor } from './supervisor/supervisor';

export interface Runtime {
  supervisor: Supervisor;
  logs: LogBuffer;
  /** ID of this llama-webui boot: the client ties log numbering to it. */
  bootId: string;
  /** Always-on monitoring, started once by startMonitor(). */
  monitor: Promise<Monitor> | null;
  /** Server gate during benchmarks. */
  benchGate: BenchGate;
}

/**
 * The supervisor, the log ring and the bench gate of the process; the monitor comes later (startMonitor()). Builds
 * only: `start()` (`server/index.ts`) stops them at shutdown.
 */
export function createRuntime(): Runtime {
  const logs = new LogBuffer(10_000);
  const supervisor = new Supervisor({ logs });
  return {
    supervisor,
    logs,
    bootId: crypto.randomUUID(),
    monitor: null,
    benchGate: new BenchGate({ server: supervisor, logs }),
  };
}

/** The process Monitor, started on the first call with these settings; later calls return it as is. */
export function startMonitor(rt: Runtime, settings: MonitorSettings): Promise<Monitor> {
  rt.monitor ??= Monitor.start({ supervisor: rt.supervisor, settings });
  return rt.monitor;
}

export function serverView(supervisor: Supervisor): ServerView {
  const state = supervisor.state;
  const last = supervisor.lastCommand;
  return {
    state,
    command: last?.display ?? null,
    profileId: 'profileId' in state ? state.profileId : (last?.profileId ?? null),
  };
}

/** Profile of the managed server while it runs (not after a crash). */
export function activeProfileId(supervisor: Supervisor): number | null {
  const s = supervisor.state;
  return s.kind === 'starting' || s.kind === 'ready' || s.kind === 'stopping' ? s.profileId : null;
}
