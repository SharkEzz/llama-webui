import type { TopologyGraph, TopologyNode } from '@llama-webui/shared';
import type { PeerLink } from './flows';
import { curve, elbow, join, type Rect, straight } from './geometry';
import { type PeerGeo, placedLinks, treeOf, type ViewLayout } from './tree';

/*
 * The card diagram: rows by depth in the graph. The CPU on top with the memory at its left and an integrated GPU at
 * its right, the devices of the CPU's root ports below, those of a chipset one row further. Sizes in px of the
 * drawing's natural size.
 */

const MARGIN = 30;
/** Between two cards of a row. */
const GAP = 26;
/** Between two rows: the links and their labels live there. */
const ROW_GAP = 96;
/** Between the CPU and the card beside it: the memory link and its label. */
const SIDE_GAP = 140;
const CPU = { w: 300, h: 150, tall: 176 };
/** The memory, and an integrated GPU. */
const SIDE = { w: 250, h: 124 };
const GPU = { min: 216, max: 290, h: 170 };
const SMALL_H = 96;
const WIDTH: Record<'nvme' | 'chipset', number> = { nvme: 210, chipset: 230 };
/** Width of the first row, which the CPU is centered in whatever sits beside it. */
const TOP = SIDE.w + SIDE_GAP + CPU.w + SIDE_GAP + SIDE.w;
/** Threads from which the CPU card takes two rows of tiles. */
export const TALL_THREADS = 16;
/** How far a peer link drops under its two cards, and where its tag sits. */
const PEER_DROP = 26;
/** Under the lowest point of a peer link, where its tag starts: clear of the dots that run along the link. */
const PEER_TAG_GAP = 12;
/** Height of a peer link's tag with its figures (three lines): the room the drawing keeps under it. */
const PEER_TAG_H = 56;
/** How far a tag on one line stands above or below the middle of a link that crosses it sideways. */
const PEER_TAG_RISE = 20;
/** Half the height of a tag on one line. */
const PEER_TAG_HALF = 11;
/** The sideways run from which a link between two rows crosses its middle too flat for a tag at the same height. */
const PEER_FLAT = 10;

const isGpu = (n: TopologyNode) => n.kind === 'gpu';
const fixedWidth = (n: TopologyNode) => (n.kind === 'nvme' ? WIDTH.nvme : n.kind === 'chipset' ? WIDTH.chipset : 0);

/** Widths of a row's cards: GPUs share what the others leave of the base width, within their bounds. */
function rowWidths(nodes: readonly TopologyNode[]): number[] {
  const gpus = nodes.filter(isGpu).length;
  const fixed = nodes.reduce((sum, n) => sum + (isGpu(n) ? 0 : fixedWidth(n) || SIDE.w), 0);
  const room = (TOP - fixed - GAP * (nodes.length - 1)) / Math.max(1, gpus);
  const gpu = Math.round(Math.max(GPU.min, Math.min(GPU.max, room)));
  return nodes.map((n) => (isGpu(n) ? gpu : fixedWidth(n) || SIDE.w));
}
const total = (widths: readonly number[]) => widths.reduce((a, b) => a + b, 0) + GAP * Math.max(0, widths.length - 1);
const rowHeight = (nodes: readonly TopologyNode[]) => (nodes.some(isGpu) ? GPU.h : SMALL_H);

