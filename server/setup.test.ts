import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchRun, Estimate, ModelEntry, Profile } from '@llama-webui/shared';
import { buildLaunchpad, buildSetupReport, readPerfParanoid, type SetupDeps } from './setup';
import { tempDir } from './testing/tempDir';
import { fakeModel } from './tuning/fixtures';

const entry = (path: string, kind: 'model' | 'mmproj', fileBytes: number): ModelEntry =>
  ({ ok: true, path, relPath: path, files: [path], fileBytes, kind, name: path, quant: 'Q4_K_M' }) as ModelEntry;

function deps(o: Partial<SetupDeps> & { root: string }): SetupDeps {
  return {
    settings: { binary: 'llama-server', modelsDir: '~/models' },
    modelsDir: join(o.root, 'models'),
    resolveBinary: async () => null,
    buildOf: async () => 'b1 (abc)',
    benchBinary: (b) => b.replace('llama-server', 'llama-bench'),
    listDevices: async () => [],
    scanModels: async () => [],
    nvidiaSource: 'nvml',
    readPerfParanoid: async () => 2,
    listen: { host: '127.0.0.1', exposed: false },
    ...o,
  };
}

test('setup: binary not found and models folder missing → not ready', async () => {
  using dir = tempDir('lw-setup-');
  const r = await buildSetupReport(deps({ root: dir.path }));
  expect(r.binary).toEqual({ setting: 'llama-server', path: null, version: null });
  expect(r.models).toMatchObject({ exists: false, count: 0, bytes: 0 });
  expect(r.bench.path).toBe('llama-bench');
  expect(r.ready).toBe(false);
});

test('setup: an executable binary and an empty folder → ready, 0 models', async () => {
  using dir = tempDir('lw-setup-');
  const bin = join(dir.path, 'llama-server');
  await Bun.write(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o755);
  mkdirSync(join(dir.path, 'models'));
  const r = await buildSetupReport(deps({ root: dir.path, resolveBinary: async () => bin }));
  expect(r.binary).toEqual({ setting: 'llama-server', path: bin, version: 'b1 (abc)' });
  expect(r.models).toMatchObject({ exists: true, count: 0, bytes: 0 });
  expect(r.ready).toBe(true);
});

test('setup: a non-executable file or a directory is not a binary', async () => {
  using dir = tempDir('lw-setup-');
  const file = join(dir.path, 'llama-server');
  await Bun.write(file, 'x');
  chmodSync(file, 0o644);
  expect((await buildSetupReport(deps({ root: dir.path, resolveBinary: async () => file }))).binary.path).toBeNull();
  expect(
    (await buildSetupReport(deps({ root: dir.path, resolveBinary: async () => dir.path }))).binary.path,
  ).toBeNull();
});

test('setup: counts readable models only (projectors and unreadable files left out)', async () => {
  using dir = tempDir('lw-setup-');
  mkdirSync(join(dir.path, 'models'));
  const r = await buildSetupReport(
    deps({
      root: dir.path,
      scanModels: async () => [
        entry('/m/a.gguf', 'model', 100),
        entry('/m/b.gguf', 'model', 50),
        entry('/m/mmproj.gguf', 'mmproj', 10),
        { ok: false, path: '/m/bad.gguf', relPath: 'bad.gguf', files: [], fileBytes: 7, error: 'bad magic' },
      ],
    }),
  );
  expect(r.models).toMatchObject({ count: 2, bytes: 150 });
});

test('readPerfParanoid: parsed value, null when unreadable', async () => {
  using dir = tempDir('lw-setup-');
  const p = join(dir.path, 'paranoid');
  await Bun.write(p, '-1\n');
  expect(await readPerfParanoid(p)).toBe(-1);
  expect(await readPerfParanoid(join(dir.path, 'missing'))).toBeNull();
});

const profile = (id: number, model: string, args: string[] = []): Profile => ({
  id,
  name: `p${id}`,
  model,
  args,
  env: {},
  source: 'ui',
  createdAt: 0,
  updatedAt: 0,
});

test('launchpad: model, last bench and fit per profile; an unreadable model only sets modelError', async () => {
  const seen: { ctx?: number; pinned: unknown }[] = [];
  const entries = await buildLaunchpad(
    [profile(1, '/m/a.gguf', ['-ngl', '99', '-c', '8192']), profile(2, '/m/gone.gguf')],
    {
      paths: (p) => ({ model: p.model, mmproj: null }),
      loadModel: async (path) => {
        if (path === '/m/gone.gguf') throw new Error('Model not found');
        return { ...fakeModel(), name: 'A', quant: 'Q8_0' };
      },
      mmprojBytes: async () => 0,
      estimate: async (input) => {
        seen.push({ ctx: input.ctx, pinned: input.pinned });
        return {
          fit: { verdict: 'tight', reason: 'little VRAM left', vram: [{ bytes: 10 }, { bytes: 5 }], ramBytes: 3 },
        } as Estimate;
      },
      lastBench: new Map([[1, { pp: { tps: 900 }, tg: null, createdAt: 42 } as BenchRun]]),
    },
  );
  expect(entries[0]).toMatchObject({
    profileId: 1,
    modelPath: '/m/a.gguf',
    model: { name: 'A', quant: 'Q8_0' },
    modelError: null,
    lastBench: { ppTps: 900, tgTps: null, at: 42 },
    fit: { verdict: 'tight', reason: 'little VRAM left', vramBytes: 15, ramBytes: 3 },
  });
  expect(seen).toEqual([{ ctx: 8192, pinned: { ngl: 99 } }]);
  expect(entries[1]).toEqual({
    profileId: 2,
    name: 'p2',
    modelPath: '/m/gone.gguf',
    model: null,
    modelError: 'Model not found',
    lastBench: null,
    fit: null,
  });
});

test('launchpad: a failing estimate drops the fit badge only', async () => {
  const [e] = await buildLaunchpad([profile(1, '/m/a.gguf')], {
    paths: (p) => ({ model: p.model, mmproj: null }),
    loadModel: async () => fakeModel(),
    mmprojBytes: async () => 0,
    estimate: async () => {
      throw new Error('no hardware');
    },
    lastBench: new Map(),
  });
  expect(e).toMatchObject({ modelError: null, fit: null });
  expect(e!.model).not.toBeNull();
});
