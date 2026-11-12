import { catalogFrom, type FlagCatalog } from '@llama-webui/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { ApiError, call, client } from './api';

interface FlagsStore {
  catalog: FlagCatalog | null;
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
    call(client.flags.$get()).then(
      (r) => useFlagsStore.setState({ catalog: catalogFrom(r.flags), loading: false }),
      (e) => useFlagsStore.setState({ error: e instanceof ApiError ? e.message : String(e), loading: false }),
    );
  }, []);
  return s;
}
