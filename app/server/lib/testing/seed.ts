import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from '../db/open';
import { ProfilesRepo } from '../db/profiles';
import { SettingsRepo } from '../db/settings';
import { writeGguf } from '../models/gguf.fixture';
import { freePort } from './launch';

export const FAKE_SERVER = resolve(import.meta.dirname, '../../../../testdata/fake/fake-llama-server');

/** Seeds `dataDir`: settings that run the fake llama-server, one profile on a tiny GGUF. */
export async function seedDataDir(dataDir: string): Promise<{ profileId: number }> {
  const models = join(dataDir, 'models');
  mkdirSync(models, { recursive: true });
  const model = join(models, 'm.gguf');
  await writeGguf(
    model,
    { 'general.architecture': { type: 'string', value: 'llama' }, 'llama.block_count': { type: 'u32', value: 1 } },
    [{ name: 'token_embd.weight', shape: [8, 4], bytes: 128 }],
  );
  using db = openDb(join(dataDir, 'llama-webui.sqlite'));
  new SettingsRepo(db).patch({ binary: FAKE_SERVER, modelsDir: models, port: await freePort() });
  return { profileId: new ProfilesRepo(db).create({ name: 'fake', model, args: [], env: {} }).id };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts llama-server for `profileId` and waits for it to be ready: its pid. */
export async function startLlama(base: string, profileId: number): Promise<number> {
  const res = await fetch(`${base}/api/server/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileId }),
  });
  if (res.status !== 202) throw new Error(`POST /api/server/start: ${res.status} ${await res.text()}`);
  for (let i = 0; i < 100; i++) {
    const { state } = (await (await fetch(`${base}/api/server/state`)).json()) as {
      state: { kind: string; pid?: number };
    };
    if (state.kind === 'ready' && state.pid) return state.pid;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('llama-server not ready within 10 s');
}

/** The boot id the server's WebSocket greets with (`hello`). */
export async function bootId(base: string): Promise<string> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  try {
    const event = await new Promise<MessageEvent>((done, fail) => {
      ws.addEventListener('message', done, { once: true });
      ws.addEventListener('error', () => fail(new Error('WebSocket error')), { once: true });
    });
    const msg = JSON.parse(String(event.data)) as { type: string; payload: { bootId: string } };
    if (msg.type !== 'hello') throw new Error(`first message: ${msg.type}`);
    return msg.payload.bootId;
  } finally {
    ws.close();
  }
}
