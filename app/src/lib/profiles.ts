import type { ImportResult, Profile, ProfileInput } from '@llama-webui/shared';
import { create } from 'zustand';
import { call } from './api';
import { plural } from './format';

interface ProfilesStore {
  profiles: readonly Profile[];
  loaded: boolean;
  reload(): Promise<void>;
}

export const useProfiles = create<ProfilesStore>()((set) => ({
  profiles: [],
  loaded: false,
  async reload() {
    const profiles = await call((api) => api.profiles.list());
    set({ profiles, loaded: true });
  },
}));

export type ImportSummary = typeof ImportResult.Type;

/** What a create or an update sends: the input fields only (a stored profile's id, source and dates are refused). */
export type NewProfile = ProfileInput;

export const createProfile = (input: NewProfile) => call((api) => api.profiles.create({ payload: input }));
export const updateProfile = (id: number, input: NewProfile) =>
  call((api) => api.profiles.update({ params: { id }, payload: input }));
export const deleteProfile = (id: number) => call((api) => api.profiles.remove({ params: { id } }));
export const duplicateProfile = (id: number) => call((api) => api.profiles.duplicate({ params: { id } }));
/** Any JSON: the server validates each profile on its own. */
export const importProfiles = (raw: unknown) => call((api) => api.profiles.importMany({ payload: raw }));

/** Import summary for a toast: “2 profiles imported, 1 skipped”. */
export function importSummary(r: ImportSummary): string {
  const n = r.imported.length;
  const m = r.skipped.length;
  return `${n} ${plural(n, 'profile')} imported${m ? `, ${m} skipped` : ''}`;
}
