/** État du llama-server supervisé (copié de llama-tui, avec l'id du profil). */
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
  /** Dernière commande lancée, citée façon shell (sans le préfixe setpriv). */
  command: string | null;
  profileId: number | null;
}
