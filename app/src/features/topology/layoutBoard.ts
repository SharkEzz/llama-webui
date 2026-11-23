import type { TopologyGraph, TopologyNode } from '@llama-webui/shared';
import type { PeerLink } from './flows';
import { elbow, type Point, type Rect, type Route, straight } from './geometry';
import { type PeerGeo, placedLinks, treeOf, type ViewLayout } from './tree';

/*
 * The board plan: a top view of a motherboard, by convention. The app knows the graph (what hangs off the CPU, what
 * hangs off a chipset), not where a slot is on this machine's board: the socket is in the upper middle with the
 * memory modules at its right and the CPU's drives at its left, one slot per GPU under it (those of the CPU first),
 * the chipsets at the lower right with their drives. Tracks run at right angles, each in its own channel, so no two
 * cross. Sizes in px of the drawing's natural size.
 */

export interface BoardLayout extends ViewLayout {
  /** The board's outline. */
  board: Rect;
  /** The socket: the CPU's rectangle (drawn even without a CPU block, so the board keeps its shape). */
  socket: Rect;
  /** The module slots inside the memory's rectangle; `filled`: a module is in it. */
  dimms: { rect: Rect; filled: boolean }[];
}

const BOARD = { x: 16, y: 14, pad: 40 };
/** Center of the labels of the slots and of the sticks, in the column at the board's left. */
const LABEL_X = 84;
/** Left edge of the slots and of the sticks. */
const LEFT = 152;
const SLOT = { w: 558, h: 84, step: 112 };
const STICK = { w: 190, h: 32, step: 56 };
const SOCKET = { x: 420, y: 70, size: 180 };
/** Distance between two tracks that run side by side. */
const LANE = 14;
const DIMM = { top: 40, h: 200, w: 36, step: 50, narrow: { w: 20, step: 28 } };
const CHIPSET = { size: 100, stickStep: STICK.step };
/** Slots drawn when the count of memory modules is not known, and which of four hold a module for a count. */
const FILLED: Record<number, readonly number[]> = { 1: [1], 2: [1, 3], 3: [0, 1, 3], 4: [0, 1, 2, 3] };

const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;
const isGpu = (n: TopologyNode) => n.kind === 'gpu';

