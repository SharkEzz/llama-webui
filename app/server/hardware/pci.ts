import type { TopologyGraph, TopologyLink, TopologyNode } from '@llama-webui/shared';
import { Array as Arr, Clock, Effect, FileSystem, HashSet, Option, Order, Path, String as Str } from 'effect';
import { dual, pipe } from 'effect/Function';
import { physicalDisks } from '../collectors/disk.ts';
import { readCpuInfo } from './cpu.ts';
import { PciIds } from './PciIds.ts';

/*
 * The machine's PCIe topology, read from sysfs (never lspci: it wakes up suspended cards). Shared with the
 * AMD collector, which needs the same link readings.
 */

export { findPciIdsEntry } from './PciIds.ts';

/** The trimmed text of a file, null when it cannot be read. */
export const readText = (file: string): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(
      Effect.map(Str.trim),
      Effect.orElseSucceed(() => null),
    );
  });

/** The number a file holds, null when it cannot be read or is not one. */
export const readNum = (file: string | null): Effect.Effect<number | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (file === null) return null;
    const text = yield* readText(file);
    const n = text === null ? Number.NaN : Number(text);
    return Number.isFinite(n) ? n : null;
  });

/** A sysfs host bridge directory (pciDDDD:BB): what sits right under it is a root port or a root-bus device. */
export const isHostBridge = (dir: string): boolean => /(?:^|\/)pci[0-9a-f]{4,}:[0-9a-f]{2}$/i.test(dir);

const GEN_BY_RATE: Readonly<Record<string, number>> = { '2.5': 1, '5': 2, '8': 3, '16': 4, '32': 5, '64': 6 };

/** sysfs `current_link_speed` ("32.0 GT/s PCIe") → PCIe generation. */
export function parseLinkSpeed(text: string): number | null {
  const m = /^([\d.]+)\s*GT\/s/.exec(Str.trim(text));
  return m === null ? null : (GEN_BY_RATE[String(Number(m[1]))] ?? null);
}

/** The smaller of two link capabilities; either may be unknown (a width of 0 is unknown too). */
export const minKnown: {
  (b: number | null): (a: number | null) => number | null;
  (a: number | null, b: number | null): number | null;
} = dual(2, (a: number | null, b: number | null): number | null => {
  const ka = a !== null && a > 0 ? a : null;
  const kb = b !== null && b > 0 ? b : null;
  if (ka === null) return kb;
  return kb === null ? ka : Math.min(ka, kb);
});

const isBridge = (dir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const cls = yield* readText(path.join(dir, 'class'));
    return Str.startsWith('0x0604')(cls ?? '');
  });

/**
 * Recent Radeon cards sit behind a PCIe switch on the card itself: the GPU's own link goes to that switch
 * and always reads its full width (e.g. Gen5 x16). The slot link is the switch's upstream port: the walk
 * climbs the card vendor's bridges (class 0x0604: any PCI bridge) above the device, and stops at the first
 * other bridge (a chipset port) or at a root port, which is never on the card even when it is AMD's own
 * (old ATI chipsets: RD890, 990FX). The link's other end is the port it plugs into, whose capability
 * bounds the link's maximum (a Gen4 x4 chipset slot); a host bridge has no link, so it gives no port.
 */
export const slotLink = Effect.fn('pci.slotLink')(function* (options: {
  readonly devicePath: string;
  /** The card vendor's sysfs id; Radeon (`0x1002`) by default. */
  readonly vendor?: string;
}) {
  const path = yield* Path.Path;
  const vendor = options.vendor ?? '0x1002';
  let link = options.devicePath;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(link);
    if (parent === link || isHostBridge(path.dirname(parent))) break;
    if ((yield* readText(path.join(parent, 'vendor'))) !== vendor || !(yield* isBridge(parent))) break;
    link = parent;
  }
  const port = path.dirname(link);
  return isHostBridge(port) || port === link
    ? ({ linkPath: link } as { linkPath: string; portPath?: string })
    : { linkPath: link, portPath: port };
});

/** The name in brackets (“GB203 [GeForce RTX 5070 Ti]”) is preferred over the chip name. */
const displayName = (entry: string): string => /\[([^\]]+)\]/.exec(entry)?.[1] ?? entry;

/** The `vendor` and `device` ids of a device directory (cached attributes, read without waking the card up). */
const idsOf = (dir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const [vendor, device] = yield* Effect.all([
      readText(path.join(dir, 'vendor')),
      readText(path.join(dir, 'device')),
    ]);
    return vendor === null || device === null ? Option.none() : Option.some({ vendor, device });
  });

/** The pci.ids entry of the device at `dir`, or none. */
const entryAt = (dir: string) =>
  Effect.gen(function* () {
    const ids = yield* PciIds;
    const found = yield* idsOf(dir);
    if (Option.isNone(found)) return Option.none<string>();
    return yield* ids.entry(found.value.vendor, found.value.device);
  });

