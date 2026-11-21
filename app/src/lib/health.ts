import { create } from 'zustand';
import { getHealth, type Health } from './api';

interface HealthState {
  health?: Health;
  /** Date.now() when the response arrived, to advance the uptime locally. */
  fetchedAt?: number;
  error?: string;
  refresh(): Promise<void>;
}

export const useHealth = create<HealthState>()((set) => ({
  async refresh() {
    try {
      const health = await getHealth();
      set({ health, fetchedAt: Date.now(), error: undefined });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
