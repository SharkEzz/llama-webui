import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import type { HostEnv, WebHandler } from '../host';

/** A server that answers every request with `web` alone, as the host does for a path outside `/api` and `/ws`. */
export function webServer(web: WebHandler): Server {
  return createServer(getRequestListener(new Hono<HostEnv>().all('*', web).fetch, { overrideGlobalObjects: false }));
}
