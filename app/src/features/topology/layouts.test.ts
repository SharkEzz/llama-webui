import type { TopologyGraph } from '@llama-webui/shared';
import { describe, expect, test } from 'vitest';
import { FOUR, LARGE, LOOSE, MACHINES, MINE, NO_CPU, ODD, ONE } from './fixtures';
import type { PeerLink } from './flows';
import { crosses, inside, onEdge, overlaps } from './geometry';
import { layoutBoard, litContacts } from './layoutBoard';
import { layoutCards } from './layoutCards';
import { treeOf } from './tree';

const ids = (nodes: readonly { id: string }[]) => nodes.map((n) => n.id);
const gpusOf = (graph: TopologyGraph) => ids(graph.nodes.filter((n) => n.kind === 'gpu'));
/** The GPUs of a graph joined as a chain, as `peerLinks` does for one backend. */
const chain = (graph: TopologyGraph, count: number): PeerLink[] =>
  gpusOf(graph)
    .slice(0, count)
    .slice(1)
    .map((to, i) => ({ id: `p2p:${i}`, from: gpusOf(graph)[i]!, to, confirmed: true }));

describe('treeOf', () => {
  test('the devices of the CPU come as GPUs, drives then chipsets, an integrated GPU apart', () => {
    const tree = treeOf(MINE);
    expect(tree.cpu?.id).toBe('cpu');
    expect(tree.ram?.id).toBe('ram');
    expect(tree.ports.map((n) => n.kind)).toEqual(['gpu', 'gpu', 'nvme', 'chipset']);
    expect(tree.ports.map((n) => n.label)).toEqual(['GPU 0', 'GPU 1', 'Drive 0', 'Chipset']);
    expect(tree.integrated.map((n) => n.label)).toEqual(['GPU 3']);
    expect([...tree.behind.values()].map((list) => list.map((n) => n.label))).toEqual([['GPU 2']]);
    expect(tree.loose).toEqual([]);
    expect(tree.uplink.get(tree.integrated[0]!.id)?.kind).toBe('internal');
  });

  test('a block no link reaches is loose, and so is every device of a graph without a CPU', () => {
    expect(treeOf(LOOSE).loose.map((n) => n.label)).toEqual(['GPU 1']);
    const tree = treeOf(NO_CPU);
    expect(tree.cpu).toBeNull();
    expect(tree.ports).toEqual([]);
    expect(tree.loose.map((n) => n.label)).toEqual(['GPU 0', 'Drive 0']);
  });

  test('devices are ordered by bus address whatever the order of the graph', () => {
    const shuffled = { ...MINE, nodes: MINE.nodes.toReversed(), links: MINE.links.toReversed() };
    expect(ids(treeOf(shuffled).ports)).toEqual(ids(treeOf(MINE).ports));
  });
});

const PLACEMENTS = [
  ['cards', layoutCards],
  ['board', layoutBoard],
] as const;

describe.each(PLACEMENTS)('%s placement', (view, layout) => {
  describe.each(Object.entries(MACHINES))('of the machine %s', (_name, graph) => {
    const placed = layout(graph, chain(graph, 3));
    const rects = [...placed.rects];

    test('is deterministic, and gives every block a rectangle inside the drawing', () => {
      expect(layout(graph, chain(graph, 3))).toEqual(placed);
      expect(ids(graph.nodes).filter((id) => !placed.rects.has(id))).toEqual([]);
      for (const [, r] of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(placed.width);
        expect(r.y + r.h).toBeLessThanOrEqual(placed.height);
        expect(r.w).toBeGreaterThan(0);
        expect(r.h).toBeGreaterThan(0);
      }
    });

    test('no two blocks overlap', () => {
      const pairs = rects.flatMap(([a, ra], i) => rects.slice(i + 1).map(([b, rb]) => [a, b, overlaps(ra, rb, 8)]));
      expect(pairs.filter(([, , hit]) => hit)).toEqual([]);
    });

    test('every link runs from its upstream block to its downstream block, through no other', () => {
      const linked = graph.links.filter((l) => placed.rects.has(l.from) && placed.rects.has(l.to));
      expect(placed.links.map((l) => l.id).toSorted()).toEqual(linked.map((l) => l.id).toSorted());
      for (const geo of placed.links) {
        const link = graph.links.find((l) => l.id === geo.id)!;
        expect(onEdge(geo.route.points[0]!, placed.rects.get(link.from)!), `${geo.id} start`).toBe(true);
        expect(onEdge(geo.route.points.at(-1)!, placed.rects.get(link.to)!), `${geo.id} end`).toBe(true);
        const through = rects.filter(([, r]) => geo.route.points.some((pt) => inside(pt, r))).map(([id]) => id);
        expect(through, `${geo.id} goes through`).toEqual([]);
        expect(geo.route.length).toBeGreaterThan(10);
      }
    });

    test('a measured link has a label, clear of the blocks and of the other labels', () => {
      const badges = placed.links.flatMap((l) => (l.badge ? [{ id: l.id, at: l.badge }] : []));
      const expected = graph.links.filter((l) => l.kind !== 'internal' && placed.links.some((g) => g.id === l.id));
      expect(badges.map((b) => b.id).toSorted()).toEqual(expected.map((l) => l.id).toSorted());
      for (const b of badges) {
        expect(
          rects.filter(([, r]) => inside(b.at, r)).map(([id]) => id),
          `${b.id} label`,
        ).toEqual([]);
        expect(b.at.x).toBeGreaterThan(0);
        expect(b.at.x).toBeLessThan(placed.width);
      }
      const close = badges.flatMap((a, i) =>
        badges.slice(i + 1).flatMap((b) => (Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y) < 40 ? [[a.id, b.id]] : [])),
      );
      expect(close).toEqual([]);
    });

    test('peer links join their two GPUs', () => {
      const peers = chain(graph, 3);
      expect(placed.peers.map((p) => p.id)).toEqual(peers.map((p) => p.id));
      for (const geo of placed.peers) {
        const peer = peers.find((p) => p.id === geo.id)!;
        expect(onEdge(geo.route.points[0]!, placed.rects.get(peer.from)!), `${geo.id} start`).toBe(true);
        expect(onEdge(geo.route.points.at(-1)!, placed.rects.get(peer.to)!), `${geo.id} end`).toBe(true);
        expect(rects.filter(([, r]) => inside(geo.tag, r))).toEqual([]);
        expect(geo.confirmed).toBe(true);
      }
    });

    test.runIf(view === 'board')('no two tracks cross', () => {
      const crossing = placed.links.flatMap((a, i) =>
        placed.links.slice(i + 1).flatMap((b) => (crosses(a.route, b.route) ? [[a.id, b.id]] : [])),
      );
      expect(crossing).toEqual([]);
    });
  });
});

