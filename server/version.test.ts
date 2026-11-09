import { expect, test } from 'bun:test';
import { APP_VERSION } from './version';

test('APP_VERSION: dev when running from source', () => {
  expect(APP_VERSION).toBe('dev');
});