/** The name of the device at `dir` in pci.ids, `fallback` when it has none. */
const nameAt = (dir: string, fallback: string) =>
  Effect.gen(function* () {
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
const isChipset = (up: string, root: string, entry: Option.Option<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const [upVendor, rootVendor, removable] = yield* Effect.all([
      readText(path.join(up, 'vendor')),
      readText(path.join(root, 'vendor')),
      readText(path.join(up, 'removable')),
    ]);
    if (upVendor === null || upVendor !== rootVendor) return false;
    return removable !== 'removable' && !/thunderbolt|usb4/i.test(Option.getOrElse(entry, () => ''));
  });

/** “600 Series Chipset PCIe Switch Upstream Port” → “600 Series Chipset”. */
export function chipsetLabel(name: string | null): string {
  if (name === null || name === '') return 'Chipset';
  const cut = pipe(
    name,
    Str.replace(/\s*(PCIe|PCI Express|PCI-E)\b.*$/i, ''),
    Str.replace(/\s*(Upstream|Downstream|Root)\s+Port.*$/i, ''),
    Str.trim,
  );
  return cut === '' ? 'Chipset' : cut;
}

/** “AMD Ryzen 5 9600X 6-Core Processor” → “AMD Ryzen 5 9600X”; “Intel(R) Core(TM) i7-12700K CPU @ 3.60GHz” → “Intel Core i7-12700K”. */
export function cpuLabel(model: string): string {
  const label = pipe(
    model,
    Str.replace(/\((R|TM)\)/gi, ''),
    Str.replace(/\s+\d+-Core Processor$/i, ''),
    Str.replace(/\s+Processor$/i, ''),
    Str.replace(/\s+CPU\s*@.*$/i, ''),
    Str.replace(/\s+with Radeon Graphics$/i, ''),
    Str.replace(/\s{2,}/g, ' '),
    Str.trim,
  );
  return label === '' ? 'CPU' : label;
}

const VENDORS: Readonly<Record<string, TopologyNode['vendor']>> = {
  '0x10de': 'nvidia',
  '0x1002': 'amd',
  '0x8086': 'intel',
};

/** PCIe link `from → to` whose downstream side is `linkPath` and upstream port `portPath`; no link attributes: internal. */
const pcieLink = (id: string, from: string, to: string, linkPath: string, portPath: string | null) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const speed = (dir: string | null, file: string) =>
      Effect.gen(function* () {
        const text = dir === null ? null : yield* readText(path.join(dir, file));
        return text === null ? null : parseLinkSpeed(text);
      });
    const width = (dir: string | null, file: string) => readNum(dir === null ? null : path.join(dir, file));
    const [genL, widthL, genP, widthP, genCur, widthCur] = yield* Effect.all([
      speed(linkPath, 'max_link_speed'),
      width(linkPath, 'max_link_width'),
      speed(portPath, 'max_link_speed'),
      width(portPath, 'max_link_width'),
      speed(linkPath, 'current_link_speed'),
      width(linkPath, 'current_link_width'),
    ]);
    // A suspended card (D3cold) may answer 0xFFFF to a config read: width “63”, to be ignored.
    const sane = (w: number | null) => (w !== null && Number.isInteger(w) && w > 0 && w <= 32 ? w : null);
    const genMax = minKnown(genL, genP);
    return {
      id,
      from,
      to,
      kind: genMax === null && genCur === null ? 'internal' : 'pcie',
      genMax,
      widthMax: minKnown(sane(widthL), sane(widthP)),
      genCur,
      widthCur: sane(widthCur),
    } satisfies TopologyLink;
  });

interface BlockDev {
  readonly block: string;
  /** Real directory of the controller (`…/0000:02:00.0/nvme/nvme0`). */
  readonly ctrlPath: string;
  readonly model: string | null;
  readonly sizeBytes: number | null;
}

const blockDevices = (sysRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(sysRoot, 'block');
    const disks = yield* physicalDisks(dir);
    const found = yield* Effect.forEach(disks, (block) =>
      Effect.gen(function* () {
        const ctrlPath = yield* fs.realPath(path.join(dir, block, 'device')).pipe(Effect.option);
        if (Option.isNone(ctrlPath)) return Option.none<BlockDev>();
        const sectors = yield* readNum(path.join(dir, block, 'size'));
        return Option.some({
          block,
          ctrlPath: ctrlPath.value,
          model: yield* readText(path.join(ctrlPath.value, 'model')),
          sizeBytes: sectors === null ? null : sectors * 512,
        });
      }),
    );
    return Arr.getSomes(found);
  });

