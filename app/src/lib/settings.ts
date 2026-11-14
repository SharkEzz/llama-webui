import { type Settings, SettingsInvalid } from '@llama-webui/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { call, errorTag } from './api';

export type SettingsErrors = Partial<Record<keyof Settings, string>>;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The rejection of a patch, if it is `SettingsInvalid`: its fields' messages. */
const invalid = (e: unknown): SettingsInvalid | undefined =>
  errorTag(e) === 'SettingsInvalid' && e instanceof SettingsInvalid ? e : undefined;

/**
 * Settings saved field by field (PATCH /api/settings): validation errors are kept per field, other errors are toasts.
 * `save` resolves to whether the patch was saved.
 */
export function useSettingsEditor() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [errors, setErrors] = useState<SettingsErrors>({});

  useEffect(() => {
    void call((api) => api.settings.get()).then(setSettings, (e: unknown) => toast.error(messageOf(e)));
  }, []);

  const save = async (patch: Partial<Settings>, o: { quiet?: boolean } = {}): Promise<boolean> => {
    const keys = Object.keys(patch) as (keyof Settings)[];
    try {
      const { warning, ...next } = await call((api) => api.settings.patch({ payload: patch }));
      setSettings(next);
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
        for (const i of refused.issues) next[i.path[0] as keyof Settings] ??= i.message;
        setErrors((old) => ({ ...old, ...next }));
      } else toast.error(messageOf(e));
      return false;
    }
  };

  return { settings, errors, save };
}