export function layoutBoard(graph: TopologyGraph, peers: readonly PeerLink[]): BoardLayout {
  const tree = treeOf(graph);
  const rects = new Map<string, Rect>();
  const routes = new Map<string, { route: Route; badge: Point | null }>();
  const link = (to: TopologyNode, route: Route, badge: Point | null) => {
    const up = tree.uplink.get(to.id);
    if (up) routes.set(up.id, { route, badge: up.kind === 'internal' ? null : badge });
  };

  const cpuGpus = tree.ports.filter(isGpu);
  const cpuDrives = tree.ports.filter((n) => n.kind === 'nvme');
  const chipsets = tree.ports.filter((n) => n.kind === 'chipset');
  const sticks = [...cpuDrives, ...tree.integrated];

  // The socket grows with what leaves it: a track per stick on its left side, a port per slot and chipset below
  const ports = Math.max(0, cpuGpus.length - 1) + chipsets.length;
  const socket: Rect = {
    x: SOCKET.x,
    y: SOCKET.y,
    w: Math.max(SOCKET.size, 78 + LANE * ports + 24),
    h: Math.max(SOCKET.size, 26 + STICK.step * (sticks.length - 1) + 30),
  };
  if (tree.cpu) rects.set(tree.cpu.id, socket);

  for (const [i, n] of sticks.entries()) {
    const r = { x: LEFT, y: socket.y + 10 + STICK.step * i, w: STICK.w, h: STICK.h };
    rects.set(n.id, r);
    const y = r.y + r.h / 2;
    link(n, straight({ x: socket.x, y }, { x: right(r), y }), { x: LABEL_X, y });
  }

  // Memory: its label, then one slot per module
  const count = Number(tree.ram?.detail.dimms) || 2;
  const many = count > 4;
  const slots = many ? count : 4;
  const dimm = many ? DIMM.narrow : DIMM;
  const memory: Rect = {
    x: right(socket) + 150,
    y: 30,
    w: Math.max(4 * DIMM.step - 14, slots * dimm.step),
    h: DIMM.top + DIMM.h,
  };
  const dimms = Array.from({ length: slots }, (_, i) => ({
    rect: { x: memory.x + dimm.step * i, y: memory.y + DIMM.top, w: dimm.w, h: DIMM.h },
    filled: many || (FILLED[count] ?? []).includes(i),
  }));
  if (tree.ram) {
    rects.set(tree.ram.id, memory);
    const y = socket.y + 90;
    link(tree.ram, straight({ x: right(socket), y }, { x: memory.x, y }), { x: right(socket) + 75, y: y - 42 });
  }

  // Under the socket, a band where the tracks turn: one level per port, a port further right turning higher
  const band = Math.max(bottom(socket), bottom(memory) - 20);
  const firstSlot = band + Math.max(100, 40 + LANE * ports + 24);
  const turn = (port: number) => firstSlot - 18 - LANE * port;
  const portX = (port: number) => socket.x + 78 + LANE * port;
  /** Channels at the right of the slots, where the tracks of the CPU's slots come down. */
  const channel = (k: number) => LEFT + SLOT.w + 16 + LANE * (k - 1);
  const slotAt = (y: number): Rect => ({ x: LEFT, y, w: SLOT.w, h: SLOT.h });

  let slotY = firstSlot;
  for (const [k, n] of cpuGpus.entries()) {
    const r = slotAt(slotY);
    rects.set(n.id, r);
    slotY += SLOT.step;
    const mid = r.y + r.h / 2;
    const badge = { x: LABEL_X, y: mid };
    if (k === 0) link(n, straight({ x: socket.x + 50, y: bottom(socket) }, { x: socket.x + 50, y: r.y }), badge);
    else {
      const px = portX(k - 1);
      const corners = [
        { x: px, y: bottom(socket) },
        { x: px, y: turn(k - 1) },
        { x: channel(k), y: turn(k - 1) },
        { x: channel(k), y: mid },
        { x: right(r), y: mid },
      ];
      link(n, elbow(corners), badge);
    }
  }

  // The chipsets, one under the other at the right of the channels, each with its slots at the left and its drives
  // at its lower right
  const chipX = channel(Math.max(1, cpuGpus.length - 1)) + 62;
  let columnY = firstSlot + 60;
  let columnRight = chipX;
  const far: { node: TopologyNode; rect: Rect; port: number }[] = [];
  for (const [c, n] of chipsets.entries()) {
    const behind = tree.behind.get(n.id) ?? [];
    const gpus = behind.filter(isGpu);
    const others = behind.filter((d) => !isGpu(d));
    const below = Math.max(0, gpus.length - 1);
    const first = Math.max(slotY, columnY + 30);
    const rect: Rect = {
      x: chipX,
      y: gpus.length > 0 ? first - 30 : Math.max(columnY, slotY - 30),
      w: Math.max(CHIPSET.size, 12 + LANE * below + LANE * others.length + 30),
      h: CHIPSET.size,
    };
    rects.set(n.id, rect);
    const port = Math.max(0, cpuGpus.length - 1) + c;
    far.push({ node: n, rect, port });

    for (const [j, d] of gpus.entries()) {
      const r = slotAt(first + SLOT.step * j);
      rects.set(d.id, r);
      const mid = r.y + r.h / 2;
      const badge = { x: LABEL_X, y: mid };
      // The first slot faces the chipset; the next ones are reached from under it, a lower slot from further right
      if (j === 0) link(d, straight({ x: rect.x, y: mid }, { x: right(r), y: mid }), badge);
      else {
        const x = rect.x + 12 + LANE * (j - 1);
        link(
          d,
          elbow([
            { x, y: bottom(rect) },
            { x, y: mid },
            { x: right(r), y: mid },
          ]),
          badge,
        );
      }
    }
    if (gpus.length > 0) slotY = first + SLOT.step * gpus.length;

    const stickX = right(rect) - 4;
    for (const [i, d] of others.entries()) {
      const r = { x: stickX, y: bottom(rect) + 30 + CHIPSET.stickStep * i, w: STICK.w, h: STICK.h };
      rects.set(d.id, r);
      const y = r.y + r.h / 2;
      // A lower drive leaves the chipset further left, so its track passes at the left of the drives above it
      const x = stickX - 12 - LANE * i;
      link(
        d,
        elbow(
          [
            { x, y: bottom(rect) },
            { x, y },
            { x: r.x, y },
          ],
          6,
        ),
        { x: right(r) + 58, y },
      );
      columnRight = Math.max(columnRight, right(r) + 116);
    }
    columnRight = Math.max(columnRight, right(rect) + 116);
    columnY = Math.max(bottom(rect), ...others.map((d) => bottom(rects.get(d.id)!))) + 44;
  }

  // The first chipset is reached from above; the next ones by a channel at the right of everything, then from above
  const edge = Math.max(columnRight, right(memory) + 8);
  for (const [c, { node, rect, port }] of far.entries()) {
    const px = portX(port);
    const cx = rect.x + rect.w / 2;
    const start = [
      { x: px, y: bottom(socket) },
      { x: px, y: turn(port) },
    ];
    const badge = { x: right(rect) + 58, y: rect.y + 34 };
    if (c === 0) link(node, elbow([...start, { x: cx, y: turn(port) }, { x: cx, y: rect.y }]), badge);
    else {
      const x = edge + 6 + LANE * (c - 1);
      const over = rect.y - 22;
      const corners = [...start, { x, y: turn(port) }, { x, y: over }, { x: cx, y: over }, { x: cx, y: rect.y }];
      link(node, elbow(corners), badge);
    }
  }
  const tracksRight = far.length > 1 ? edge + 6 + LANE * (far.length - 2) + 16 : edge;

  // What the convention has no place for goes after the last slot
  for (const n of tree.loose) {
    rects.set(n.id, slotAt(slotY));
    slotY += SLOT.step;
  }

  const lowest = Math.max(...[...rects.values()].map(bottom), bottom(socket), bottom(memory));
  const board: Rect = {
    x: BOARD.x,
    y: BOARD.y,
    w: Math.max(tracksRight, right(memory) + 8, LEFT + SLOT.w + 16) + 24 - BOARD.x,
    h: lowest + BOARD.pad - BOARD.y,
  };

  const peerGeos = peers.flatMap((p): PeerGeo[] => {
    const a = rects.get(p.from);
    const b = rects.get(p.to);
    if (!a || !b) return [];
    // Along the slots' left part, from the facing sides of the two parts
    const x = Math.max(a.x, b.x) + 68;
    const down = a.y <= b.y;
    const from = { x, y: down ? bottom(a) : a.y };
    const to = { x, y: down ? b.y : bottom(b) };
    return [
      { id: p.id, confirmed: p.confirmed, route: straight(from, to), tag: { x: x + 44, y: (from.y + to.y) / 2 } },
    ];
  });

  return {
    width: right(board) + BOARD.x,
    height: bottom(board) + BOARD.y,
    rects,
    links: placedLinks(graph, rects, (l) => routes.get(l.id) ?? null),
    peers: peerGeos,
    board,
    socket,
    dimms,
  };
}
