import { api } from './api';

export const getSetup = () => api('GET /api/setup');
export const getLaunchpad = () => api('GET /api/launchpad');
