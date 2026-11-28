/**
 * Generates the static OpenAPI 3.1 specification (`openapi.json`) and offline Scalar reference page (`scalar.html`)
 * in `site/public/` from the shared Effect `HttpApi` contract. Run automatically before `site/` dev and build.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpRouter } from 'effect/http';
import { HttpApiScalar } from 'effect/http-api';
import { annotatedApi, openApiSpec, SCALAR_CONFIG } from '../server/http/OpenApiDocs.ts';

const ROOT_PKG = resolve(import.meta.dirname, '../../package.json');
const DEFAULT_OUT = resolve(import.meta.dirname, '../../site/public');
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export const SITE_SERVERS = [
  { url: 'http://127.0.0.1:7860', description: 'Default local llama-webui server' },
] as const;

function packageVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(ROOT_PKG, 'utf8'));
  const version: unknown = typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, 'version') : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`siteOpenApi: missing version in ${ROOT_PKG}`);
  }
  return version;
}

export interface SiteOpenApiSummary {
  readonly version: string;
  readonly paths: number;
  readonly operations: number;
}

/** Writes `openapi.json` and offline `scalar.html` into `outDir`. */
export async function generateSiteOpenApi(outDir: string): Promise<SiteOpenApiSummary> {
  const version = packageVersion();
  const options = { version, servers: SITE_SERVERS };
  const api = annotatedApi(options);
  const spec = openApiSpec(options);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'openapi.json'), `${JSON.stringify(spec, null, 2)}\n`);

  const { handler, dispose } = HttpRouter.toWebHandler(
    HttpApiScalar.layer(api, {
      path: '/docs',
      scalar: {
        ...SCALAR_CONFIG,
        darkMode: true,
        hideDarkModeToggle: true,
      },
    }),
    { disableLogger: true },
  );
  try {
    const res = await handler(new Request('http://local/docs'));
    if (res.status !== 200) throw new Error(`siteOpenApi: Scalar render returned HTTP ${res.status}`);
    writeFileSync(join(outDir, 'scalar.html'), await res.text());
  } finally {
    await dispose();
  }

  const paths = Object.values(spec.paths);
  const operations = paths.reduce(
    (sum, item) => sum + Object.keys(item).filter((method) => HTTP_METHODS.has(method)).length,
    0,
  );
  return { version, paths: paths.length, operations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const summary = await generateSiteOpenApi(DEFAULT_OUT);
  console.log(
    `siteOpenApi: wrote openapi.json and scalar.html (${summary.paths} paths, ${summary.operations} operations, v${summary.version})`,
  );
}
