import type { Profile } from '@llama-webui/shared';
import { create } from 'zustand';
import { type ApiOptions, api } from './api';
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
    const profiles = await api('GET /api/profiles');
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
export type NewProfile = ApiOptions<'POST /api/profiles'>['body'];

export const createProfile = (input: NewProfile) => api('POST /api/profiles', { body: input });
/** The server validates the body after finding the profile (404 first): it takes it as sent. */
export const updateProfile = (id: number, input: unknown) =>
  api('PUT /api/profiles/:id', { params: { id: id }, body: input });
export const deleteProfile = (id: number) => api('DELETE /api/profiles/:id', { params: { id: id } });
export const duplicateProfile = (id: number) => api('POST /api/profiles/:id/duplicate', { params: { id: id } });
export const importProfiles = (raw: unknown) => api('POST /api/profiles/import', { body: raw });
export const llamaTuiStatus = () => api('GET /api/profiles/import/llama-tui');
export const importLlamaTui = () => api('POST /api/profiles/import/llama-tui');

/** Import summary for a toast: “2 profiles imported, 1 skipped”. */
export function importSummary(r: ImportResult): string {
  const n = r.imported.length;
  const m = r.skipped.length;
  return `${n} ${plural(n, 'profile')} imported${m ? `, ${m} skipped` : ''}`;
}
