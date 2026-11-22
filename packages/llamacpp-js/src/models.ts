/**
 * Client and parser for llama-server's `GET /models/sse` real-time event stream (router mode and single-model mode
 * since llama.cpp PR #32398). Uses only `fetch` (injectable for tests), so it runs in Node and browsers.
 */
import type { RequestOptions } from './client.ts';
import { LlamaHttpError, LlamaReplyError, LlamaStreamCutError } from './errors.ts';
import { SseParser } from './sse.ts';

/** Model lifecycle status emitted by `status_change` events on `/models/sse`. */
export type ModelsSseStatus =
  | 'downloading'
  | 'incomplete'
  | 'downloaded'
  | 'unloaded'
  | 'loading'
  | 'loaded'
  | 'sleeping';

const STATUSES: ReadonlySet<string> = new Set<ModelsSseStatus>([
  'downloading',
  'incomplete',
  'downloaded',
  'unloaded',
  'loading',
  'loaded',
  'sleeping',
]);

const isStatus = (v: unknown): v is ModelsSseStatus => typeof v === 'string' && STATUSES.has(v);

/** Loading progress reported by `status_change` (`status: "loading"`). */
export interface ModelLoadProgress {
  /** Ordered stages for this load (e.g. `['text_model', 'spec_model', 'mmproj_model']`); empty if absent. */
  stages: string[];
  /** Currently active stage (e.g. `text_model`, `spec_model`, `mmproj_model`). */
  current: string;
  /** Fraction loaded within `current` in `[0, 1]`, or null when the event only announces a stage. */
  value: number | null;
}

/** One device or host entry of `server_model_memory` in a `loaded` event (sizes in bytes). */
export interface ModelMemoryDevice {
  kind: 'device' | 'host' | 'buffer_type';
  name: string;
  model: number;
  context: number;
  compute: number;
  total?: number;
  free?: number;
}

/** Memory breakdown (`server_model_memory`) included in the first `loaded` event. */
export interface ModelMemory {
  n_ctx: number;
  devices: ModelMemoryDevice[];
}

/** Per-URL download progress (bytes). */
export interface DownloadFileProgress {
  done: number;
  total: number;
}

/** Parsed event from `GET /models/sse`. */
export type ModelsSseEvent =
  | {
      event: 'status_change';
      model: string;
      status: ModelsSseStatus;
      progress?: ModelLoadProgress;
      info?: Record<string, unknown>;
      memory?: ModelMemory;
      exitCode?: number;
    }
  | {
      event: 'download_progress';
      model: string;
      progress: Record<string, DownloadFileProgress>;
    }
  | {
      event: 'download_finished';
      model: string;
    }
  | {
      event: 'download_failed';
      model: string;
      stopped?: boolean;
    }
  | {
      event: 'model_remove';
      model: string;
    }
  | {
      event: 'models_reload';
      model: string;
    };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const finiteNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const MEMORY_KINDS: ReadonlySet<string> = new Set<ModelMemoryDevice['kind']>(['device', 'host', 'buffer_type']);
const isMemoryKind = (v: unknown): v is ModelMemoryDevice['kind'] => typeof v === 'string' && MEMORY_KINDS.has(v);

/** Reads `progress` from a `status_change` (`loading`) event, tolerating both `{ stages, current, value }` and `{ stage }`. */
function readLoadProgress(v: unknown): ModelLoadProgress | undefined {
  if (!isRecord(v)) return undefined;
  const current = typeof v.current === 'string' ? v.current : typeof v.stage === 'string' ? v.stage : undefined;
  if (current === undefined || current === '') return undefined;
  const stages = Array.isArray(v.stages) ? v.stages.filter((s): s is string => typeof s === 'string' && s !== '') : [];
  const rawValue = finiteNumber(v.value);
  return { stages, current, value: rawValue === undefined ? null : clamp01(rawValue) };
}

