import { expect, test } from 'bun:test';
import { profileModelPath } from './models';

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
  expect(profileModelPath(abs, { cwd: '/autre', modelsDir: '~/Modèles', home: '/h' })).toEqual({
    cwd: '/autre',
    model: abs,
  });
});
