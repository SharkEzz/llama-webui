import type { Settings } from '@llama-webui/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api } from './api';

export type SettingsErrors = Partial<Record<keyof Settings, string>>;

/**
 * Settings saved field by field (PATCH /api/settings): validation errors are kept per field, other errors are toasts.
 * `save` resolves to whether the patch was saved.
 */
export function useSettingsEditor() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [errors, setErrors] = useState<SettingsErrors>({});

  useEffect(() => {
    void api<Settings>('/settings').then(setSettings, (e: Error) => toast.error(e.message));
  }, []);

  const save = async (patch: Partial<Settings>, o: { quiet?: boolean } = {}): Promise<boolean> => {
    const keys = Object.keys(patch) as (keyof Settings)[];
    try {
      const { warning, ...next } = await api<Settings & { warning?: string }>('/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setSettings(next);
      if (warning) toast.warning(warning);
      setErrors((e) => {
        const copy = { ...e };
        for (const k of keys) delete copy[k];
        return copy;
      });
      if (!o.quiet && !warning) toast.success('Setting saved', { id: 'settings-saved' });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.issues.length > 0) {
        const next: SettingsErrors = {};
        for (const i of e.issues) next[i.path[0] as keyof Settings] ??= i.message;
        setErrors((old) => ({ ...old, ...next }));
      } else toast.error(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  return { settings, errors, save };
}
