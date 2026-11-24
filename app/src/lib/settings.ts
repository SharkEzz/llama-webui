import { Settings, SettingsInvalid } from '@llama-webui/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { call, errorMessage, errorTag } from './api';
import { debugStore } from './debug/stores';

export type SettingsErrors = Partial<Record<keyof Settings, string>>;

/** A key of the settings (an issue's path names one, a patch holds only them). */
const isSetting = (key: string | undefined): key is keyof Settings =>
  key !== undefined && Object.hasOwn(Settings.fields, key);

/** The rejection of a patch, if it is `SettingsInvalid`: its fields' messages. */
const invalid = (e: unknown): SettingsInvalid | undefined =>
  errorTag(e) === 'SettingsInvalid' && e instanceof SettingsInvalid ? e : undefined;

interface SettingsState {
  /** The last settings read or saved; `null` until the first reply. */
  settings: Settings | null;
  /** Rereads the settings; a failure keeps the last ones and rejects. */
  load: () => Promise<void>;
}

/**
 * The settings, shared by the pages: read when the WebSocket opens (`AppLayout`), so a page opened later renders from
 * them right away, and a read that failed while the server was away is done again when it is back.
 */
export const useSettings = create<SettingsState>()((set) => ({
  settings: null,
  async load() {
    set({ settings: await call((api) => api.settings.get()) });
  },
}));

/**
 * Settings saved field by field (PATCH /api/settings): validation errors are kept per field, other errors are toasts.
 * `save` resolves to whether the patch was saved. `settings` is the shared store's, reread on mount.
 */
export function useSettingsEditor() {
  const settings = useSettings((s) => s.settings);
  const [errors, setErrors] = useState<SettingsErrors>({});

  useEffect(() => {
    useSettings
      .getState()
      .load()
      .catch((e: unknown) => toast.error(errorMessage(e)));
  }, []);

  const save = async (patch: Partial<Settings>, o: { quiet?: boolean } = {}): Promise<boolean> => {
    const keys = Object.keys(patch).filter(isSetting);
    try {
      const { warning, ...next } = await call((api) => api.settings.patch({ payload: patch }));
      useSettings.setState({ settings: next });
      if (warning !== undefined) toast.warning(warning);
      setErrors((e) => {
        const copy = { ...e };
        for (const k of keys) delete copy[k];
        return copy;
      });
      if (!o.quiet && warning === undefined) toast.success('Setting saved', { id: 'settings-saved' });
      return true;
    } catch (e) {
      const refused = invalid(e);
      if (refused && refused.issues.length > 0) {
        const next: SettingsErrors = {};
        for (const i of refused.issues) {
          // A path that names no setting shows nowhere
          const key = i.path[0];
          if (isSetting(key)) next[key] ??= i.message;
        }
        setErrors((old) => ({ ...old, ...next }));
      } else toast.error(errorMessage(e));
      return false;
    }
  };

  return { settings, errors, save };
}

debugStore('settings', useSettings);