describe('cards', () => {
  test('a row is as wide as it needs: four GPUs keep their width and the drawing grows', () => {
    const four = layoutCards(FOUR, []);
    const gpus = gpusOf(FOUR).map((id) => four.rects.get(id)!);
    for (const r of gpus) expect(r.w).toBeGreaterThanOrEqual(216);
    expect(four.width).toBeGreaterThanOrEqual(4 * 216 + 3 * 26);
    expect(layoutCards(LARGE, []).width).toBeGreaterThan(layoutCards(ONE, []).width);
    expect(layoutCards(LARGE, []).height).toBeGreaterThan(layoutCards(ONE, []).height);
  });

  test('the CPU is on top with the memory at its left and an integrated GPU at its right', () => {
    const { rects } = layoutCards(MINE, []);
    const tree = treeOf(MINE);
    const cpu = rects.get('cpu')!;
    expect(rects.get('ram')!.x + rects.get('ram')!.w).toBeLessThan(cpu.x);
    expect(rects.get(tree.integrated[0]!.id)!.x).toBeGreaterThan(cpu.x + cpu.w);
    for (const n of tree.ports) expect(rects.get(n.id)!.y).toBeGreaterThan(cpu.y + cpu.h);
    const chipset = rects.get(tree.ports.at(-1)!.id)!;
    for (const n of tree.behind.get(tree.ports.at(-1)!.id)!)
      expect(rects.get(n.id)!.y).toBeGreaterThan(chipset.y + chipset.h);
  });
});

describe('board', () => {
  test('the memory holds one slot per module, two filled when their count is unknown', () => {
    const filled = (graph: TopologyGraph) => layoutBoard(graph, []).dimms.map((d) => d.filled);
    expect(filled(ONE)).toEqual([false, true, false, true]);
    expect(filled(FOUR)).toEqual([true, true, true, true]);
    expect(filled(ODD)).toEqual([false, true, false, true]);
    expect(filled(LARGE)).toHaveLength(8);
    expect(filled(LARGE).every(Boolean)).toBe(true);
    const large = layoutBoard(LARGE, []);
    for (const d of large.dimms) {
      const ram = large.rects.get('ram')!;
      expect(d.rect.x).toBeGreaterThanOrEqual(ram.x);
      expect(d.rect.x + d.rect.w).toBeLessThanOrEqual(ram.x + ram.w);
      expect(d.rect.y + d.rect.h).toBeLessThanOrEqual(ram.y + ram.h);
    }
  });

  test('the board holds every block, and grows with the machine', () => {
    const large = layoutBoard(LARGE, []);
    for (const [, r] of large.rects) {
      expect(r.x).toBeGreaterThan(large.board.x);
      expect(r.x + r.w).toBeLessThan(large.board.x + large.board.w);
      expect(r.y + r.h).toBeLessThan(large.board.y + large.board.h);
    }
    expect(large.height).toBeGreaterThan(layoutBoard(ONE, []).height);
    expect(large.rects.get('cpu')).toEqual(large.socket);
  });

  test('GPUs sit in slots one under the other, those of the CPU first', () => {
    const { rects } = layoutBoard(MINE, []);
    const tree = treeOf(MINE);
    const slots = [...tree.ports.filter((n) => n.kind === 'gpu'), ...tree.behind.values().next().value!].map((n) =>
      rects.get(n.id)!,
    );
    expect(slots).toHaveLength(3);
    expect(slots.map((r) => r.x)).toEqual(slots.map(() => slots[0]!.x));
    expect(slots.slice(1).map((r, i) => r.y > slots[i]!.y + slots[i]!.h)).toEqual([true, true]);
  });
});

describe('litContacts', () => {
  test('a slot lights the share of its contacts that its lanes take out of sixteen', () => {
    expect(litContacts(16, 68)).toBe(68);
    expect(litContacts(8, 68)).toBe(34);
    expect(litContacts(4, 68)).toBe(17);
    expect(litContacts(1, 68)).toBe(4);
  });

  test('a link whose lanes are unknown lights every contact, and one lane lights at least one', () => {
    expect(litContacts(null, 68)).toBe(68);
    expect(litContacts(0, 68)).toBe(68);
    expect(litContacts(1, 8)).toBe(1);
    expect(litContacts(32, 68)).toBe(68);
  });
});
