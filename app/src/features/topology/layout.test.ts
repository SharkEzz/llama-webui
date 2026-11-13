import type { TopologyGraph, TopologyLink, TopologyNode } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import { CLEARANCE, fitCamera, layoutGraph, pathPoint, peerPath, project } from './layout';

const node = (id: string, kind: TopologyNode['kind'], busId?: string): TopologyNode => ({
  id,
  kind,
  label: id,
  busId,
  detail: {},
});
const link = (from: string, to: string, kind: TopologyLink['kind'] = 'pcie'): TopologyLink => ({
  id: `${from}-${to}`,
  from,
  to,
  kind,
  genMax: null,
  widthMax: null,
  genCur: null,
  widthCur: null,
});

/** The reference machine: NVMe and two GPUs on the CPU, a chipset with one GPU behind it. */
const graph: TopologyGraph = {
  at: 0,
  nodes: [
    node('cpu', 'cpu'),
    node('ram', 'ram'),
    node('pci:0000:01:00.0', 'gpu', '0000:01:00.0'),
    node('pci:0000:02:00.0', 'nvme', '0000:02:00.0'),
    node('pci:0000:03:00.0', 'gpu', '0000:03:00.0'),
    node('chipset:0000:04:00.0', 'chipset', '0000:04:00.0'),
    node('pci:0000:08:00.0', 'gpu', '0000:08:00.0'),
  ],
  links: [
    link('cpu', 'ram', 'memory'),
    link('cpu', 'pci:0000:01:00.0'),
    link('cpu', 'pci:0000:02:00.0'),
    link('cpu', 'pci:0000:03:00.0'),
    link('cpu', 'chipset:0000:04:00.0'),
    link('chipset:0000:04:00.0', 'pci:0000:08:00.0'),
  ],
};

const overlap = (a: { pos: number[]; size: number[] }, b: { pos: number[]; size: number[] }) =>
  Math.abs(a.pos[0]! - b.pos[0]!) < (a.size[0]! + b.size[0]!) / 2 &&
  Math.abs(a.pos[2]! - b.pos[2]!) < (a.size[2]! + b.size[2]!) / 2;

test('layoutGraph: every node is placed, none overlap on the ground plane', () => {
  const l = layoutGraph(graph);
  expect([...l.nodes.keys()].sort()).toEqual(graph.nodes.map((n) => n.id).sort());
  const placed = [...l.nodes.values()];
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i]!, placed[j]!)).toBe(false);
});

test('layoutGraph: CPU at the origin, RAM behind it, root-port devices in a row in front, chipset devices further', () => {
  const l = layoutGraph(graph);
  const at = (id: string) => l.nodes.get(id)!.pos;
  expect(at('cpu')).toEqual([0, 0, 0]);
  expect(at('ram')[2]).toBeLessThan(0);
  const row = ['pci:0000:01:00.0', 'pci:0000:02:00.0', 'pci:0000:03:00.0', 'chipset:0000:04:00.0'].map(at);
  for (const p of row) expect(p[2]).toBeGreaterThan(0);
  expect(new Set(row.map((p) => p[2])).size).toBe(1); // same row
  // GPUs first, then the NVMe, the chipset last (rightmost).
  const xs = row.map((p) => p[0]);
  expect(xs[3]).toBe(Math.max(...xs));
  expect(at('pci:0000:03:00.0')[0]).toBeLessThan(at('pci:0000:02:00.0')[0]);
  // Behind the chipset: further from the CPU, horizontally close to it.
  const radeon = at('pci:0000:08:00.0');
  expect(radeon[2]).toBeGreaterThan(at('chipset:0000:04:00.0')[2]);
  expect(Math.abs(radeon[0] - at('chipset:0000:04:00.0')[0])).toBeLessThan(2);
  // The row's extent is centred on the CPU.
  const ids = ['pci:0000:01:00.0', 'pci:0000:02:00.0', 'pci:0000:03:00.0', 'chipset:0000:04:00.0'];
  const edges = ids.map((id) => l.nodes.get(id)!).flatMap((p) => [p.pos[0] - p.size[0] / 2, p.pos[0] + p.size[0] / 2]);
  expect(Math.abs(Math.min(...edges) + Math.max(...edges))).toBeLessThan(1e-9);
});