/** Reads `memory` (`server_model_memory`) from a `status_change` (`loaded`) event. */
function readMemory(v: unknown): ModelMemory | undefined {
  if (!isRecord(v)) return undefined;
  const nCtx = finiteNumber(v.n_ctx);
  if (nCtx === undefined || !Array.isArray(v.devices)) return undefined;
  const devices: ModelMemoryDevice[] = [];
  for (const item of v.devices) {
    if (!isRecord(item)) continue;
    if (!isMemoryKind(item.kind)) continue;
    if (typeof item.name !== 'string' || item.name === '') continue;
    const model = finiteNumber(item.model);
    const context = finiteNumber(item.context);
    const compute = finiteNumber(item.compute);
    if (model === undefined || context === undefined || compute === undefined) continue;
    const device: ModelMemoryDevice = {
      kind: item.kind,
      name: item.name,
      model: Math.max(0, model),
      context: Math.max(0, context),
      compute: Math.max(0, compute),
    };
    const total = finiteNumber(item.total);
    const free = finiteNumber(item.free);
    if (total !== undefined) device.total = Math.max(0, total);
    if (free !== undefined) device.free = Math.max(0, free);
    devices.push(device);
  }
  return { n_ctx: Math.max(0, Math.trunc(nCtx)), devices };
}

/** Reads `{ [url]: { done, total } }` from a `download_progress` event's `data` (nested under `progress` or direct). */
function readDownloadProgress(data: unknown): Record<string, DownloadFileProgress> | undefined {
  if (!isRecord(data)) return undefined;
  const map = isRecord(data.progress) ? data.progress : data;
  const out: Record<string, DownloadFileProgress> = {};
  let count = 0;
  for (const [url, entry] of Object.entries(map)) {
    if (!isRecord(entry)) continue;
    const done = finiteNumber(entry.done);
    const total = finiteNumber(entry.total);
    if (done === undefined || total === undefined) continue;
    out[url] = { done: Math.max(0, done), total: Math.max(0, total) };
    count++;
  }
  return count > 0 ? out : undefined;
}

/**
 * Parses one decoded JSON object from `/models/sse`, field by field. Returns `null` when the object is malformed or
 * names an unrecognized event.
 */
export function parseModelsSseEvent(raw: unknown): ModelsSseEvent | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.event !== 'string' || typeof raw.model !== 'string') return null;
  const { event, model, data } = raw;

  if (event === 'status_change') {
    if (!isRecord(data) || !isStatus(data.status)) return null;
    const out: Extract<ModelsSseEvent, { event: 'status_change' }> = {
      event: 'status_change',
      model,
      status: data.status,
    };
    const progress = readLoadProgress(data.progress);
    if (progress !== undefined) out.progress = progress;
    if (isRecord(data.info)) out.info = data.info;
    const memory = readMemory(data.memory);
    if (memory !== undefined) out.memory = memory;
    const exitCode = finiteNumber(data.exit_code);
    if (exitCode !== undefined) out.exitCode = Math.trunc(exitCode);
    return out;
  }

  if (event === 'download_progress') {
    const progress = readDownloadProgress(data);
    return progress === undefined ? null : { event: 'download_progress', model, progress };
  }

  if (event === 'download_finished') return { event: 'download_finished', model };

  if (event === 'download_failed') {
    const out: Extract<ModelsSseEvent, { event: 'download_failed' }> = { event: 'download_failed', model };
    if (isRecord(data) && typeof data.stopped === 'boolean') out.stopped = data.stopped;
    return out;
  }

  if (event === 'model_remove') return { event: 'model_remove', model };
  if (event === 'models_reload') return { event: 'models_reload', model };

  return null;
}

/**
 * Streams `GET <baseUrl>/models/sse`: yields each recognized event until the server closes the stream (clean EOF) or
 * `signal` aborts it. Throws the `fetch` error when nothing answers, `LlamaHttpError` on a non-2xx status (e.g. 404 or
 * 503 on older builds without single-model `/models/sse`), `LlamaReplyError` when the body is not bytes, and
 * `LlamaStreamCutError` when reading the body fails mid-stream.
 */
export async function* streamModelsSse(
  baseUrl: string,
  o: RequestOptions = {},
): AsyncGenerator<ModelsSseEvent, void, undefined> {
  const res = await (o.fetch ?? fetch)(`${baseUrl}/models/sse`, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!res.ok || !res.body) throw new LlamaHttpError(res.status, await res.text().catch(() => ''));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let ended = false;
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        throw new LlamaStreamCutError('the stream broke', { cause });
      }
      if (chunk.done) {
        ended = true;
        return;
      }
      if (!(chunk.value instanceof Uint8Array)) throw new LlamaReplyError('the stream is not bytes');
      for (const ev of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        let j: unknown;
        try {
          j = JSON.parse(ev.data);
        } catch {
          continue;
        }
        const parsed = parseModelsSseEvent(j);
        if (parsed !== null) yield parsed;
      }
    }
  } finally {
    if (!ended) reader.cancel().catch(() => {});
  }
}
