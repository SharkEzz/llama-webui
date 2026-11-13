import { call, client } from './api';

export const getSetup = () => call(client.setup.$get());
export const getLaunchpad = () => call(client.launchpad.$get());
