import type { TopologyGraph, TopologyNode } from '@llama-webui/shared';

export type Vec3 = [number, number, number];

export interface Placed {
  /** Block center (y = 0: resting on the floor). */
  pos: Vec3;
  /** Width (x), height (y), depth (z). */
  size: Vec3;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Layout {
  nodes: Map<string, Placed>;
  bounds: Bounds;
}

export const FOV_DEG = 32;
/** Share of the frame the scene may use: the HUD cards hold the corners (≈ 20% wide, 35% tall). */
const FIT_X = 0.6;
const FIT_Y = 0.74;
/** Height to keep clear above the blocks (labels). */
const CLEARANCE = 1.3;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Normalized coordinates (-1..1) of a point seen by a camera at `pos` looking at `target`. */
export function project(p: Vec3, pos: Vec3, target: Vec3, aspect: number): [number, number] {
  const f = norm(sub(target, pos));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const v = sub(p, pos);
  const z = Math.max(1e-6, dot(v, f));
  const tanH = Math.tan((FOV_DEG * Math.PI) / 360);
  return [dot(v, r) / (z * tanH * aspect), dot(v, u) / (z * tanH)];
}

const corners = (b: Bounds): Vec3[] =>
  [b.minX, b.maxX].flatMap((x) => [b.minZ, b.maxZ].flatMap((z) => [[x, 0, z] as Vec3, [x, CLEARANCE, z] as Vec3]));

/**
 * Fixed camera in a downward 3/4 view, pulled back until the scene's box (and the label space) fits in the share of the
 * frame left free by the HUD cards, then centered vertically. Recomputed when the frame's aspect ratio
 * changes.
 */
export function fitCamera(b: Bounds, aspect: number, elevationDeg = 50): { position: Vec3; target: Vec3 } {
  const el = (elevationDeg * Math.PI) / 180;
  const dir: Vec3 = [0, Math.sin(el), Math.cos(el)];
  const pts = corners(b);
  let target: Vec3 = [(b.minX + b.maxX) / 2, CLEARANCE / 2, (b.minZ + b.maxZ) / 2];
  let d = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 1.5 + 4;
  let position: Vec3 = target;
  for (let i = 0; i < 6; i++) {
    position = [target[0] + dir[0] * d, target[1] + dir[1] * d, target[2] + dir[2] * d];
    let maxX = 0;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of pts) {
      const [x, y] = project(p, position, target, aspect);
      maxX = Math.max(maxX, Math.abs(x));
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const ratio = Math.max(maxX / FIT_X, (maxY - minY) / (2 * FIT_Y));
    // Recenter vertically: shift the target along the camera's “up”, at the target's depth.
    const mid = (maxY + minY) / 2;
    const tanH = Math.tan((FOV_DEG * Math.PI) / 360);
    const f = norm(sub(target, position));
    const u = cross(norm(cross(f, [0, 1, 0])), f);
    const shift = mid * d * tanH;
    target = [target[0] + u[0] * shift, target[1] + u[1] * shift, target[2] + u[2] * shift];
    d *= ratio;
    if (Math.abs(ratio - 1) < 0.01 && Math.abs(mid) < 0.01) break;
  }
  position = [target[0] + dir[0] * d, target[1] + dir[1] * d, target[2] + dir[2] * d];
  return { position, target };
}

/** Footprint per component kind (scene units; the CPU is ~2.2). */
export const SIZE: Record<TopologyNode['kind'], Vec3> = {
  cpu: [2.2, 0.45, 2.2],
  ram: [3.6, 0.35, 0.9],
  gpu: [2.6, 0.5, 1.5],
  nvme: [1.6, 0.3, 0.9],
  chipset: [1.4, 0.35, 1.4],
};

const GAP = 1;
const RAM_Z = -3.2;
const ROW_Z = 3.4;
const ROW_STEP = 2.8;
const KIND_ORDER: Record<TopologyNode['kind'], number> = { gpu: 0, nvme: 1, chipset: 2, cpu: 3, ram: 3 };

/** Lays out a row of nodes side by side, centered on `cx`, and returns their total width. */
function row(nodes: TopologyNode[], cx: number, z: number, out: Map<string, Placed>) {
  const total = nodes.reduce((s, n) => s + SIZE[n.kind][0], 0) + GAP * Math.max(0, nodes.length - 1);
  let x = cx - total / 2;
  for (const n of nodes) {
    const size = SIZE[n.kind];
    out.set(n.id, { pos: [x + size[0] / 2, 0, z], size });
    x += size[0] + GAP;
  }
  return total;
}

const byKindThenBus = (a: TopologyNode, b: TopologyNode) =>
  KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.busId ?? a.id).localeCompare(b.busId ?? b.id);

/**
 * Deterministic layout: CPU at the origin, memory behind, root-port devices in a row in front (GPUs, then NVMe, then
 * chipset on the right), each chipset's devices one row further, centered under it.
 */
export function layoutGraph(graph: TopologyGraph): Layout {
  const nodes = new Map<string, Placed>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = (parent: string) =>
    graph.links
      .filter((l) => l.from === parent && l.kind !== 'memory')
      .map((l) => byId.get(l.to))
      .filter((n): n is TopologyNode => n !== undefined)
      .sort(byKindThenBus);

  for (const n of graph.nodes) {
    if (n.kind === 'cpu') nodes.set(n.id, { pos: [0, 0, 0], size: SIZE.cpu });
    if (n.kind === 'ram') nodes.set(n.id, { pos: [0, 0, RAM_Z], size: SIZE.ram });
  }
  const front = children('cpu');
  row(front, 0, ROW_Z, nodes);

  // Devices behind a chipset: one row further, centered under it; several chipsets spread out on either side without
  // overlapping (rare: the next row is shifted to the right when needed).
  let nextFree = Number.NEGATIVE_INFINITY;
  for (const c of front.filter((n) => n.kind === 'chipset')) {
    const kids = children(c.id);
    if (kids.length === 0) continue;
    const cx = nodes.get(c.id)!.pos[0];
    const width = kids.reduce((s, n) => s + SIZE[n.kind][0], 0) + GAP * (kids.length - 1);
    const start = Math.max(cx, nextFree + width / 2 + GAP);
    row(kids, start, ROW_Z + ROW_STEP, nodes);
    nextFree = start + width / 2;
  }
  // An unlinked node (inconsistent graph): placed at the end of the row so it stays visible.
  for (const n of graph.nodes) {
    if (nodes.has(n.id)) continue;
    const maxX = Math.max(...[...nodes.values()].map((p) => p.pos[0] + p.size[0] / 2), 0);
    nodes.set(n.id, { pos: [maxX + GAP + SIZE[n.kind][0] / 2, 0, ROW_Z], size: SIZE[n.kind] });
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const p of nodes.values()) {
    minX = Math.min(minX, p.pos[0] - p.size[0] / 2);
    maxX = Math.max(maxX, p.pos[0] + p.size[0] / 2);
    minZ = Math.min(minZ, p.pos[2] - p.size[2] / 2);
    maxZ = Math.max(maxZ, p.pos[2] + p.size[2] / 2);
  }
  return { nodes, bounds: { minX, maxX, minZ, maxZ } };
}
