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
/** Buffers du projecteur multimodal (mmproj, clip.cpp) : pas le modèle, et estimés avant même son chargement. */
const MMPROJ = /^(?:clip\w*|(?:reserve|alloc)_compute_meta):/;

/** Une ligne qui peut changer le placement : évite de relire tout le ring à chaque lot de logs de requêtes. */
export const RELEVANT = /lancement:|using device|buffer size =|offloaded \d+\/\d+ layers/;

/**
 * Placement du modèle principal issu du dernier lancement présent dans `lines` ; null sans ligne de lancement (ring
 * vidé ou évincé). llama-server charge le modèle principal (poids, cache KV, compute), puis le draft éventuel (-md),
 * puis le mmproj : le second « offloaded N/M layers » ouvre le draft et clôt la lecture.
 */
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
      if (layers) break;
      layers = { offloaded: Number(m[1]), total: Number(m[2]) };
      continue;
    }
    m = BUFFER.exec(body);
    if (!m || MMPROJ.test(body)) continue;
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

/** Dernier placement lu, avec le PID du serveur qui l'a écrit. */
export interface PlacementMemory {
  last: { pid: number; placement: ModelPlacement } | null;
}

const g = globalThis as { __llamaWebuiPlacement?: PlacementMemory };
/** Survit à `bun --hot`, comme le ring : un rechargement après l'éviction du lancement garde le placement connu. */
g.__llamaWebuiPlacement ??= { last: null };
const sharedMemory = g.__llamaWebuiPlacement;

export interface PlacementTrackerDeps {
  logs: LogBuffer;
  supervisor: { readonly state: ServerState; subscribe(fn: (s: ServerState) => void): () => void };
  memory?: PlacementMemory;
}

/**
 * Suit le placement du serveur géré. Recréé à chaque rechargement de Bun : il rejoue le ring (qui, lui, survit). Le
 * ring ne garde que les dernières lignes : une fois le lancement évincé (logs de requêtes, -lv 4), le dernier placement
 * lu reste valable tant que le serveur suivi a le même PID. Un serveur externe n'écrit rien dans le ring : son
 * placement est inconnu même si le ring garde un ancien lancement.
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

  private placement(): ModelPlacement | null {
    const state = this.deps.supervisor.state;
    const memory = this.deps.memory ?? sharedMemory;
    // Seuls starting, ready et stopping suivent un serveur géré (idle, crashed : aucun ; external : pas de logs).
    if (state.kind !== 'starting' && state.kind !== 'ready' && state.kind !== 'stopping') {
      memory.last = null;
      return null;
    }
    const parsed = parsePlacement(this.deps.logs.since(0));
    if (parsed) {
      memory.last = { pid: state.pid, placement: parsed };
      return parsed;
    }
    return memory.last?.pid === state.pid ? memory.last.placement : null;
  }

  private recompute(): void {
    const next = this.placement();
    const s = JSON.stringify(next);
    if (s === this.serialized) return;
    this.serialized = s;
    this._current = next;
    for (const fn of this.listeners) fn(next);
  }
}
