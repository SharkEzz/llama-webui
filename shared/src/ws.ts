import type { BenchLive, BenchRun } from "./bench";
import type { LogLine } from "./logs";
import type { ServerView } from "./server";
import type { Snapshot } from "./monitor";

/** Messages échangés sur le WebSocket /ws. Les payloads `unknown` sont typés aux jalons suivants. */
export type WsMessage =
  | { type: "hello"; payload: { serverTime: number; bootId: string } }
  | { type: "ping" }
  | { type: "pong" }
  | { type: "snapshot"; payload: Snapshot }
  | { type: "log"; payload: LogLine[] } // lot de lignes
  | { type: "server-state"; payload: ServerView }
  | { type: "bench-progress"; payload: BenchLive | null }
  | { type: "bench-run"; payload: BenchRun }; // à la création et à la fin d'un run