test('layoutGraph: bounds cover every node; fitCamera looks at the middle from above and in front', () => {
  const l = layoutGraph(graph);
  for (const n of l.nodes.values()) {
    expect(n.pos[0] - n.size[0] / 2).toBeGreaterThanOrEqual(l.bounds.minX);
    expect(n.pos[0] + n.size[0] / 2).toBeLessThanOrEqual(l.bounds.maxX);
    expect(n.pos[2] - n.size[2] / 2).toBeGreaterThanOrEqual(l.bounds.minZ);
    expect(n.pos[2] + n.size[2] / 2).toBeLessThanOrEqual(l.bounds.maxZ);
  }
  const wide = fitCamera(l.bounds, 2.4);
  const narrow = fitCamera(l.bounds, 1);
  expect(wide.target[2]).toBeGreaterThan(l.bounds.minZ);
  expect(wide.target[2]).toBeLessThan(l.bounds.maxZ);
  expect(wide.position[1]).toBeGreaterThan(0);
  expect(wide.position[2]).toBeGreaterThan(l.bounds.maxZ);
  // A narrower frame needs a camera further away to fit the same width.
  const dist = (c: { position: number[]; target: number[] }) =>
    Math.hypot(c.position[0]! - c.target[0]!, c.position[1]! - c.target[1]!, c.position[2]! - c.target[2]!);
  expect(dist(narrow)).toBeGreaterThan(dist(wide));
  // Every block corner (and the label space above it) lands inside the free part of the frame, roughly centred.
  for (const [cam, aspect] of [
    [wide, 2.4],
    [narrow, 1],
  ] as const) {
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let widest = 0;
    for (const n of l.nodes.values()) {
      for (const x of [n.pos[0] - n.size[0] / 2, n.pos[0] + n.size[0] / 2])
        for (const z of [n.pos[2] - n.size[2] / 2, n.pos[2] + n.size[2] / 2])
          for (const y of [0, CLEARANCE]) {
            const [px, py] = project([x, y, z], cam.position, cam.target, aspect);
            // The scene takes most of the frame: only the top corners (cards) and the bottom bar are kept clear.
            expect(Math.abs(px)).toBeLessThanOrEqual(0.9);
            expect(Math.abs(py)).toBeLessThanOrEqual(0.86);
            widest = Math.max(widest, Math.abs(px), Math.abs(py));
            minY = Math.min(minY, py);
            maxY = Math.max(maxY, py);
          }
    }
    expect(Math.abs(minY + maxY)).toBeLessThan(0.05);
    // ... and it does use that room: the tightest axis is filled.
    expect(widest).toBeGreaterThan(0.8);
  }
});

test('layoutGraph: one path per link, from a facing side to the other, arcing above both ends', () => {
  const l = layoutGraph(graph);
  expect([...l.paths.keys()].sort()).toEqual(graph.links.map((x) => x.id).sort());
  for (const x of graph.links) {
    const path = l.paths.get(x.id)!;
    const from = l.nodes.get(x.from)!;
    const to = l.nodes.get(x.to)!;
    // Each end sits on its block's footprint edge, at mid-height.
    for (const [end, block] of [
      [path.start, from],
      [path.end, to],
    ] as const) {
      const dx = Math.abs(end[0] - block.pos[0]) / (block.size[0] / 2);
      const dz = Math.abs(end[2] - block.pos[2]) / (block.size[2] / 2);
      expect(Math.max(dx, dz)).toBeCloseTo(1, 6);
      expect(end[1]).toBeCloseTo(block.size[1] / 2, 6);
    }
    expect(pathPoint(path, 0)).toEqual(path.start);
    expect(pathPoint(path, 1)).toEqual(path.end);
    expect(pathPoint(path, 0.5)[1]).toBeGreaterThan(Math.max(path.start[1], path.end[1]));
  }
});

test('layoutGraph: CPU and RAM alone (sysfs unreadable) still lay out', () => {
  const l = layoutGraph({ at: 0, nodes: graph.nodes.slice(0, 2), links: graph.links.slice(0, 1) });
  expect(l.nodes.size).toBe(2);
  expect(l.bounds.maxX).toBeGreaterThan(l.bounds.minX);
});

test('peerPath: joins two blocks of a row by their front faces, passing in front of whatever sits between them', () => {
  const l = layoutGraph(graph);
  const a = l.nodes.get('pci:0000:01:00.0')!;
  const b = l.nodes.get('pci:0000:03:00.0')!;
  const path = peerPath(a, b);
  expect(path.start).toEqual([a.pos[0], a.size[1] / 2, a.pos[2] + a.size[2] / 2]);
  expect(path.end).toEqual([b.pos[0], b.size[1] / 2, b.pos[2] + b.size[2] / 2]);
  // Every point of the curve stays in front of the row: it never crosses a block.
  const front = Math.max(a.pos[2] + a.size[2] / 2, b.pos[2] + b.size[2] / 2);
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) expect(pathPoint(path, t)[2]).toBeGreaterThan(front);
  // ... and close to it: the camera's framing does not have to change when the link appears.
  expect(pathPoint(path, 0.5)[2] - front).toBeLessThan(1);
});
