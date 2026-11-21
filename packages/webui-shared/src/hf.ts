import { Array as Arr, Schema, String as Str } from 'effect';
import { dual } from 'effect/Function';
import { ModelKind } from './models.ts';

// Hugging Face downloads: types shared by the server (HF client, download queue) and the UI.

/** A Hugging Face model repository id: `org/name` (each part starts and ends with a word character, as on the Hub). */
const SEGMENT = String.raw`\w(?:[\w.-]*\w)?`;
export const HF_REPO_RE = new RegExp(`^${SEGMENT}/${SEGMENT}$`);
/** A commit of a repository: 40 lowercase hex digits, as the Hub writes its `sha`. */
export const HF_COMMIT_RE = /^[0-9a-f]{40}$/;
const HF_HOSTS = new Set(['huggingface.co', 'www.huggingface.co', 'hf.co']);
/** First path segments that are not an `org` (site pages, other repo types). */
const NOT_ORG = new Set(['models', 'datasets', 'spaces', 'docs', 'blog', 'collections', 'papers', 'settings', 'api']);

export type HfInput =
  | { kind: 'empty' }
  | { kind: 'query'; q: string }
  /** `file`: path inside the repo (blob/resolve URL); `quant`: `org/repo:Q4_K_M` (llama.cpp `-hf` syntax). */
  | { kind: 'repo'; repo: string; file: string | null; quant: string | null };

/** A URL path segment, decoded; kept as typed if its escapes are malformed (`%2`). */
const decodePart = (p: string) => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};

/** A Hugging Face URL, with or without its scheme. */
const HF_URL = /^(https?:\/\/)?((www\.)?huggingface\.co|hf\.co)\//i;
const HAS_SCHEME = /^https?:\/\//i;

/** What the user typed in the download search box: a repo id, a Hugging Face URL, or a free search. */
export function parseHfInput(raw: string): HfInput {
  const s = Str.trim(raw);
  if (Str.isEmpty(s)) return { kind: 'empty' };
  const url = HF_URL.test(s) ? URL.parse(HAS_SCHEME.test(s) ? s : `https://${s}`) : null;
  if (url !== null && HF_HOSTS.has(Str.toLowerCase(url.hostname))) {
    const [org, name, kind, _rev, ...rest] = Arr.map(
      Arr.filter(Str.split(url.pathname, '/'), Str.isNonEmpty),
      decodePart,
    );
    if (org !== undefined && name !== undefined && !NOT_ORG.has(org) && HF_REPO_RE.test(`${org}/${name}`)) {
      const file = (kind === 'blob' || kind === 'resolve') && Arr.isArrayNonEmpty(rest) ? Arr.join(rest, '/') : null;
      return { kind: 'repo', repo: `${org}/${name}`, file, quant: null };
    }
    return { kind: 'query', q: s };
  }
  const [repo, quant, ...extra] = Str.split(s, ':');
  if (HF_REPO_RE.test(repo) && extra.length === 0 && (quant === undefined || /^[\w.-]+$/.test(quant)))
    return { kind: 'repo', repo, file: null, quant: quant ?? null };
  return { kind: 'query', q: s };
}

/** How the Hugging Face token was found: `HF_TOKEN`, the file written by `hf auth login`, or none. */
export const HfTokenSource = Schema.NullOr(Schema.Literals(['env', 'file']));
export type HfTokenSource = typeof HfTokenSource.Type;

export const HfStatus = Schema.Struct({
  token: HfTokenSource,
  /** Account name of the token (`whoami`); null without a token or when it could not be checked. */
  user: Schema.NullOr(Schema.String),
  /** The token was rejected by Hugging Face (401). */
  tokenInvalid: Schema.Boolean,
  /** Hugging Face endpoint (`HF_ENDPOINT`, default https://huggingface.co). */
  endpoint: Schema.String,
});
export type HfStatus = typeof HfStatus.Type;

export const HfSearchHit = Schema.Struct({
  id: Schema.String,
  downloads: Schema.Int,
  likes: Schema.Int,
  /** ISO date. */
  lastModified: Schema.NullOr(Schema.String),
  gated: Schema.Boolean,
});
export type HfSearchHit = typeof HfSearchHit.Type;

export const HfFile = Schema.Struct({
  /** Path inside the repository. */
  path: Schema.String,
  size: Schema.Int,
  /** LFS sha256; null for a non-LFS file (no check). */
  sha256: Schema.NullOr(Schema.String),
});
export type HfFile = typeof HfFile.Type;

/** Local state of a variant: none of its files, some of them (or a `.part`), all of them with the right size. */
export const HfPresence = Schema.Literals(['none', 'partial', 'complete']);
export type HfPresence = typeof HfPresence.Type;

