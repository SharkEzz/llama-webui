import { Exit, Option, Schema } from 'effect';
import { expect, test } from 'vitest';
import { issuesOf } from './api/errors.ts';
import { ModelDelete, profileModelPath } from './models.ts';
import { STRICT } from './profile.ts';

test('profileModelPath fills an empty cwd with models_dir and keeps paths relative under the cwd', () => {
  const abs = '/h/Modèles/q/a.gguf';
  expect(profileModelPath(abs, { modelsDir: '~/Modèles', home: '/h' })).toEqual({
    cwd: '~/Modèles',
    model: 'q/a.gguf',
  });
  expect(profileModelPath(abs, { cwd: '~/Modèles/q', modelsDir: '~/Modèles', home: '/h' })).toEqual({
    cwd: '~/Modèles/q',
    model: 'a.gguf',
  });
  expect(profileModelPath(abs, { cwd: '/other', modelsDir: '~/Modèles', home: '/h' })).toEqual({
    cwd: '/other',
    model: abs,
  });
});

test('ModelDelete defaults deleteProfiles to false and refuses an empty path with path required', () => {
  const decode = Schema.decodeUnknownExit(ModelDelete, STRICT);
  expect(decode({ path: '/m/a.gguf' })).toEqual(Exit.succeed({ path: '/m/a.gguf', deleteProfiles: false }));
  expect(decode({ path: '/m/a.gguf', deleteProfiles: true })).toEqual(
    Exit.succeed({ path: '/m/a.gguf', deleteProfiles: true }),
  );
  const refused = (input: unknown) => Option.map(Exit.findErrorOption(decode(input)), (error) => issuesOf(error.issue));
  expect(refused({ path: '' })).toEqual(Option.some([{ path: ['path'], message: 'path required' }]));
  expect(refused({ path: '/m/a.gguf', force: true })).toEqual(
    Option.some([{ path: ['force'], message: 'unknown key' }]),
  );
});
