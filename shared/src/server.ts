/** State of the supervised llama-server (copied from llama-tui, with the profile id). */
export type ServerState =
  | { kind: 'idle' }
  | { kind: 'starting'; profile: string; profileId: number; pid: number; port: number; since: number }
  | { kind: 'ready'; profile: string; profileId: number; pid: number; port: number; since: number }
  | { kind: 'stopping'; profile: string; profileId: number; pid: number; port: number }
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

export interface ServerView {
  state: ServerState;
  /** Last launched command, shell-quoted (without the setpriv prefix). */
  command: string | null;
  profileId: number | null;
}
