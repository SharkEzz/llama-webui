import type { LaunchpadEntry, SetupReport } from '@llama-webui/shared';
import { api } from './api';

export const getSetup = () => api<SetupReport>('/setup');
export const getLaunchpad = () => api<LaunchpadEntry[]>('/launchpad');
