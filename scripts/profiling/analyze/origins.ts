// A call frame → the module, function and group it belongs to: the server bundle by its per-module comments, the
// client chunks by the build's source maps.
import { existsSync, readFileSync } from 'node:fs';
import { SourceMap, type SourceMapPayload } from 'node:module';
import { dirname, join } from 'node:path';
import { arr, isRecord, parseJson, str } from '../json.ts';
import type { CallFrame, Origin } from './cpuprofile.ts';

const PSEUDO = /^\((idle|program|garbage collector|root)\)$/;

// ---------------------------------------------------------------- package names

const PNPM_MODULE = /node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)$/;
const pkgOf = (module: string): string | null => PNPM_MODULE.exec(module)?.[1] ?? null;
const pkgPath = (module: string): string => PNPM_MODULE.exec(module)?.[2] ?? module;
const short = (module: string): string => {
  const pkg = pkgOf(module);
  return pkg === null ? module : `${pkg}/${pkgPath(module).replace(/^dist\//, '')}`;
};

function effectFamily(path: string): string {
  const f = path.replace(/^dist\//, '').replace(/^src\//, '');
  if (/^(Schema|internal\/schema)/.test(f)) return 'effect: Schema';
  if (
    /^(internal\/effect|internal\/core|Effect|Fiber|Scheduler|Exit|Cause|internal\/fiber|Scope|Layer|Context|ServiceMap|Deferred|Latch|Semaphore)/.test(
      f,
    )
  )
    return 'effect: runtime (fibers)';
  if (/^(Stream|Channel|Pull|Queue|PubSub|Sink|Take|internal\/stream|internal\/channel|Schedule)/.test(f))
    return 'effect: streams, queues, schedules';
  if (/^unstable\/(http|httpapi)/.test(f)) return 'effect: HTTP';
  if (/^unstable\/(process|socket|encoding|sql)/.test(f)) return 'effect: platform';
  if (/^(Metric|Tracer|Logger|References|internal\/tracer|internal\/metric)/.test(f))
    return 'effect: metrics, traces, logs';
  return 'effect: other';
}

// ---------------------------------------------------------------- server bundle: line → module

/** The bundle's `// <module path>` comments: the module each line belongs to. */
function moduleTable(file: string): { line: number; module: string }[] {
  const table: { line: number; module: string }[] = [];
  if (!existsSync(file)) return table;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    const m = /^\/\/ ((?:\.\.\/)*(?:node_modules|packages|server|bin)\/\S+\.(?:ts|js|mjs|cjs))$/.exec(text);
    if (m?.[1] !== undefined) table.push({ line: i, module: m[1].replace(/^(\.\.\/)+/, '') });
  });
  return table;
}

