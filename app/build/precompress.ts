/**
 * The precompressed copies of the hashed assets (`build/server.ts`, after Vite): next to each text asset of more than
 * 1 KiB, `<file>.br` (Brotli, quality 11) and `<file>.gz` (gzip, level 9), each kept only when it is smaller than the
 * file. The server sends one of them to a client that accepts it (`app/server/http/Static.ts`), so the files are
 * compressed once, at the best level, rather than at each request.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

/**
 * The extensions compressed: text. A font (`.woff2`) or an image is compressed already; the types the server sends
 * these with are `ENCODED_TYPES` of `app/server/http/Static.ts`.
 */
export const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.svg', '.json', '.html', '.txt', '.xml', '.wasm']);

/** Below this size a file is sent as it is: the saving does not pay for the variant. */
export const MIN_SIZE = 1024;

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

/** One encoding of a file: its suffix and how to compute it. */
const ENCODINGS = [
  {
    suffix: '.br',
    encode: (data: Buffer) =>
      brotli(data, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        },
      }),
  },
  { suffix: '.gz', encode: (data: Buffer) => gzipped(data, { level: constants.Z_BEST_COMPRESSION }) },
] as const;

/**
 * What `precompress` did: the files compressed, the paths of the variants written, and the bytes of those files as
 * they are, in Brotli and in gzip (a variant not kept counts as the file).
 */
export interface Precompressed {
  readonly files: number;
  readonly written: string[];
  readonly bytes: number;
  readonly br: number;
  readonly gz: number;
}

/** Writes the `.br` and `.gz` of each compressible file of `dir` (not its subfolders) that gains from it. */
export async function precompress(dir: string): Promise<Precompressed> {
  const files = readdirSync(dir).filter(
    (name) => COMPRESSIBLE.has(extname(name)) && statSync(join(dir, name)).size > MIN_SIZE,
  );
  const result = { files: files.length, written: [] as string[], bytes: 0, br: 0, gz: 0 };
  await Promise.all(
    files.map(async (name) => {
      const file = join(dir, name);
      const data = readFileSync(file);
      result.bytes += data.length;
      for (const { suffix, encode } of ENCODINGS) {
        const encoded = await encode(data);
        const kept = encoded.length < data.length;
        if (kept) {
          writeFileSync(file + suffix, encoded);
          result.written.push(file + suffix);
        }
        result[suffix === '.br' ? 'br' : 'gz'] += kept ? encoded.length : data.length;
      }
    }),
  );
  result.written.sort();
  return result;
}
