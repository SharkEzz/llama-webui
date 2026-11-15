import { call } from './api';

export const getSetup = () => call((api) => api.setup.setup());
export const getLaunchpad = () => call((api) => api.setup.launchpad());
