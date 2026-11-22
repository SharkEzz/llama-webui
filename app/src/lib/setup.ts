import { call } from './api';

export const getSetup = () => call((api) => api.setup.setup());
