import type { ServerView } from '@llama-webui/shared';
import { BenchGate } from './bench/gate';
import { LogBuffer } from './logs/buffer';
import { Monitor, type MonitorSettings } from './monitor/monitor';
import { Supervisor } from './supervisor/supervisor';

export interface Runtime {
  supervisor: Supervisor;
  logs: LogBuffer;
  /** ID of this llama-webui boot (stable across development reloads): the client ties log numbering to it. */
  bootId: string;
  /** Always-on monitoring, started once by startMonitor() (also survives development reloads). */
  monitor: Promise<Monitor> | null;
  /** Server gate during benchmarks: held across a reload, so a sweep resumes without a restart. */
  benchGate: BenchGate;
}

const g = globalThis as { __llamaWebuiRuntime?: Runtime };

/**
 * Single supervisor and log ring for the whole process. They live on globalThis to survive a development reload
 * (`server/dev.ts`: a code reload must neither kill nor orphan llama-server). Shutdown signal handlers are installed
 * only once. Consequence: changing supervisor.ts, logs/buffer.ts, bench/gate.ts, server/monitor/** (except
 * placement.ts, whose tracker server/index.ts recreates on every reload), server/collectors/** or this file requires
 * restarting `pnpm dev`.
 */
export function getRuntime(): Runtime {
  if (g.__llamaWebuiRuntime) return g.__llamaWebuiRuntime;
  const logs = new LogBuffer(10_000);
  const supervisor = new Supervisor({ logs });
  const rt: Runtime = {
    supervisor,
    logs,
    bootId: crypto.randomUUID(),
    monitor: null,
    benchGate: new BenchGate({ server: supervisor, logs }),
  };
  g.__llamaWebuiRuntime = rt;

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    if (supervisor.managedPid !== null) console.log(`[llama-webui] ${signal}: stopping llama-server…`);
    if (rt.monitor) await rt.monitor.then((m) => m.stop()).catch(() => {});
    await supervisor.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('exit', () => supervisor.killNow());
  return rt;
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
