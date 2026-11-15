import { expect, test } from 'vitest';
import { withoutTrailingSlash } from './paths.ts';

test('withoutTrailingSlash removes every trailing slash, and leaves nothing of the root', () => {
  expect(withoutTrailingSlash('/models')).toBe('/models');
  expect(withoutTrailingSlash('/models/')).toBe('/models');
  expect(withoutTrailingSlash('/models//')).toBe('/models');
  expect(withoutTrailingSlash('https://huggingface.co/')).toBe('https://huggingface.co');
  // What goes before the `/` of a join: `/` + `/x` would double the slash.
  expect(withoutTrailingSlash('/')).toBe('');
  expect(withoutTrailingSlash('')).toBe('');
});
