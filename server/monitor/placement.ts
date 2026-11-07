import type { LogLine, ModelPlacement, PlacementBuffer, ServerState } from '@llama-webui/shared';
import type { LogBuffer } from '../logs/buffer';

/*
 * Répartition du modèle chargé entre les devices, lue dans les logs de démarrage de llama-server : « using device CUDA0
 * (…) (0000:01:00.0) », « CUDA0 model buffer size = 12441.95 MiB », « offloaded 49/49 layers to GPU »… llama-server
 * n'expose pas ces chiffres par API. Les lignes sont au niveau INFO : présentes quelle que soit la verbosité (-lv).
 */

const MiB = 1024 ** 2;
const LAUNCH = '[llama-webui] lancement:';
/** Préfixe llama.cpp optionnel (« 0.11.852.017 I »), gardé dans `LogLine.text`. */
const PREFIX = /^(?:\d+\.\d+(?:\.\d+)*\s+[IWEDT]\s+)?/;
const USING = /using device (\S+) \(.*\) \(([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])\)/i;
const LAYERS = /offloaded (\d+)\/(\d+) layers to GPU/;
const BUFFER = /(\S+) (model|KV|compute) buffer size =\s*([\d.]+) MiB/;

/** Une ligne qui peut changer le placement : évite de relire tout le ring à chaque lot de logs de requêtes. */
export const RELEVANT = /lancement:|using device|buffer size =|offloaded \d+\/\d+ layers/;

/** Placement issu du dernier lancement présent dans `lines` ; null sans ligne de lancement (ring vidé ou évincé). */
export function parsePlacement(lines: readonly LogLine[]): ModelPlacement | null {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.text.startsWith(LAUNCH)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const busIds = new Map<string, string>();
  const buffers = new Map<string, PlacementBuffer>();
  let layers: ModelPlacement['layers'] = null;
  for (let i = start + 1; i < lines.length; i++) {
    const body = lines[i]!.text.replace(PREFIX, '');
    let m = USING.exec(body);
    if (m) {
      busIds.set(m[1]!, m[2]!.toLowerCase());
      continue;
    }
    m = LAYERS.exec(body);
    if (m) {
      layers = { offloaded: Number(m[1]), total: Number(m[2]) };
      continue;
    }
    m = BUFFER.exec(body);
    if (!m) continue;
    const device = m[1]!;
    let b = buffers.get(device);
    if (!b) {
      b = { device, busId: null, modelBytes: 0, kvBytes: 0, computeBytes: 0 };
      buffers.set(device, b);
    }
    const bytes = Number(m[3]) * MiB;
    if (m[2] === 'model') b.modelBytes += bytes;
    else if (m[2] === 'KV') b.kvBytes += bytes;
    else b.computeBytes += bytes;
  }
  for (const b of buffers.values()) b.busId = busIds.get(b.device) ?? null;
  return { launchSeq: lines[start]!.seq, layers, buffers: [...buffers.values()] };
}

const NO_PLACEMENT = new Set<ServerState['kind']>(['idle', 'crashed', 'external']);

export interface PlacementTrackerDeps {
  logs: LogBuffer;
  supervisor: { readonly state: ServerState; subscribe(fn: (s: ServerState) => void): () => void };
}

/**
 * Suit le placement du serveur géré. Recréé à chaque rechargement de Bun : il rejoue le ring (qui, lui, survit) et n'a
 * donc aucun état à garder sur globalThis. Un serveur externe n'écrit rien dans le ring : son placement est inconnu
 * même si le ring garde un ancien lancement.
 */
export class PlacementTracker {
  private _current: ModelPlacement | null = null;
  private serialized = 'null';
  private listeners = new Set<(p: ModelPlacement | null) => void>();
  private unsubs: (() => void)[] = [];

  constructor(private readonly deps: PlacementTrackerDeps) {
    this.recompute();
    this.unsubs.push(
      deps.logs.onLines((lines) => {
        if (lines.some((l) => RELEVANT.test(l.text))) this.recompute();
      }),
      deps.supervisor.subscribe(() => this.recompute()),
    );
  }

  get current(): ModelPlacement | null {
    return this._current;
  }

  onChange(fn: (p: ModelPlacement | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.listeners.clear();
  }

  private recompute(): void {
    const next = NO_PLACEMENT.has(this.deps.supervisor.state.kind) ? null : parsePlacement(this.deps.logs.since(0));
    const s = JSON.stringify(next);
    if (s === this.serialized) return;
    this.serialized = s;
    this._current = next;
    for (const fn of this.listeners) fn(next);
  }
}
