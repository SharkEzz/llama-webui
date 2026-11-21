import type { AppDeps } from '../deps';
import { HttpError, notFound } from '../http';

export function getSweep({ sweeps }: Pick<AppDeps, 'sweeps'>, id: number) {
  const sw = sweeps.get(id);
  if (!sw) throw notFound('Sweep');
  return sw;
}

export function notRunning(status: string): void {
  if (status === 'running') throw new HttpError(409, 'This sweep is still running: cancel it first');
}
