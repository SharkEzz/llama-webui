// A schema checked by a route's body() and again by the code behind it: the second parse must not change the value.
import { ProfileInputSchema } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import type { z } from 'zod';

const twice = <S extends z.ZodType>(schema: S, input: unknown) => {
  const once = schema.parse(input);
  expect(schema.parse(once)).toEqual(once);
};

test('ProfileInputSchema: parsed by POST /api/profiles, then by ProfilesRepo.create', () => {
  twice(ProfileInputSchema, { name: 'A', model: '/m/a.gguf' });
  twice(ProfileInputSchema, { name: 'B', model: '/m/b.gguf', args: ['-c', '4096'], env: { K: 'v' }, port: 8081 });
});
