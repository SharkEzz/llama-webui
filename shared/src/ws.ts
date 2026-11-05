/** Messages échangés sur le WebSocket /ws. Les payloads `unknown` sont typés aux jalons suivants. */
export type WsMessage =
  | { type: "hello"; payload: { serverTime: number } }
  | { type: "ping" }
  | { type: "pong" }
  | { type: "snapshot"; payload: unknown } // typé en J3
  | { type: "log"; payload: unknown } // typé en J2
  | { type: "server-state"; payload: unknown }; // typé en J2
