import { expect, test } from 'bun:test';
import { BenchSpecSchema } from '@llama-webui/shared';
import { BenchRunsRepo } from './benchRuns';
import { openDb } from './open';

test('a run whose profile no longer exists is created without it', () => {
  const repo = new BenchRunsRepo(openDb(':memory:'));
  const run = repo.create(BenchSpecSchema.parse({ kind: 'bench', modelPath: '/m/a.gguf', profileId: 42 }), 'cmd', {
    cpu: '',
    gpus: [],
    build: null,
  });
  expect(run.spec.profileId).toBeNull();
});
