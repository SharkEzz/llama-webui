import type { Profile } from '@llama-webui/shared';
import type { InferRequestType } from 'hono/client';
import { create } from 'zustand';
import { byId, call, client } from './api';
import { plural } from './format';

interface ProfilesStore {
  profiles: Profile[];
  loaded: boolean;
  reload(): Promise<void>;
}

export const useProfiles = create<ProfilesStore>()((set) => ({
  profiles: [],
  loaded: false,
  async reload() {
    const profiles = await call(client.profiles.$get());
    set({ profiles, loaded: true });
  },
}));

export interface ImportResult {
  imported: Profile[];
  skipped: { name: string; reason: string }[];
}

export interface LlamaTuiStatus {
  path: string;
  exists: boolean;
  names: string[];
  error?: string;
  dismissed: boolean;
  profileCount: number;
}

/** What `POST /api/profiles` accepts (the input of `ProfileInputSchema`). */
export type NewProfile = InferRequestType<typeof client.profiles.$post>['json'];

export const createProfile = (input: NewProfile) => call(client.profiles.$post({ json: input }));
/** The server validates the body after finding the profile (404 first): it takes it as sent. */
export const updateProfile = (id: number, input: unknown) =>
  call(client.profiles[':id'].$put({ ...byId(id), json: input }));
export const deleteProfile = (id: number) => call(client.profiles[':id'].$delete(byId(id)));
export const duplicateProfile = (id: number) => call(client.profiles[':id'].duplicate.$post(byId(id)));
export const importProfiles = (raw: unknown) => call(client.profiles.import.$post({ json: raw }));
export const llamaTuiStatus = () => call(client.profiles.import['llama-tui'].$get());
export const importLlamaTui = () => call(client.profiles.import['llama-tui'].$post());

/** Import summary for a toast: “2 profiles imported, 1 skipped”. */
export function importSummary(r: ImportResult): string {
  const n = r.imported.length;
  const m = r.skipped.length;
  return `${n} ${plural(n, 'profile')} imported${m ? `, ${m} skipped` : ''}`;
}
