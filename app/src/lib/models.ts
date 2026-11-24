import {
  defer,
  type ModelDeleted,
  type ModelEntry,
  type ModelList,
  type ModelSummary,
  type ModelUsage,
} from '@llama-webui/shared';
import { create } from 'zustand';
import { errorMessage, call as webCall } from './api';
import { debugStore } from './debug/stores';
import { stem } from './stem';

interface ModelsState {
  list: ModelList | null;
  /** Why the last scan failed; null once one succeeds. The last list stays meanwhile. */
  error: string | null;
  loading: boolean;
  /** Rescans the models folder (the server only rereads changed files). */
  refresh: () => Promise<void>;
  /** What deleting the model at `path` removes (files, profiles using it) and why it is refused, if it is. */
  usage: (path: string) => Promise<ModelUsage>;
  /**
   * Deletes the model's files, and the profiles using it when `deleteProfiles` is set, then rescans. Rejects with the
   * endpoint's tagged error (`ModelNotFound`, `ModelInUse`, `ProfileRunning`).
   */
  deleteModel: (path: string, deleteProfiles: boolean) => Promise<ModelDeleted>;
}

/** The calls the store makes: the web's, or in a test the same calls on a fake `fetch` (`makeCall(Api, fetchImpl)`). */
export interface ModelsCalls {
  readonly call: typeof webCall;
}

/** The models folder's store, making its calls through `calls`. */
export const makeModelsStore = ({ call }: ModelsCalls) =>
  create<ModelsState>((set, get) => ({
    list: null,
    error: null,
    loading: false,
    refresh: async () => {
      if (get().loading) return;
      set({ loading: true });
      using _loading = defer(() => set({ loading: false }));
      try {
        set({ list: await call((api) => api.models.list()), error: null });
      } catch (e) {
        set({ error: errorMessage(e) });
      }
    },
    usage: (path) => call((api) => api.models.usage({ query: { path } })),
    deleteModel: async (path, deleteProfiles) => {
      const deleted = await call((api) => api.models.remove({ payload: { path, deleteProfiles } }));
      await get().refresh();
      return deleted;
    },
  }));

export const useModels = makeModelsStore({ call: webCall });

export const readable = (e: ModelEntry): e is { ok: true } & ModelSummary => e.ok;

const QUANT = /^(b?f\d+|q\d\w*|iq\d\w*|mxfp\d+)$/i;

/** Base name of a projector: “mmproj-Qwen3.8-27B-BF16” → “qwen3.8-27b”. */
function projectorBase(path: string): string {
  const parts = stem(path)
    .replace(/^mmproj[-_.]?/i, '')
    .replace(/[-_.]?mmproj$/i, '')
    .split('-');
  if (parts.length > 1 && QUANT.test(parts.at(-1)!)) parts.pop();
  return parts.join('-').toLowerCase();
}

/** The projector in the same folder whose name matches the model, if there is exactly one. */
export function matchingProjector(modelPath: string, models: ReadonlyArray<ModelEntry>): string | null {
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

debugStore('models', useModels);
