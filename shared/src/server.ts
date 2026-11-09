/**
 * State of the supervised llama-server (copied from llama-tui, with the profile id). `host` is the `--host` it listens
 * on: the probes go there (loopback for a wildcard address). An external server is reached on loopback.
 */
export type ServerState =
  | { kind: 'idle' }
  | { kind: 'starting'; profile: string; profileId: number; pid: number; host: string; port: number; since: number }
  | { kind: 'ready'; profile: string; profileId: number; pid: number; host: string; port: number; since: number }
  | { kind: 'stopping'; profile: string; profileId: number; pid: number; host: string; port: number }
  | {
      kind: 'crashed';
      profile: string;
      profileId: number;
      exitCode: number | null;
      signal: string | null;
      at: number;
      message?: string;
    }
  | { kind: 'external'; pid: number | null; port: number };

/** The `--host` of a state's server: null for an external one (reached on loopback) or no server. */
export const stateHost = (s: ServerState): string | null => ('host' in s ? s.host : null);

export interface ServerView {
  state: ServerState;
  /** Last launched command, shell-quoted (without the setpriv prefix). */
  command: string | null;
  profileId: number | null;
}
