import { NodeFileSystem } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { ConfigProvider, Effect, FileSystem } from 'effect';
import { hfEndpoint, hfToken, hfTokenPath, hubHeaders } from './token.ts';

/** `effect` with `env` as the whole environment: the user's token never shows. */
const withEnv =
  (env: Record<string, string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));

/** Asserts that `effect`, with `env` as the whole environment, gives `expected`. */
const gives = <A, E, R>(effect: Effect.Effect<A, E, R>, env: Record<string, string>, expected: A) =>
  effect.pipe(
    withEnv(env),
    Effect.map((got) => assert.deepStrictEqual(got, expected)),
  );

layer(NodeFileSystem.layer)('token', (it) => {
  it.effect('HF_TOKEN first, then the hf token file', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-hf-' });
      yield* fs.makeDirectory(`${dir}/hf`);
      yield* fs.writeFileString(`${dir}/hf/token`, ' hf_file \n');
      const env = { HOME: dir, HF_HOME: `${dir}/hf` };
      const both = { ...env, HF_TOKEN: ' hf_env ', HUGGING_FACE_HUB_TOKEN: 'x' };
      yield* gives(hfToken, both, { token: 'hf_env', source: 'env' });
      yield* gives(hfToken, { ...env, HUGGING_FACE_HUB_TOKEN: 'hf_old' }, { token: 'hf_old', source: 'env' });
      const blank = { ...env, HF_TOKEN: '  ', HUGGING_FACE_HUB_TOKEN: '' };
      yield* gives(hfToken, blank, { token: 'hf_file', source: 'file' });
      yield* gives(hfToken, env, { token: 'hf_file', source: 'file' });
      yield* gives(hfToken, { HOME: dir, HF_HOME: `${dir}/none` }, { token: null, source: null });
    }),
  );

  it.effect('token file location follows the hf CLI', () =>
    Effect.gen(function* () {
      const home = { HOME: '/home/u' };
      yield* gives(hfTokenPath, home, '/home/u/.cache/huggingface/token');
      yield* gives(hfTokenPath, { ...home, XDG_CACHE_HOME: '/c' }, '/c/huggingface/token');
      yield* gives(hfTokenPath, { ...home, XDG_CACHE_HOME: '/c', HF_HOME: '/h/' }, '/h/token');
      yield* gives(hfTokenPath, { ...home, HF_TOKEN_PATH: '/t', HF_HOME: '/h' }, '/t');
    }),
  );

  it.effect('endpoint', () =>
    Effect.gen(function* () {
      yield* gives(hfEndpoint, {}, 'https://huggingface.co');
      yield* gives(hfEndpoint, { HF_ENDPOINT: '  ' }, 'https://huggingface.co');
      yield* gives(hfEndpoint, { HF_ENDPOINT: ' https://mirror.example/ ' }, 'https://mirror.example');
      yield* gives(hfEndpoint, { HF_ENDPOINT: 'https://hub.test///' }, 'https://hub.test');
    }),
  );

  it.effect('the token is read again on every call', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-hf-' });
      const env = { HOME: dir, HF_TOKEN_PATH: `${dir}/token` };
      yield* gives(hfToken, env, { token: null, source: null });
      // `hf auth login` while the app runs.
      yield* fs.writeFileString(`${dir}/token`, 'hf_late\n');
      yield* gives(hfToken, env, { token: 'hf_late', source: 'file' });
    }),
  );

  it.effect('the Hub headers name the app, and carry the token when there is one', () =>
    Effect.sync(() => {
      assert.deepStrictEqual(hubHeaders(null), { 'user-agent': 'llama-webui' });
      assert.deepStrictEqual(hubHeaders('hf_x'), { 'user-agent': 'llama-webui', authorization: 'Bearer hf_x' });
    }),
  );
});
