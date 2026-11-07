import { z } from 'zod';

// Hugging Face downloads: types shared by the server (HF client, download queue) and the UI.

/** A Hugging Face model repository id: `org/name` (each part starts and ends with a word character, as on the Hub). */
const SEGMENT = String.raw`\w(?:[\w.-]*\w)?`;
export const HF_REPO_RE = new RegExp(`^${SEGMENT}/${SEGMENT}$`);
const HF_HOSTS = new Set(['huggingface.co', 'www.huggingface.co', 'hf.co']);
/** First path segments that are not an `org` (site pages, other repo types). */
const NOT_ORG = new Set(['models', 'datasets', 'spaces', 'docs', 'blog', 'collections', 'papers', 'settings', 'api']);

export type HfInput =
  | { kind: 'empty' }
  | { kind: 'query'; q: string }
  /** `file`: path inside the repo (blob/resolve URL); `quant`: `org/repo:Q4_K_M` (llama.cpp `-hf` syntax). */
  | { kind: 'repo'; repo: string; file: string | null; quant: string | null };

/** What the user typed in the download search box: a repo id, a Hugging Face URL, or a free search. */
export function parseHfInput(raw: string): HfInput {
  const s = raw.trim();
  if (!s) return { kind: 'empty' };
  const url = /^(https?:\/\/)?((www\.)?huggingface\.co|hf\.co)\//i.test(s)
    ? URL.parse(/^https?:\/\//i.test(s) ? s : `https://${s}`)
    : null;
  if (url && HF_HOSTS.has(url.hostname.toLowerCase())) {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [org, name, kind, _rev, ...rest] = parts;
    if (org && name && !NOT_ORG.has(org) && HF_REPO_RE.test(`${org}/${name}`)) {
      const file = (kind === 'blob' || kind === 'resolve') && rest.length > 0 ? rest.join('/') : null;
      return { kind: 'repo', repo: `${org}/${name}`, file, quant: null };
    }
    return { kind: 'query', q: s };
  }
  const [repo, quant, ...extra] = s.split(':');
  if (repo && HF_REPO_RE.test(repo) && extra.length === 0 && (quant === undefined || /^[\w.-]+$/.test(quant)))
    return { kind: 'repo', repo, file: null, quant: quant ?? null };
  return { kind: 'query', q: s };
}

/** How the Hugging Face token was found: `HF_TOKEN`, the file written by `hf auth login`, or none. */
export type HfTokenSource = 'env' | 'file' | null;

export interface HfStatus {
  token: HfTokenSource;
  /** Account name of the token (`whoami`); null without a token or when it could not be checked. */
  user: string | null;
  /** The token was rejected by Hugging Face (401). */
  tokenInvalid: boolean;
  /** Hugging Face endpoint (`HF_ENDPOINT`, default https://huggingface.co). */
  endpoint: string;
}

export interface HfSearchHit {
  id: string;
  downloads: number;
  likes: number;
  /** ISO date. */
  lastModified: string | null;
  gated: boolean;
}

export interface HfFile {
  /** Path inside the repository. */
  path: string;
  size: number;
  /** LFS sha256; null for a non-LFS file (no check). */
  sha256: string | null;
}

/** Local state of a variant: none of its files, some of them (or a `.part`), all of them with the right size. */
export type HfPresence = 'none' | 'partial' | 'complete';

/** A downloadable GGUF: one file, or all the shards of a split model. */
export interface HfVariant {
  /** Path of its first file: identifies the variant in the repo. */
  key: string;
  /** File name without folder, shard suffix or extension. */
  name: string;
  /** Quantization read from the name (Q4_K_M, UD-Q4_K_XL, BF16…), null if none. */
  quant: string | null;
  kind: 'model' | 'mmproj';
  files: HfFile[];
  totalBytes: number;
  present: HfPresence;
  /** Queued or downloading. */
  queued: boolean;
}

export interface HfRepo {
  id: string;
  /** Commit the files were listed at: downloads are pinned to it. */
  sha: string;
  gated: boolean;
  /** Repository page (license, model card). */
  url: string;
  /** Local folder of the downloads (`<modelsDir>/<org>/<name>`). */
  dir: string;
  /** Models, smallest first. */
  variants: HfVariant[];
  /** Multimodal projectors (mmproj), smallest first. */
  projectors: HfVariant[];
}

export type DownloadStatus = 'queued' | 'downloading' | 'done' | 'error' | 'canceled';

export interface DownloadFile extends HfFile {
  done: boolean;
}

export interface DownloadItem {
  id: number;
  repo: string;
  revision: string;
  /** Key of the variant in the repo (see HfVariant.key). */
  key: string;
  name: string;
  quant: string | null;
  kind: 'model' | 'mmproj';
  /** Absolute destination folder (the repo's folder at the time it was queued). */
  dir: string;
  /** Files to download (those already present were left out when it was queued). */
  files: DownloadFile[];
  status: DownloadStatus;
  /** Bytes of the finished files (live progress: DownloadLive). */
  bytesDone: number;
  totalBytes: number;
  error: string | null;
  /** Machine-readable reason of an error (`hf-gated`, `checksum-mismatch`, `disk-full`…). */
  code: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/** Live progress of the running download. */
export interface DownloadLive {
  id: number;
  phase: 'downloading' | 'verifying' | 'retrying';
  /** File being downloaded (path in the repo). */
  file: string;
  bytesDone: number;
  totalBytes: number;
  /** Smoothed throughput, bytes/s. */
  bps: number;
  /** `retrying`: when the next attempt starts (epoch ms). */
  retryAt: number | null;
}

export const isDownloadActive = (s: DownloadStatus) => s === 'queued' || s === 'downloading';

export const DownloadRequestSchema = z.strictObject({
  repo: z.string().regex(HF_REPO_RE, 'Repository id expected (org/name)'),
  revision: z.string().regex(/^[0-9a-f]{40}$/, 'Commit sha expected'),
  /** Keys of the variants to download (HfVariant.key). */
  keys: z.array(z.string().min(1).max(1024)).min(1).max(16),
});
export type DownloadRequest = z.infer<typeof DownloadRequestSchema>;

export type VramFit = 'fits' | 'tight' | 'offload';

/**
 * Rough idea of whether the weights fit in VRAM (the KV cache and compute buffers come on top): up to 85% fits,
 * up to 100% is tight, beyond that part of the model stays in RAM. Null without a GPU.
 */
export function vramFit(bytes: number, vramBytes: number): VramFit | null {
  if (!(vramBytes > 0)) return null;
  const ratio = bytes / vramBytes;
  return ratio <= 0.85 ? 'fits' : ratio <= 1 ? 'tight' : 'offload';
}
