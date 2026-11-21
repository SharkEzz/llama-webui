import { create } from 'zustand';
import { call, errorMessage } from './api';

/** The reply of `GET /api/health`. */
export type Health = Awaited<ReturnType<typeof getHealth>>;

const getHealth = () => call((api) => api.health.get());

interface HealthState {
  health?: Health;
  /** Date.now() when the response arrived, to advance the uptime locally. */
  fetchedAt?: number;
  error?: string | undefined;
  refresh(): Promise<void>;
}

export const useHealth = create<HealthState>()((set) => ({
  async refresh() {
    try {
      const health = await getHealth();
      set({ health, fetchedAt: Date.now(), error: undefined });
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },
}));