const ramNode = (sysRoot: string, procRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mem = yield* readText(path.join(procRoot, 'meminfo'));
    const kb = Number(/^MemTotal:\s+(\d+)\s*kB/m.exec(mem ?? '')?.[1]);
    const hwmon = path.join(sysRoot, 'class', 'hwmon');
    const entries = yield* fs.readDirectory(hwmon).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const readings = yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        if ((yield* readText(path.join(hwmon, entry, 'name'))) !== 'spd5118') return null;
        const t = yield* readNum(path.join(hwmon, entry, 'temp1_input'));
        return t === null ? null : t / 1000;
      }),
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

/**
 * Hardware graph: CPU, memory, then each GPU (class 0x03) and NVMe controller (0x0108) with its link to the CPU,
 * directly (root port) or through a chipset node (bridges between the root port and the card that aren't the card's
 * own). Any failed read degrades to unknown: at worst the graph holds only the CPU and memory.
 */
export const readPciTopology = Effect.fn('pci.readPciTopology')(function* (
  options: { readonly sysRoot?: string; readonly procRoot?: string } = {},
): Effect.fn.Return<TopologyGraph, never, FileSystem.FileSystem | Path.Path | PciIds> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sysRoot = options.sysRoot ?? '/sys';
  const procRoot = options.procRoot ?? '/proc';
  const cpu = yield* readCpuInfo({ procRoot, sysRoot });
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
    yield* ramNode(sysRoot, procRoot),
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

  const devicesDir = path.join(sysRoot, 'bus', 'pci', 'devices');
  const listed = yield* fs.readDirectory(devicesDir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const busIds = Arr.sort(listed, Order.String);
  const blocks = yield* blockDevices(sysRoot);
  let chipsets = HashSet.empty<string>();

  for (const busId of busIds) {
    const cls = (yield* readText(path.join(devicesDir, busId, 'class'))) ?? '';
    const kind = Str.startsWith('0x03')(cls) ? 'gpu' : Str.startsWith('0x0108')(cls) ? 'nvme' : null;
    if (kind === null) continue;
    const real = yield* fs.realPath(path.join(devicesDir, busId)).pipe(Effect.option);
    if (Option.isNone(real)) continue;
    const devicePath = real.value;
    const vendorId = yield* readText(path.join(devicePath, 'vendor'));

    // Bridges from the root port down to the device's parent.
    const chain: Array<string> = [];
    let p = path.dirname(devicePath);
    while (!isHostBridge(p) && p !== path.dirname(p)) {
      chain.unshift(p);
      p = path.dirname(p);
    }
    if (!isHostBridge(p)) continue;

    const { linkPath, portPath } = yield* slotLink({ devicePath, vendor: vendorId ?? '' });
    const cardStart = linkPath === devicePath ? chain.length : chain.indexOf(linkPath);
    const between = chain.slice(1, cardStart);
    let from = 'cpu';
    const up = between[0];
    const root = chain[0];
    if (up !== undefined && root !== undefined) {
      const upId = path.basename(up);
      const entry = yield* entryAt(path.join(devicesDir, upId));
      if (yield* isChipset(up, root, entry)) {
        from = `chipset:${upId}`;
        if (!HashSet.has(chipsets, from)) {
          chipsets = HashSet.add(chipsets, from);
          const label = chipsetLabel(Option.match(entry, { onNone: () => null, onSome: displayName }));
          nodes.push({ id: from, kind: 'chipset', label, busId: upId, detail: {} });
          const uplink = yield* pcieLink(`cpu-${from}`, 'cpu', from, up, root);
          links.push(uplink);
        }
      }
    }

    const id = `pci:${busId}`;
    const vendor = VENDORS[vendorId ?? ''] ?? 'other';
    if (kind === 'gpu') {
      nodes.push({
        id,
        kind,
        label: yield* nameAt(path.join(devicesDir, busId), `GPU ${busId}`),
        busId,
        vendor,
        detail: {},
      });
    } else {
      const blk = Arr.findFirst(blocks, (b) => Str.startsWith(`${devicePath}/`)(b.ctrlPath));
      const model = Option.getOrNull(Option.flatMapNullishOr(blk, (b) => b.model));
      nodes.push({
        id,
        kind,
        label: model !== null && model !== '' ? model : yield* nameAt(path.join(devicesDir, busId), `NVMe ${busId}`),
        busId,
        vendor,
        ...(Option.isSome(blk) ? { block: blk.value.block } : {}),
        detail: { sizeBytes: Option.isSome(blk) ? blk.value.sizeBytes : null },
      });
    }
    const link = yield* pcieLink(`${from}-${id}`, from, id, linkPath, portPath ?? null);
    links.push(link);
  }
  const at = yield* Clock.currentTimeMillis;
  return { nodes, links, at };
});
