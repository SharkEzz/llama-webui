import { expect, test } from 'vitest';
import { isRecord, serverPropsOf } from './props';

test('isRecord: a JSON object only', () => {
  expect(isRecord({ a: 1 })).toBe(true);
  expect(isRecord([])).toBe(false);
  expect(isRecord(null)).toBe(false);
  expect(isRecord('x')).toBe(false);
});

test('serverPropsOf keeps the fields of the right type and drops the others', () => {
  expect(
    serverPropsOf({
      model_path: '/m/a.gguf',
      default_generation_settings: { n_ctx: 4096, params: { temperature: 0.8 } },
      total_slots: 1,
    }),
  ).toEqual({ model_path: '/m/a.gguf', default_generation_settings: { n_ctx: 4096, params: { temperature: 0.8 } } });
  expect(serverPropsOf({ model_path: 3, default_generation_settings: { n_ctx: '4096', params: [] } })).toEqual({
    default_generation_settings: {},
  });
  expect(serverPropsOf(undefined)).toEqual({});
});
