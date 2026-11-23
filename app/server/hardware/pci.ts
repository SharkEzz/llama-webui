import type { CpuInfo, TopologyGraph, TopologyLink, TopologyNode } from '@llama-webui/shared';
import { Array as Arr, Clock, Effect, FileSystem, HashSet, Option, Order, Path, String as Str } from 'effect';
import { physicalDisks } from '../collectors/disk.ts';
import { readTrimmed } from '../collectors/read.ts';
import { readCpuInfo } from './cpu.ts';
import { isHostBridge, readLinkCurrent, readLinkMax, readNum, slotLink } from './pcieLink.ts';
import { displayName, PciIds } from './PciIds.ts';
import { chipsetLabel, cpuLabel } from './pciLabels.ts';

/*
 * The machine's PCIe topology, read from sysfs (never lspci: it wakes up suspended cards).
 */

export { findPciIdsEntry } from './PciIds.ts';
export { isHostBridge, minKnown, parseLinkSpeed, readNum, saneLinkWidth, slotLink } from './pcieLink.ts';
export { chipsetLabel, cpuLabel } from './pciLabels.ts';

/** The `vendor` and `device` ids of a device directory (cached attributes, read without waking the card up). */
const idsOf = Effect.fnUntraced(function* (dir: string) {
  const path = yield* Path.Path;
  const [vendor, device] = yield* Effect.all(
    [readTrimmed(path.join(dir, 'vendor')), readTrimmed(path.join(dir, 'device'))],
    { concurrency: 'unbounded' },
  );
  return vendor === null || device === null ? Option.none() : Option.some({ vendor, device });
});

/** The pci.ids entry of the device at `dir`, or none. */
const entryAt = Effect.fnUntraced(function* (dir: string) {
  const ids = yield* PciIds;
  const found = yield* idsOf(dir);
  if (Option.isNone(found)) return Option.none<string>();
  return yield* ids.entry(found.value.vendor, found.value.device);
});

/** The name of the device at `dir` in pci.ids, `fallback` when it has none. */
const nameAt = Effect.fnUntraced(function* (dir: string, fallback: string) {
  const ids = yield* PciIds;
  const found = yield* idsOf(dir);
  if (Option.isNone(found)) return fallback;
  const name = yield* ids.name(found.value.vendor, found.value.device);
  return Option.getOrElse(name, () => fallback);
});

/**
 * The first bridge below a root port is the chipset if it comes from the platform vendor (the root port's:
 * AMD for Promontory, X570 and 600 Series). A switch from another vendor (PLX/Broadcom, ASMedia, Microchip: NVMe
 * card, riser) is not a chipset: its devices stay attached to the CPU. Thunderbolt and USB4, from the same vendor
 * as the root port on Intel, aren't either: the kernel marks what sits below an external port “removable”,
 * and the full pci.ids name says so.
 */
const isChipset = Effect.fnUntraced(function* (up: string, root: string, entry: Option.Option<string>) {
  const path = yield* Path.Path;
  const [upVendor, rootVendor, removable] = yield* Effect.all(
    [
      readTrimmed(path.join(up, 'vendor')),
      readTrimmed(path.join(root, 'vendor')),
      readTrimmed(path.join(up, 'removable')),
    ],
    { concurrency: 'unbounded' },
  );
  if (upVendor === null || upVendor !== rootVendor) return false;
  return removable !== 'removable' && !/thunderbolt|usb4/i.test(Option.getOrElse(entry, () => ''));
});

const VENDORS: Readonly<Record<string, TopologyNode['vendor']>> = {
  '0x10de': 'nvidia',
  '0x1002': 'amd',
  '0x8086': 'intel',
};

/** The state of the PCIe link whose downstream side is `linkPath` and upstream port `portPath`; no link attributes: internal. */
const linkState = Effect.fnUntraced(function* (linkPath: string, portPath: string | null) {
  const [max, cur] = yield* Effect.all([readLinkMax(linkPath, portPath), readLinkCurrent(linkPath)], {
    concurrency: 'unbounded',
  });
  return {
    kind: max.gen === null && cur.gen === null ? 'internal' : 'pcie',
    genMax: max.gen,
    widthMax: max.width,
    genCur: cur.gen,
    widthCur: cur.width,
  } satisfies Omit<TopologyLink, 'id' | 'from' | 'to'>;
});

interface BlockDev {
  readonly block: string;
  /** Real directory of the controller (`…/0000:02:00.0/nvme/nvme0`). */
  readonly ctrlPath: string;
  readonly model: string | null;
  readonly sizeBytes: number | null;
}