/** A downloadable GGUF: one file, or all the shards of a split model. */
export const HfVariant = Schema.Struct({
  /** Path of its first file: identifies the variant in the repo. */
  key: Schema.String,
  /** File name without folder, shard suffix or extension. */
  name: Schema.String,
  /** Quantization read from the name (Q4_K_M, UD-Q4_K_XL, BF16…), null if none. */
  quant: Schema.NullOr(Schema.String),
  kind: ModelKind,
  files: Schema.Array(HfFile),
  totalBytes: Schema.Int,
  present: HfPresence,
});
export type HfVariant = typeof HfVariant.Type;

export const HfRepo = Schema.Struct({
  id: Schema.String,
  /** Commit the files were listed at: downloads are pinned to it. */
  sha: Schema.String,
  gated: Schema.Boolean,
  /** Repository page (license, model card). */
  url: Schema.String,
  /** Local folder of the downloads (`<modelsDir>/<org>/<name>`). */
  dir: Schema.String,
  /** Models, smallest first. */
  variants: Schema.Array(HfVariant),
  /** Multimodal projectors (mmproj), smallest first. */
  projectors: Schema.Array(HfVariant),
});
export type HfRepo = typeof HfRepo.Type;

export const DownloadStatus = Schema.Literals(['queued', 'downloading', 'done', 'error', 'canceled']);
export type DownloadStatus = typeof DownloadStatus.Type;

export const DownloadFile = Schema.Struct({ ...HfFile.fields, done: Schema.Boolean });
export type DownloadFile = typeof DownloadFile.Type;

/** A download of the queue, as the `downloads` table holds it: no field has an input rule. */
export const DownloadItem = Schema.Struct({
  id: Schema.Int,
  repo: Schema.String,
  revision: Schema.String,
  /** Key of the variant in the repo (see HfVariant.key). */
  key: Schema.String,
  name: Schema.String,
  quant: Schema.NullOr(Schema.String),
  kind: ModelKind,
  /** Absolute destination folder (the repo's folder at the time it was queued). */
  dir: Schema.String,
  /** Files to download (those already present were left out when it was queued). */
  files: Schema.Array(DownloadFile),
  status: DownloadStatus,
  /** Bytes of the finished files (live progress: DownloadLive). */
  bytesDone: Schema.Int,
  totalBytes: Schema.Int,
  error: Schema.NullOr(Schema.String),
  /** Machine-readable reason of an error (`hf-gated`, `checksum-mismatch`, `disk-full`…), any string stored. */
  code: Schema.NullOr(Schema.String),
  createdAt: Schema.Int,
  finishedAt: Schema.NullOr(Schema.Int),
});
export type DownloadItem = typeof DownloadItem.Type;

/** Live progress of the running download. */
export const DownloadLive = Schema.Struct({
  id: Schema.Int,
  phase: Schema.Literals(['downloading', 'verifying', 'retrying']),
  /** File being downloaded (path in the repo). */
  file: Schema.String,
  bytesDone: Schema.Int,
  totalBytes: Schema.Int,
  /** Smoothed throughput, bytes/s. */
  bps: Schema.Finite,
  /** `retrying`: when the next attempt starts (epoch ms). */
  retryAt: Schema.NullOr(Schema.Int),
});
export type DownloadLive = typeof DownloadLive.Type;

/** The queue (`GET /api/downloads`): every item, and the live progress of the running one. */
export const DownloadList = Schema.Struct({ items: Schema.Array(DownloadItem), live: Schema.NullOr(DownloadLive) });
export type DownloadList = typeof DownloadList.Type;

export const isDownloadActive = (s: DownloadStatus) => s === 'queued' || s === 'downloading';

/** A request to download variants of a repository, pinned to a commit (`POST /api/downloads`). */
export const DownloadRequest = Schema.Struct({
  repo: Schema.String.check(Schema.isPattern(HF_REPO_RE, { message: 'Repository id expected (org/name)' })),
  revision: Schema.String.check(Schema.isPattern(HF_COMMIT_RE, { message: 'Commit sha expected' })),
  /** Keys of the variants to download (HfVariant.key). */
  keys: Schema.Array(
    Schema.String.check(
      Schema.isMinLength(1, { message: 'Variant key expected' }),
      Schema.isMaxLength(1024, { message: '1024 characters at most' }),
    ),
  ).check(
    Schema.isMinLength(1, { message: 'At least one variant expected' }),
    Schema.isMaxLength(16, { message: '16 variants at most' }),
  ),
}).annotate({ messageUnexpectedKey: 'unknown key' });
export type DownloadRequest = typeof DownloadRequest.Type;

export type VramFit = 'fits' | 'tight' | 'offload';

/**
 * Rough idea of whether the weights fit in VRAM (the KV cache and compute buffers come on top): up to 85% fits,
 * up to 100% is tight, beyond that part of the model stays in RAM. Null without a GPU.
 */
export const vramFit: {
  (vramBytes: number): (bytes: number) => VramFit | null;
  (bytes: number, vramBytes: number): VramFit | null;
} = dual(2, (bytes: number, vramBytes: number): VramFit | null => {
  if (!(vramBytes > 0)) return null;
  const ratio = bytes / vramBytes;
  return ratio <= 0.85 ? 'fits' : ratio <= 1 ? 'tight' : 'offload';
});
