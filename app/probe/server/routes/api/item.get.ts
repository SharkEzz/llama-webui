import { defineHandler } from 'nitro';

export default defineHandler((event) => ({ method: event.req.method, signal: typeof event.req.signal }));
