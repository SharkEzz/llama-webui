import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Listens on a free loopback port; the server's base URL (`http://127.0.0.1:<port>`). */
export async function listen(server: Server): Promise<string> {
  await once(server.listen(0, '127.0.0.1'), 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
