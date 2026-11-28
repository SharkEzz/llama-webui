import { assert, describe, it, layer } from '@effect/vitest';
import { Array as Arr, Effect, FileSystem, Layer, Path, Record as Rec } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { ServerTest } from '../testing/http.ts';
import { PUBLIC, PublicTest } from '../testing/public.ts';
import { ServicesTest } from '../testing/services.ts';
import { ApiRoutes, serve } from './HttpLive.ts';
import { acceptedEncodings, layerFrom } from './Static.ts';

const TestApp = serve(Layer.merge(ApiRoutes, PublicTest)).pipe(
  Layer.provide(ServicesTest),
  Layer.provideMerge(ServerTest),
);

layer(TestApp)('Static', (it) => {
  it.effect('pages are revalidated, hashed assets are immutable, the API sets no cache header', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      for (const path of ['/', '/chat/12', '/index.html']) {
        const page = yield* client.get(path);
        assert.strictEqual(page.status, 200, path);
        assert.strictEqual(page.headers['cache-control'], 'no-cache', path);
        assert.match(page.headers['content-type'] ?? '', /^text\/html/, path);
        const text = yield* page.text;
        assert.strictEqual(text, PUBLIC['index.html'], path);
      }
      const asset = yield* client.get('/assets/a-1234.js');
      assert.strictEqual(asset.status, 200);
      assert.match(asset.headers['cache-control'] ?? '', /immutable/);
      const health = yield* client.get('/api/health');
      assert.strictEqual(health.status, 200);
      assert.isUndefined(health.headers['cache-control']);
    }),
  );

  it.effect('a missing asset is a 404, not the page', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get('/assets/gone-9999.js');
      assert.strictEqual(res.status, 404);
      const text = yield* res.text;
      assert.notInclude(text, '<!doctype html>');
    }),
  );

  it.effect('a file of the root is served as itself', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get('/favicon.svg');
      assert.strictEqual(res.status, 200);
      assert.match(res.headers['content-type'] ?? '', /^image\/svg\+xml/);
      assert.strictEqual(res.headers['cache-control'], 'no-cache');
      const text = yield* res.text;
      assert.strictEqual(text, PUBLIC['favicon.svg']);
    }),
  );
});

describe('acceptedEncodings', () => {
  const names = (header: string | undefined) => Arr.map(acceptedEncodings(header), (encoding) => encoding.name);

  it('takes the codings a client accepts, the highest q first, a tie in the server order (#105)', () => {
    assert.deepStrictEqual(names('gzip, deflate, br, zstd'), ['br', 'gzip']);
    assert.deepStrictEqual(names('gzip'), ['gzip']);
    assert.deepStrictEqual(names('BR;Q=0.5, gzip;q=0.8'), ['gzip', 'br']);
    assert.deepStrictEqual(names(' br ; q=1 , gzip;q=1'), ['br', 'gzip']);
  });

  it('refuses q=0 and a q that is not a number, reads * for what it does not name, none without a header (#105)', () => {
    assert.deepStrictEqual(names('br;q=0, gzip'), ['gzip']);
    assert.deepStrictEqual(names('br;q=x, gzip;q='), []);
    assert.deepStrictEqual(names('*'), ['br', 'gzip']);
    assert.deepStrictEqual(names('*;q=0.1, br;q=0'), ['gzip']);
    assert.deepStrictEqual(names('*;q=0'), []);
    assert.deepStrictEqual(names('identity'), []);
    assert.deepStrictEqual(names(''), []);
    assert.deepStrictEqual(names(undefined), []);
  });
});

/**
 * Assets as the build leaves them, their variants standing for themselves (the server sends the files as they are):
 * a script with both, a style with its gzip only, a font, which the build never compresses, next to a stray `.br`.
 */
