import { expect, test } from 'vitest';
import { formFromSpec, specFromForm } from './bench';

test('a -ts without -dev survives the form', () => {
  const form = formFromSpec({
    modelPath: '/m/a.gguf',
    mmprojPath: null,
    profileId: null,
    params: { ts: [57, 50] },
    serverArgs: [],
  });
  const built = specFromForm(form);
  expect('spec' in built && built.spec.params).toEqual({ ts: [57, 50] });
});

test("a llama-bench run keeps the profile's projector", () => {
  const form = formFromSpec({
    kind: 'bench',
    modelPath: '/m/a.gguf',
    mmprojPath: '/m/mmproj.gguf',
    profileId: null,
    params: {},
    serverArgs: [],
  });
  const built = specFromForm(form);
  expect('spec' in built && built.spec.mmprojPath).toBe('/m/mmproj.gguf');
});
