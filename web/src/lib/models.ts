import {
  defer,
  type ModelDeleted,
  type ModelEntry,
  type ModelList,
  type ModelSummary,
  type ModelUsage,
} from '@llama-webui/shared';
import { create } from 'zustand';
import { api } from './api';

interface ModelsState {
  list: ModelList | null;
  error: string | null;
  loading: boolean;
  /** Rescans the models folder (the server only rereads changed files). */
  refresh(): Promise<void>;
}

export const useModels = create<ModelsState>((set, get) => ({
  list: null,
  error: null,
  loading: false,
  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });
    using _loading = defer(() => set({ loading: false }));
    try {
      set({ list: await api<ModelList>('/models'), error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

export const readable = (e: ModelEntry): e is { ok: true } & ModelSummary => e.ok;

/** File name without folder or extension. */
export const stem = (path: string) => path.replace(/^.*\//, '').replace(/(-\d{5}-of-\d{5})?\.gguf$/, '');

const QUANT = /^(b?f\d+|q\d\w*|iq\d\w*|mxfp\d+)$/i;

/** Base name of a projector: “mmproj-Qwen3.8-27B-BF16” → “qwen3.8-27b”. */
function projectorBase(path: string): string {
  const parts = stem(path)
    .replace(/^mmproj[-_.]?/i, '')
    .replace(/[-_.]?mmproj$/i, '')
    .split('-');
  if (parts.length > 1 && QUANT.test(parts[parts.length - 1]!)) parts.pop();
  return parts.join('-').toLowerCase();
}

/** The projector in the same folder whose name matches the model, if there is exactly one. */
export function matchingProjector(modelPath: string, models: ModelEntry[]): string | null {
  const dir = modelPath.slice(0, modelPath.lastIndexOf('/'));
  const name = stem(modelPath).toLowerCase();
  const found = models
    .filter(readable)
    .filter((m) => m.kind === 'mmproj' && m.path.slice(0, m.path.lastIndexOf('/')) === dir)
    .filter((m) => {
      const base = projectorBase(m.path);
      return base !== '' && name.startsWith(base);
    });
  return found.length === 1 ? found[0]!.path : null;
}

/** What deleting the model at `path` removes (files, profiles using it) and why it is refused, if it is. */
export const modelUsage = (path: string) => api<ModelUsage>(`/models/usage?path=${encodeURIComponent(path)}`);

/** Deletes the model's files, and the profiles using it when `deleteProfiles` is set. */
export const deleteModel = (path: string, deleteProfiles: boolean) =>
  api<ModelDeleted>('/models', { method: 'DELETE', body: JSON.stringify({ path, deleteProfiles }) });
