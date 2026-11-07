import type { BenchLive, BenchRun } from './bench';
import type { LogLine } from './logs';
import type { Snapshot } from './monitor';
import type { ServerView } from './server';
import type { Sweep, SweepLive } from './sweep';
import type { ModelPlacement } from './topology';

/** Messages exchanged over the /ws WebSocket. */
export type WsMessage =
  | { type: 'hello'; payload: { serverTime: number; bootId: string } }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'snapshot'; payload: Snapshot }
  | { type: 'log'; payload: LogLine[] } // batch of lines
  | { type: 'server-state'; payload: ServerView }
  | { type: 'bench-progress'; payload: BenchLive | null }
  | { type: 'bench-run'; payload: BenchRun } // when a run is created and when it ends
  | { type: 'bench-deleted'; payload: { ids: number[] } }
  | { type: 'sweep-progress'; payload: SweepLive | null }
  | { type: 'sweep'; payload: Sweep } // on every sweep change (status, counters, best)
  | { type: 'sweep-deleted'; payload: { id: number } }
  | { type: 'placement'; payload: ModelPlacement | null }; // placement of the loaded model, on every change
