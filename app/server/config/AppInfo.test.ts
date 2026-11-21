import { assert, layer } from '@effect/vitest';
import { Effect } from 'effect';
import { AppInfo } from './AppInfo.ts';

layer(AppInfo.layer)('AppInfo', (it) => {
  it.effect('version: dev when running from source', () =>
    Effect.gen(function* () {
      const info = yield* AppInfo;
      assert.strictEqual(info.version, 'dev');
    }),
  );
});