const ENCODED = {
  'index.html': '<!doctype html>',
  'assets/b-1.js': 'console.log("identity");',
  'assets/b-1.js.br': 'BR',
  'assets/b-1.js.gz': 'GZ',
  'assets/c-2.css': 'body{}',
  'assets/c-2.css.gz': 'GZ',
  'assets/f-3.woff2': 'FONT',
  'assets/f-3.woff2.br': 'BR',
};

const EncodedPublic = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-encoded-' });
    yield* fs.makeDirectory(path.join(root, 'assets'));
    for (const [name, text] of Rec.toEntries(ENCODED)) yield* fs.writeFileString(path.join(root, name), text);
    return layerFrom(root);
  }),
);

const EncodedApp = serve(EncodedPublic).pipe(Layer.provideMerge(ServerTest));

layer(EncodedApp)('Static, precompressed assets', (it) => {
  const get = Effect.fnUntraced(function* (path: string, headers: Readonly<Record<string, string>>) {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.execute(HttpClientRequest.get(path).pipe(HttpClientRequest.setHeaders(headers)));
    const text = yield* res.text;
    return { res, text };
  });

  it.effect('the variant a client accepts goes out with the type of its file, immutable, varying (#105)', () =>
    Effect.gen(function* () {
      for (const [encoding, body, coding] of [
        ['gzip, deflate, br, zstd', 'BR', 'br'],
        ['gzip', 'GZ', 'gzip'],
        ['br;q=0, gzip', 'GZ', 'gzip'],
      ] as const) {
        const { res, text } = yield* get('/assets/b-1.js', { 'accept-encoding': encoding });
        assert.strictEqual(res.status, 200, encoding);
        assert.strictEqual(text, body, encoding);
        assert.strictEqual(res.headers['content-encoding'], coding, encoding);
        assert.strictEqual(res.headers['content-type'], 'text/javascript; charset=utf-8', encoding);
        assert.strictEqual(res.headers.vary, 'Accept-Encoding', encoding);
        assert.match(res.headers['cache-control'] ?? '', /immutable/, encoding);
        // A range counts the bytes of the file: the variant offers none.
        assert.isUndefined(res.headers['accept-ranges'], encoding);
      }
      const query = yield* get('/assets/b-1.js?v=2', { 'accept-encoding': 'br' });
      assert.strictEqual(query.text, 'BR');
      // A file without the variant asked for: the next one accepted.
      const style = yield* get('/assets/c-2.css', { 'accept-encoding': 'br, gzip' });
      assert.strictEqual(style.text, 'GZ');
      assert.strictEqual(style.res.headers['content-type'], 'text/css; charset=utf-8');
    }),
  );

  it.effect('the file itself without an accepted variant, for a range, and for a type never compressed (#105)', () =>
    Effect.gen(function* () {
      for (const headers of [{}, { 'accept-encoding': 'identity' }, { 'accept-encoding': '*;q=0' }]) {
        const { res, text } = yield* get('/assets/b-1.js', headers);
        assert.strictEqual(text, 'console.log("identity");');
        assert.isUndefined(res.headers['content-encoding']);
        assert.strictEqual(res.headers.vary, 'Accept-Encoding');
      }
      const css = yield* get('/assets/c-2.css', { 'accept-encoding': 'br' });
      assert.strictEqual(css.text, 'body{}');
      const range = yield* get('/assets/b-1.js', { 'accept-encoding': 'br', range: 'bytes=0-6' });
      assert.strictEqual(range.res.status, 206);
      assert.strictEqual(range.text, 'console');
      assert.isUndefined(range.res.headers['content-encoding']);
      const font = yield* get('/assets/f-3.woff2', { 'accept-encoding': 'br' });
      assert.strictEqual(font.text, 'FONT');
      assert.isUndefined(font.res.headers['content-encoding']);
      assert.isUndefined(font.res.headers.vary);
      const missing = yield* get('/assets/gone-9.js', { 'accept-encoding': 'br' });
      assert.strictEqual(missing.res.status, 404);
    }),
  );
});
