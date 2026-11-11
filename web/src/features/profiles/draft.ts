import type { Profile } from '@llama-webui/shared';
import { formatArgs, formatEnv } from './argsText';

/** The profile form's fields, as typed. */
export interface Draft {
  name: string;
  model: string;
  mmproj: string;
  cwd: string;
  host: string;
  port: string;
  args: string;
  env: string;
}

export function draftOf(p: Profile | null, initial?: Partial<Draft>): Draft {
  return {
    name: p?.name ?? '',
    model: p?.model ?? '',
    mmproj: p?.mmproj ?? '',
    cwd: p?.cwd ?? '',
    host: p?.host ?? '',
    port: p?.port !== undefined ? String(p.port) : '',
    args: formatArgs(p?.args ?? []),
    env: formatEnv(p?.env ?? {}),
    ...initial,
  };
}

/** Whether a saved change alters the llama-server command (everything but the name): a running server must restart. */
export function commandChanged(before: Profile, after: Profile): boolean {
  const { name: _a, ...a } = draftOf(before);
  const { name: _b, ...b } = draftOf(after);
  return JSON.stringify(a) !== JSON.stringify(b);
}
