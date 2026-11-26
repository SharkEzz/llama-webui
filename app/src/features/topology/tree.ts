import type { TopologyGraph, TopologyLink, TopologyNode } from '@llama-webui/shared';
import type { Point, Rect, Route } from './geometry';

/*
 * The hardware graph as both views read it: who hangs off what, in the order they are drawn, and the shape of a view's
 * placement. Pure.
 */

export interface Tree {
  cpu: TopologyNode | null;
  ram: TopologyNode | null;
  /** GPUs on an `internal` link of the CPU: part of it, not a device in a slot. */
  integrated: TopologyNode[];
  /** Devices of the CPU's root ports: GPUs, NVMe drives, chipsets, each by bus address. */
  ports: TopologyNode[];
  /** Devices behind each chipset of `ports`, in the same order, by chipset id. */
  behind: Map<string, TopologyNode[]>;
  /** Blocks none of the above reaches (an inconsistent graph): drawn all the same, so they stay visible. */
  loose: TopologyNode[];
  /** The link arriving at a block, by block id. */
  uplink: Map<string, TopologyLink>;
}

const KIND_ORDER: Record<TopologyNode['kind'], number> = { gpu: 0, nvme: 1, chipset: 2, cpu: 3, ram: 3 };
const byKindThenBus = (a: TopologyNode, b: TopologyNode) =>
  KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.busId ?? a.id).localeCompare(b.busId ?? b.id);

export function treeOf(graph: TopologyGraph): Tree {
  const cpu = graph.nodes.find((n) => n.kind === 'cpu') ?? null;
  const ram = graph.nodes.find((n) => n.kind === 'ram') ?? null;
  const uplink = new Map<string, TopologyLink>();
  for (const l of graph.links) if (!uplink.has(l.to)) uplink.set(l.to, l);

  const under = (parent: string) =>
    graph.nodes.filter((n) => n !== cpu && n !== ram && uplink.get(n.id)?.from === parent).toSorted(byKindThenBus);
  const ofCpu = cpu ? under(cpu.id) : [];
  const integrated = ofCpu.filter((n) => n.kind === 'gpu' && uplink.get(n.id)?.kind === 'internal');
  const ports = ofCpu.filter((n) => !integrated.includes(n));
  const behind = new Map<string, TopologyNode[]>();
  for (const c of ports) if (c.kind === 'chipset') behind.set(c.id, under(c.id));

  const reached = new Set([cpu, ram, ...integrated, ...ports, ...[...behind.values()].flat()]);
  const loose = graph.nodes.filter((n) => !reached.has(n)).toSorted(byKindThenBus);
  return { cpu, ram, integrated, ports, behind, loose, uplink };
}

/** A link of the graph as a view draws it. */
export interface LinkGeo {
  id: string;
  /** From the link's upstream block to its downstream block. */
  route: Route;
  /** Center of the link's label; null for a link that has none (an internal connection). */
  badge: Point | null;
}

/** A peer-to-peer connection between two GPUs, as a view draws it. */
export interface PeerGeo {
  id: string;
  route: Route;
  /** Where its tag hangs from, clear of the route and of the dots that run along it. */
  tag: Point;
  /** The side of the tag that point is the middle of: `top`, the tag stacks its lines under it; `left`, on one line. */
  anchor: 'top' | 'left';
  confirmed: boolean;
}

/** Where a view puts everything, in px of its natural size; the page scales it to its frame. */
export interface ViewLayout {
  width: number;
  height: number;
  /** Rectangle of each block, by block id. */
  rects: Map<string, Rect>;
  links: LinkGeo[];
  peers: PeerGeo[];
}

/** The links of the graph whose two ends are placed, with the geometry `draw` gives each. */
export function placedLinks(
  graph: TopologyGraph,
  rects: Map<string, Rect>,
  draw: (link: TopologyLink, from: Rect, to: Rect) => Omit<LinkGeo, 'id'> | null,
): LinkGeo[] {
  return graph.links.flatMap((link) => {
    const from = rects.get(link.from);
    const to = rects.get(link.to);
    const geo = from && to ? draw(link, from, to) : null;
    return geo ? [{ id: link.id, ...geo }] : [];
  });
}
