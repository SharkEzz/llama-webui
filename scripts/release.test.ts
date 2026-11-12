import { expect, test } from 'vitest';
import { parseVersion, readVersions, withVersion } from './release';

test('every package.json has the same version (bun run release <version>)', async () => {
  const versions = Object.values(await readVersions());
  expect(versions.every((v) => v !== null)).toBe(true);
  expect(new Set(versions).size).toBe(1);
});

test('parseVersion: with or without v, semantic versions only', () => {
  expect(parseVersion('v0.2.0')).toBe('0.2.0');
  expect(parseVersion('1.10.3')).toBe('1.10.3');
  expect(parseVersion('v1.0.0-rc.1')).toBe('1.0.0-rc.1');
  expect(parseVersion('v1.2')).toBeNull();
  expect(parseVersion('master')).toBeNull();
});

test('withVersion: replaces it in place, or adds it after name; other keys keep their order', () => {
  const before = { name: 'a', version: '0.0.0', private: true, scripts: { x: 'y' } };
  expect(withVersion(JSON.stringify(before), '0.2.0')).toBe(
    `${JSON.stringify({ name: 'a', version: '0.2.0', private: true, scripts: { x: 'y' } }, null, 2)}\n`,
  );
  const missing = { name: 'b', private: true };
  expect(Object.keys(JSON.parse(withVersion(JSON.stringify(missing), '1.0.0')))).toEqual([
    'name',
    'version',
    'private',
  ]);
});