function moduleAt(table: { line: number; module: string }[], line: number): string {
  let lo = 0;
  let hi = table.length - 1;
  let found: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = table[mid];
    if (entry === undefined) break;
    if (entry.line <= line) {
      found = entry.module;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found ?? '(bundle prelude)';
}

/** Origins of the server's frames (and the NVML sampler's, `nvml-worker.mjs` next to the bundle). */
export function serverOrigins(bundlePath: string): (frame: CallFrame) => Origin {
  const tables = new Map<string, { line: number; module: string }[]>();
  const tableOf = (file: string) => {
    let t = tables.get(file);
    if (!t) {
      t = moduleTable(file);
      tables.set(file, t);
    }
    return t;
  };
  const worker = join(dirname(bundlePath), 'nvml-worker.mjs');
  return (frame) => {
    const { url, functionName, lineNumber } = frame;
    const fn = functionName || '(anonymous)';
    const line = lineNumber + 1;
    if (!url) {
      if (PSEUDO.test(functionName)) return { fn, module: '', line: 0, group: functionName };
      return { fn, module: '(native)', line: 0, group: 'V8 / native' };
    }
    if (url.startsWith('node:')) return { fn, module: url, line, group: 'Node (internals)' };
    if (url.endsWith('index.mjs') || url.endsWith('nvml-worker.mjs')) {
      const module = moduleAt(tableOf(url.endsWith('index.mjs') ? bundlePath : worker), lineNumber);
      const pkg = pkgOf(module);
      if (pkg === 'effect') return { fn, module: short(module), line, group: effectFamily(pkgPath(module)) };
      if (pkg?.startsWith('@effect/') === true) return { fn, module: short(module), line, group: 'effect: platform' };
      if (pkg !== null) return { fn, module: short(module), line, group: `lib: ${pkg}` };
      if (module.startsWith('packages/webui-shared')) return { fn, module, line, group: 'app: shared schemas' };
      if (module.startsWith('packages/llamacpp-js')) return { fn, module, line, group: 'app: llamacpp-js' };
      const d = /^server\/([^/]+)\//.exec(module)?.[1];
      return { fn, module, line, group: d === undefined ? 'app: root' : `app: ${d}` };
    }
    return { fn, module: url, line, group: 'other' };
  };
}

// ---------------------------------------------------------------- client: source maps

interface Mapped {
  map: SourceMap;
  sources: string[];
  contents: (string | null)[];
}

function readPayload(file: string): SourceMapPayload | null {
  const json = parseJson(readFileSync(file, 'utf8'));
  if (!isRecord(json) || typeof json.mappings !== 'string') return null;
  const sources = arr(json.sources).map((s) => str(s));
  return {
    file: str(json.file),
    version: typeof json.version === 'number' ? json.version : 3,
    sources,
    sourcesContent: arr(json.sourcesContent).map((c) => (typeof c === 'string' ? c : '')),
    names: arr(json.names).map((n) => str(n)),
    mappings: json.mappings,
    sourceRoot: str(json.sourceRoot),
  };
}

/** The name a source line declares, for a frame whose minified name says nothing. */
function nameIn(lineText: string, fallback: string): string {
  const m =
    /function\*?\s+([\w$]+)/.exec(lineText) ??
    /(?:const|let|var)\s+([\w$]+)\s*=/.exec(lineText) ??
    /([\w$]+)\s*[:=]\s*(?:async\s+)?(?:\(|function|[\w$]+\s*=>)/.exec(lineText) ??
    /^\s*(?:export\s+)?(?:async\s+|static\s+|get\s+|set\s+)*([\w$]+)\s*\(/.exec(lineText);
  return m?.[1] ?? fallback;
}

const MARKDOWN =
  /^(react-markdown|remark-|micromark|mdast-|hast-|unified$|vfile|unist-|property-information|decode-named|character-|comma-separated|space-separated|html-url-attributes|trim-lines|bail|devlop|ccount|markdown-table|longest-streak|zwitch|estree-|style-to-|inline-style|escape-string)/;

/** The module and group of a client source path. */
export function clientGroup(source: string): { module: string; group: string } {
  let clean = source.replace(/^(\.\.\/)+/, '');
  if (!/^(node_modules|src|packages)\//.test(clean))
    clean = clean.replace(/^.*?\/(?=node_modules\/|src\/|packages\/)/, '');
  const pkg = pkgOf(clean);
  if (pkg !== null) {
    const module = `${pkg}/${pkgPath(clean).replace(/^dist\//, '')}`;
    if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') return { module, group: 'react' };
    if (pkg === 'effect') return { module, group: effectFamily(pkgPath(clean)) };
    if (MARKDOWN.test(pkg)) return { module, group: 'markdown (react-markdown, micromark…)' };
    if (/shiki|oniguruma/.test(pkg)) return { module, group: 'shiki' };
    if (/^three$|^@react-three|^three-|^troika|^meshline|^maath|^camera-controls/.test(pkg))
      return { module, group: 'three.js / r3f' };
    return { module, group: `lib: ${pkg}` };
  }
  if (clean.startsWith('packages/webui-shared')) return { module: clean, group: 'app: shared schemas' };
  const m = /^src\/(features|components)\/([^/]+)\//.exec(clean);
  if (m?.[1] !== undefined && m[2] !== undefined) return { module: clean, group: `app: ${m[1]}/${m[2]}` };
  const top = /^src\/([^/]+)\//.exec(clean)?.[1];
  if (top !== undefined) return { module: clean, group: `app: ${top}` };
  return { module: clean || source, group: 'other' };
}

export interface ClientResolver {
  (frame: CallFrame): Origin;
  /** A position in a chunk (0-based line and column) → its origin, or null without a map or a mapping. */
  at: (chunk: string, line: number, column: number, fallbackName: string) => Origin | null;
}

/** Origins of the page's frames: `null` (no maps, `--no-build`) keeps the minified name and the chunk file. */
export function clientOrigins(sourcemapsDir: string | null): ClientResolver {
  const maps = new Map<string, Mapped | null>();
  const mapOf = (chunk: string): Mapped | null => {
    const cached = maps.get(chunk);
    if (cached !== undefined) return cached;
    let mapped: Mapped | null = null;
    const file = sourcemapsDir === null ? null : join(sourcemapsDir, `${chunk}.map`);
    if (file !== null && existsSync(file)) {
      const payload = readPayload(file);
      if (payload)
        mapped = {
          map: new SourceMap(payload),
          sources: payload.sources,
          contents: payload.sourcesContent,
        };
    }
    maps.set(chunk, mapped);
    return mapped;
  };
  const at = (chunk: string, line: number, column: number, fallbackName: string): Origin | null => {
    const mapped = mapOf(chunk);
    if (!mapped) return null;
    const e = mapped.map.findEntry(line, column);
    // A generated position with no original one gives an entry whose originalSource is undefined.
    if (!('originalSource' in e)) return null;
    const source: unknown = e.originalSource;
    if (typeof source !== 'string') return null;
    const i = mapped.sources.indexOf(source);
    const text = (i >= 0 ? mapped.contents[i] : null)?.split('\n')[e.originalLine] ?? '';
    const g = clientGroup(source);
    return {
      fn: nameIn(text, fallbackName || '(anonymous)'),
      module: g.module,
      line: e.originalLine + 1,
      group: g.group,
    };
  };
  const resolve = (frame: CallFrame): Origin => {
    const { url, functionName, lineNumber, columnNumber } = frame;
    const fn = functionName || '(anonymous)';
    if (!url) {
      if (PSEUDO.test(functionName)) return { fn, module: '', line: 0, group: functionName };
      return { fn, module: '(native)', line: 0, group: 'V8 / native (DOM, JSON…)' };
    }
    const chunk = /\/assets\/([^/?]+\.js)/.exec(url)?.[1];
    if (chunk !== undefined) {
      const o = at(chunk, lineNumber, columnNumber, functionName);
      if (o) return o;
      return {
        fn,
        module: chunk,
        line: lineNumber + 1,
        group: sourcemapsDir === null ? 'unresolved (no source map)' : 'unresolved',
      };
    }
    const instrumentation = url.startsWith('pptr:') || url.includes('__puppeteer');
    return { fn, module: url.slice(0, 80), line: lineNumber + 1, group: instrumentation ? 'instrumentation' : 'other' };
  };
  return Object.assign(resolve, { at });
}
