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
  | { type: "server-state"; payload: ServerView };
