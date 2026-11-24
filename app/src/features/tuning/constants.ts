import type { SweepStatus } from '@llama-webui/shared';

export const SWEEP_STATUS: Record<SweepStatus, { label: string; variant: 'secondary' | 'outline' | 'destructive' }> = {
  running: { label: 'running', variant: 'secondary' },
  done: { label: 'done', variant: 'outline' },
  cancelled: { label: 'cancelled', variant: 'secondary' },
  interrupted: { label: 'interrupted', variant: 'destructive' },
};
