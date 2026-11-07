import type { BenchLive, BenchRun } from './bench';
import type { LogLine } from './logs';
import type { Snapshot } from './monitor';
import type { ServerView } from './server';
import type { Sweep, SweepLive } from './sweep';

/** Messages échangés sur le WebSocket /ws. */
export type WsMessage =
  | { type: 'hello'; payload: { serverTime: number; bootId: string } }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'snapshot'; payload: Snapshot }
  | { type: 'log'; payload: LogLine[] } // lot de lignes
  | { type: 'server-state'; payload: ServerView }
  | { type: 'bench-progress'; payload: BenchLive | null }
  | { type: 'bench-run'; payload: BenchRun } // à la création et à la fin d'un run
  | { type: 'bench-deleted'; payload: { ids: number[] } }
  | { type: 'sweep-progress'; payload: SweepLive | null }
  | { type: 'sweep'; payload: Sweep } // à chaque changement d'un sweep (statut, compteurs, meilleur)
  | { type: 'sweep-deleted'; payload: { id: number } };
