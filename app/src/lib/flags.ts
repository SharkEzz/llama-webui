import { catalogFrom, type FlagCatalog } from '@llama-webui/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { call } from './api';

interface FlagsStore {
  catalog: FlagCatalog | null;
  /** Why there is no catalogue: the message of `FlagsUnavailable` (`llama-server --help failed (<binary>)`), or of the call. */
  error?: string;
  loading: boolean;
}

const useFlagsStore = create<FlagsStore>()(() => ({ catalog: null, loading: false }));

/** Flag catalog of the configured llama-server (read once, via `llama-server --help` on the server). */
export function useFlags(): FlagsStore {
  const s = useFlagsStore();
  useEffect(() => {
    const st = useFlagsStore.getState();
    if (st.catalog || st.loading || st.error) return;
    useFlagsStore.setState({ loading: true });
    call((api) => api.flags.get()).then(
      (r) => {
        const flags = r.flags.map((f) => ({ ...f, names: [...f.names] }));
        useFlagsStore.setState({ catalog: catalogFrom(flags), loading: false });
      },
      (e: unknown) => useFlagsStore.setState({ error: e instanceof Error ? e.message : String(e), loading: false }),
    );
  }, []);
  return s;
}