const blockDevices = Effect.fnUntraced(function* (sysRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(sysRoot, 'block');
  const disks = yield* physicalDisks(dir);
  const found = yield* Effect.forEach(
    disks,
    (block) =>
      Effect.gen(function* () {
        const ctrlPath = yield* fs.realPath(path.join(dir, block, 'device')).pipe(Effect.option);
        if (Option.isNone(ctrlPath)) return Option.none<BlockDev>();
        const [sectors, model] = yield* Effect.all(
          [readNum(path.join(dir, block, 'size')), readTrimmed(path.join(ctrlPath.value, 'model'))],
          { concurrency: 'unbounded' },
        );
        return Option.some({
          block,
          ctrlPath: ctrlPath.value,
          model,
          sizeBytes: sectors === null ? null : sectors * 512,
        });
      }),
    { concurrency: 'unbounded' },
  );
  return Arr.getSomes(found);
});

const ramNode = Effect.fnUntraced(function* (sysRoot: string, procRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hwmon = path.join(sysRoot, 'class', 'hwmon');
  const [mem, entries] = yield* Effect.all(
    [
      readTrimmed(path.join(procRoot, 'meminfo')),
      fs.readDirectory(hwmon).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
    ],
    { concurrency: 'unbounded' },
  );
  const kb = Number(/^MemTotal:\s+(\d+)\s*kB/m.exec(mem ?? '')?.[1]);
  const readings = yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.gen(function* () {
        if ((yield* readTrimmed(path.join(hwmon, entry, 'name'))) !== 'spd5118') return null;
        const t = yield* readNum(path.join(hwmon, entry, 'temp1_input'));
        return t === null ? null : t / 1000;
      }),
    { concurrency: 'unbounded' },
  );
  const temps = Arr.filter(readings, (t): t is number => t !== null);
  return {
    id: 'ram',
    kind: 'ram',
    label: 'Memory',
    detail: {
      totalBytes: Number.isFinite(kb) ? kb * 1024 : null,
      dimms: temps.length > 0 ? temps.length : null,
      tempC: temps.length > 0 ? Math.max(...temps) : null,
    },
  } satisfies TopologyNode;
});

/** A GPU or NVMe controller of the graph: its node, its link, and the chipset it hangs from (with its uplink). */
interface Found {
  readonly node: TopologyNode;
  readonly link: TopologyLink;
  readonly chipset: Option.Option<{ readonly node: TopologyNode; readonly uplink: TopologyLink }>;
}

/**
 * The node of the device `busId` of class `kind`, its link to the CPU, directly (root port) or through a chipset node
 * (bridges between the root port and the card that aren't the card's own); none when it is not under a host bridge.
 * The reads that do not depend on each other run together.
 */
const deviceAt = Effect.fnUntraced(function* (
  devicesDir: string,
  busId: string,
  kind: 'gpu' | 'nvme',
  blocks: ReadonlyArray<BlockDev>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const real = yield* fs.realPath(path.join(devicesDir, busId)).pipe(Effect.option);
  if (Option.isNone(real)) return Option.none<Found>();
  const devicePath = real.value;

  // Bridges from the root port down to the device's parent.
  const chain: Array<string> = [];
  let p = path.dirname(devicePath);
  while (!isHostBridge(p) && p !== path.dirname(p)) {
    chain.unshift(p);
    p = path.dirname(p);
  }
  if (!isHostBridge(p)) return Option.none<Found>();

  const vendorId = yield* readTrimmed(path.join(devicePath, 'vendor'));
  const { linkPath, portPath } = yield* slotLink({ devicePath, vendor: vendorId ?? '' });
  const cardStart = linkPath === devicePath ? chain.length : chain.indexOf(linkPath);
  const between = chain.slice(1, cardStart);
  const up = between[0];
  const root = chain[0];

  /** The chipset node above the device and its uplink, none when the device hangs from the CPU. */
  const chipsetOf = Effect.gen(function* () {
    if (up === undefined || root === undefined) return Option.none<{ node: TopologyNode; uplink: TopologyLink }>();
    const upId = path.basename(up);
    const entry = yield* entryAt(path.join(devicesDir, upId));
    if (!(yield* isChipset(up, root, entry))) return Option.none<{ node: TopologyNode; uplink: TopologyLink }>();
    const id = `chipset:${upId}`;
    const label = chipsetLabel(Option.match(entry, { onNone: () => null, onSome: displayName }));
    const uplink: TopologyLink = { id: `cpu-${id}`, from: 'cpu', to: id, ...(yield* linkState(up, root)) };
    return Option.some({
      node: { id, kind: 'chipset', label, busId: upId, detail: {} } satisfies TopologyNode,
      uplink,
    });
  });

  const id = `pci:${busId}`;
  const vendor = VENDORS[vendorId ?? ''] ?? 'other';
  /** The device's own node. */
  const nodeOf = Effect.gen(function* () {
    if (kind === 'gpu') {
      return {
        id,
        kind,
        label: yield* nameAt(path.join(devicesDir, busId), `GPU ${busId}`),
        busId,
        vendor,
        detail: {},
      } satisfies TopologyNode;
    }
    const blk = Arr.findFirst(blocks, (b) => Str.startsWith(`${devicePath}/`)(b.ctrlPath));
    const model = Option.getOrNull(Option.flatMapNullishOr(blk, (b) => b.model));
    return {
      id,
      kind,
      label: model !== null && model !== '' ? model : yield* nameAt(path.join(devicesDir, busId), `NVMe ${busId}`),
      busId,
      vendor,
      ...(Option.isSome(blk) ? { block: blk.value.block } : {}),
      detail: { sizeBytes: Option.isSome(blk) ? blk.value.sizeBytes : null },
    } satisfies TopologyNode;
  });

  const [chipset, node, state] = yield* Effect.all([chipsetOf, nodeOf, linkState(linkPath, portPath ?? null)], {
    concurrency: 'unbounded',
  });
  const from = Option.match(chipset, { onNone: () => 'cpu', onSome: (c) => c.node.id });
  return Option.some<Found>({ node, link: { id: `${from}-${id}`, from, to: id, ...state }, chipset });
});