export function layoutCards(graph: TopologyGraph, peers: readonly PeerLink[]): ViewLayout {
  const tree = treeOf(graph);
  const rects = new Map<string, Rect>();
  const threads = Number(tree.cpu?.detail.logicalThreads) || 0;

  const first = [...tree.ports, ...tree.loose];
  const firstWidths = rowWidths(first);
  const groups = tree.ports.flatMap((c) => {
    const nodes = tree.behind.get(c.id) ?? [];
    return nodes.length > 0 ? [{ parent: c.id, nodes, widths: rowWidths(nodes) }] : [];
  });
  const secondWidth = groups.reduce((sum, g) => sum + total(g.widths), 0) + GAP * Math.max(0, groups.length - 1);
  const width = Math.max(TOP, total(firstWidths), secondWidth) + 2 * MARGIN;

  // First row: the CPU in the middle
  const cpu: Rect = { x: (width - CPU.w) / 2, y: 24, w: CPU.w, h: threads > TALL_THREADS ? CPU.tall : CPU.h };
  if (tree.cpu) rects.set(tree.cpu.id, cpu);
  if (tree.ram) rects.set(tree.ram.id, { x: cpu.x - SIDE_GAP - SIDE.w, y: 36, w: SIDE.w, h: SIDE.h });
  for (const [i, n] of tree.integrated.entries())
    rects.set(n.id, { x: cpu.x + cpu.w + SIDE_GAP, y: 36 + i * (SIDE.h + 12), w: SIDE.w, h: SIDE.h });
  const topBottom = Math.max(cpu.y + cpu.h, ...tree.integrated.map((n) => rects.get(n.id)!.y + SIDE.h));

  const place = (nodes: readonly TopologyNode[], widths: readonly number[], x0: number, y: number) => {
    let x = x0;
    for (const [i, n] of nodes.entries()) {
      rects.set(n.id, { x: Math.round(x), y, w: widths[i]!, h: isGpu(n) ? GPU.h : SMALL_H });
      x += widths[i]! + GAP;
    }
  };
  const y1 = topBottom + ROW_GAP;
  place(first, firstWidths, (width - total(firstWidths)) / 2, y1);

  // Second row: each chipset's devices centered under it, pushed aside when two groups would collide
  const y2 = y1 + rowHeight(first) + ROW_GAP;
  const starts: number[] = [];
  let free = MARGIN;
  for (const g of groups) {
    const parent = rects.get(g.parent)!;
    const x = Math.max(free, parent.x + parent.w / 2 - total(g.widths) / 2);
    starts.push(x);
    free = x + total(g.widths) + GAP;
  }
  let limit = width - MARGIN;
  for (let i = groups.length - 1; i >= 0; i--) {
    starts[i] = Math.min(starts[i]!, limit - total(groups[i]!.widths));
    limit = starts[i]! - GAP;
  }
  for (const [i, g] of groups.entries()) place(g.nodes, g.widths, starts[i]!, y2);

  const links = placedLinks(graph, rects, (link, from, to) => {
    if (link.kind === 'memory') {
      const y = from.y + 74;
      return {
        route: straight({ x: from.x, y }, { x: to.x + to.w, y }),
        badge: { x: (from.x + to.x + to.w) / 2, y: 56 },
      };
    }
    if (link.kind === 'internal' && tree.integrated.some((n) => n.id === link.to)) {
      const y = to.y + to.h / 2;
      const start = { x: from.x + from.w, y: Math.max(from.y + 20, Math.min(from.y + from.h - 20, y)) };
      const end = { x: to.x, y };
      const mid = (start.x + end.x) / 2;
      const route = start.y === y ? straight(start, end) : elbow([start, { x: mid, y: start.y }, { x: mid, y }, end]);
      return { route, badge: null };
    }
    const siblings = (tree.cpu?.id === link.from ? tree.ports : (tree.behind.get(link.from) ?? [])).map((n) => n.id);
    const i = siblings.indexOf(link.to);
    if (i < 0) return null;
    // The link drops from its own port under the parent to the bottom of the parent's row (a chipset is shorter than
    // the GPUs beside it), then crosses inside the gap, 40 px above its card
    const px = Math.round(from.x + from.w * (0.2 + (0.6 * (i + 0.5)) / siblings.length));
    const cx = Math.round(to.x + to.w / 2);
    const start = { x: px, y: from.y + from.h };
    const clear = { x: px, y: Math.max(start.y, to.y - ROW_GAP) };
    const end = { x: cx, y: to.y };
    const side = cx < px - 30 ? -1 : cx > px + 30 ? 1 : i < siblings.length / 2 ? -1 : 1;
    const cross = curve(clear, { x: px, y: to.y - 40 }, { x: cx, y: to.y - 40 }, end);
    return {
      route: clear.y > start.y ? join(straight(start, clear), cross) : cross,
      badge: link.kind === 'internal' ? null : { x: (px + cx) / 2 + side * 54, y: to.y - 50 },
    };
  });

  const peerGeos = peers.flatMap((p): PeerGeo[] => {
    const a = rects.get(p.from);
    const b = rects.get(p.to);
    if (!a || !b) return [];
    return [{ id: p.id, confirmed: p.confirmed, ...peerRoute(a, b) }];
  });
  const bottom = Math.max(
    ...[...rects.values()].map((r) => r.y + r.h),
    ...peerGeos.map((p) => p.tag.y + (p.anchor === 'top' ? PEER_TAG_H : 0)),
  );
  return { width, height: bottom + 24, rects, links, peers: peerGeos };
}

/** Two cards of a row are joined under them; two cards of different rows, from the bottom of one to the top of the other. */
function peerRoute(a: Rect, b: Rect): Pick<PeerGeo, 'route' | 'tag' | 'anchor'> {
  if (a.y === b.y) {
    const [left, right] = a.x <= b.x ? [a, b] : [b, a];
    const from = { x: left.x + left.w * 0.75, y: left.y + left.h };
    const to = { x: right.x + right.w * 0.25, y: right.y + right.h };
    const low = from.y + PEER_DROP;
    const route = curve(from, { x: from.x, y: low + 8 }, { x: to.x, y: low + 8 }, to);
    const oriented = a === left ? route : curve(to, { x: to.x, y: low + 8 }, { x: from.x, y: low + 8 }, from);
    // The curve hangs three quarters of the way down to its control points; the tag starts under it
    return { route: oriented, tag: { x: (from.x + to.x) / 2, y: low + PEER_TAG_GAP }, anchor: 'top' };
  }
  const [up, down] = a.y < b.y ? [a, b] : [b, a];
  const from = { x: up.x + up.w * 0.3, y: up.y + up.h };
  const to = { x: down.x + down.w * 0.2, y: down.y };
  const c1 = { x: from.x, y: to.y - 30 };
  const c2 = { x: to.x, y: from.y + 30 };
  const route = a === up ? curve(from, c1, c2, to) : curve(to, c2, c1, from);
  // Between two rows the tag stands beside the middle of the link, on one line. The link passes there leaning toward
  // the lower card: the tag, which runs to the right, takes the side the link leaves, above it when the link goes
  // down to the right, below it when it goes down to the left.
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  // One card right under the other leaves no room above or below the link: the tag stands past its two ends.
  if (to.y - from.y < 2 * (PEER_TAG_RISE + PEER_TAG_HALF)) {
    return { route, tag: { x: Math.max(from.x, to.x) + PEER_TAG_GAP, y: middle.y }, anchor: 'left' };
  }
  const run = to.x - from.x;
  const side = Math.abs(run) < PEER_FLAT ? 0 : run > 0 ? -1 : 1;
  return { route, tag: { x: middle.x + PEER_TAG_GAP, y: middle.y + side * PEER_TAG_RISE }, anchor: 'left' };
}