/**
 * Hardware graph: CPU, memory, then each GPU (class 0x03) and NVMe controller (0x0108) with its link to the CPU,
 * directly (root port) or through a chipset node (bridges between the root port and the card that aren't the card's
 * own). Any failed read degrades to unknown: at worst the graph holds only the CPU and memory.
 *
 * Read again on every call (the link state changes with power states), its independent files together: the devices'
 * classes at once, then each GPU and NVMe controller at once. The nodes and links keep the order of the bus ids. `cpu`
 * gives the CPU (the server's cached `CpuInfo`, read once); without it, `cpuinfo` is read under `procRoot`.
 */
export const readPciTopology = Effect.fn('pci.readPciTopology')(function* (
  options: {
    readonly sysRoot?: string;
    readonly procRoot?: string;
    readonly cpu?: Effect.Effect<CpuInfo>;
  } = {},
): Effect.fn.Return<TopologyGraph, never, FileSystem.FileSystem | Path.Path | PciIds> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sysRoot = options.sysRoot ?? '/sys';
  const procRoot = options.procRoot ?? '/proc';
  const devicesDir = path.join(sysRoot, 'bus', 'pci', 'devices');
  const [cpu, ram, listed, blocks] = yield* Effect.all(
    [
      options.cpu ?? readCpuInfo({ procRoot, sysRoot }),
      ramNode(sysRoot, procRoot),
      fs.readDirectory(devicesDir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
      blockDevices(sysRoot),
    ],
    { concurrency: 'unbounded' },
  );
  const nodes: Array<TopologyNode> = [
    {
      id: 'cpu',
      kind: 'cpu',
      label: cpuLabel(cpu.model),
      detail: {
        model: cpu.model === '' ? null : cpu.model,
        physicalCores: cpu.physicalCores,
        logicalThreads: cpu.logicalThreads,
        numaNodes: cpu.numaNodes,
      },
    },
    ram,
  ];
  const links: Array<TopologyLink> = [
    {
      id: 'cpu-ram',
      from: 'cpu',
      to: 'ram',
      kind: 'memory',
      genMax: null,
      widthMax: null,
      genCur: null,
      widthCur: null,
    },
  ];

  const busIds = Arr.sort(listed, Order.String);
  const classes = yield* Effect.forEach(busIds, (busId) => readTrimmed(path.join(devicesDir, busId, 'class')), {
    concurrency: 'unbounded',
  });
  const wanted = Arr.flatMap(busIds, (busId, i): Array<{ busId: string; kind: 'gpu' | 'nvme' }> => {
    const cls = classes[i] ?? '';
    if (Str.startsWith('0x03')(cls)) return [{ busId, kind: 'gpu' }];
    if (Str.startsWith('0x0108')(cls)) return [{ busId, kind: 'nvme' }];
    return [];
  });
  const found = yield* Effect.forEach(wanted, ({ busId, kind }) => deviceAt(devicesDir, busId, kind, blocks), {
    concurrency: 'unbounded',
  });

  let chipsets = HashSet.empty<string>();
  for (const { node, link, chipset } of Arr.getSomes(found)) {
    if (Option.isSome(chipset) && !HashSet.has(chipsets, chipset.value.node.id)) {
      chipsets = HashSet.add(chipsets, chipset.value.node.id);
      nodes.push(chipset.value.node);
      links.push(chipset.value.uplink);
    }
    nodes.push(node);
    links.push(link);
  }
  const at = yield* Clock.currentTimeMillis;
  return { nodes, links, at };
});
