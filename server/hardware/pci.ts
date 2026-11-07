import { readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { TopologyGraph, TopologyLink, TopologyNode } from '@llama-webui/shared';
import { physicalDisks } from '../collectors/disk';
import { readCpuInfo } from './cpu';

/*
 * The machine's PCIe topology, read from sysfs (never lspci: it wakes up suspended cards). Shared with the
 * AMD collector, which needs the same link readings.
 */

export const readText = async (p: string): Promise<string | null> => {
  try {
    return (await Bun.file(p).text()).trim();
  } catch {
    return null;
  }
};

export const readNum = async (p: string | null): Promise<number | null> => {
  if (!p) return null;
  const t = await readText(p);
  const n = t === null ? NaN : Number(t);
  return Number.isFinite(n) ? n : null;
};

/** A sysfs host bridge directory (pciDDDD:BB): what sits right under it is a root port or a root-bus device. */
export const isHostBridge = (dir: string) => /^pci[0-9a-f]{4,}:[0-9a-f]{2}$/i.test(basename(dir));

const GEN_BY_RATE: Record<string, number> = { '2.5': 1, '5': 2, '8': 3, '16': 4, '32': 5, '64': 6 };

/** sysfs `current_link_speed` ("32.0 GT/s PCIe") → PCIe generation. */
export function parseLinkSpeed(text: string): number | null {
  const m = /^([\d.]+)\s*GT\/s/.exec(text.trim());
  return m ? (GEN_BY_RATE[String(Number(m[1]))] ?? null) : null;
}

/** The smaller of two link capabilities; either may be unknown (a width of 0 is unknown too). */
export const minKnown = (a: number | null, b: number | null): number | null => {
  const ka = a !== null && a > 0 ? a : null;
  const kb = b !== null && b > 0 ? b : null;
  return ka === null ? kb : kb === null ? ka : Math.min(ka, kb);
};

const isBridge = async (dir: string) => ((await readText(join(dir, 'class'))) ?? '').startsWith('0x0604');

/**
 * Recent Radeon cards sit behind a PCIe switch on the card itself: the GPU's own link goes to that switch
 * and always reads its full width (e.g. Gen5 x16). The slot link is the switch's upstream port: the walk
 * climbs the card vendor's bridges (class 0x0604: any PCI bridge) above the device, and stops at the first
 * other bridge (a chipset port) or at a root port, which is never on the card even when it is AMD's own
 * (old ATI chipsets: RD890, 990FX). The link's other end is the port it plugs into, whose capability
 * bounds the link's maximum (a Gen4 x4 chipset slot); a host bridge has no link, so it gives no port.
 */
export async function slotLink(
  devicePath: string,
  vendor = '0x1002',
): Promise<{ linkPath: string; portPath?: string }> {
  let link = devicePath;
  for (let i = 0; i < 8; i++) {
    const parent = dirname(link);
    if (parent === link || isHostBridge(dirname(parent))) break;
    if ((await readText(join(parent, 'vendor'))) !== vendor || !(await isBridge(parent))) break;
    link = parent;
  }
  const port = dirname(link);
  return isHostBridge(port) || port === link ? { linkPath: link } : { linkPath: link, portPath: port };
}

export const PCI_IDS = ['/usr/share/hwdata/pci.ids', '/usr/share/misc/pci.ids', '/usr/share/pci.ids'];

/** Start of the next block: another vendor, or the class section (“C 00  Unclassified device”). */
const VENDOR_LINE = /\n(?:[0-9a-f]{4} {2}|C )/g;

/**
 * “vendor device” entry in the pci.ids text, without splitting it into lines (about 1.5 MiB): the vendor line, then
 * the device line before the next vendor. Subsystem lines (two tabs) and the class section (“C 00”) cannot
 * match.
 */
export function findPciIdsEntry(text: string, vendor: string, device: string): string | null {
  const v = text.startsWith(`${vendor}  `) ? 0 : text.indexOf(`\n${vendor}  `);
  if (v < 0) return null;
  VENDOR_LINE.lastIndex = v + 1;
  const end = VENDOR_LINE.exec(text)?.index ?? text.length;
  const d = text.indexOf(`\n\t${device}  `, v);
  if (d < 0 || d > end) return null;
  const nl = text.indexOf('\n', d + 1);
  // Copy: a JSC substring keeps the whole text it was sliced from alive (1.5 MiB per kept name).
  return Buffer.from(text.slice(d + 2 + device.length, nl < 0 ? undefined : nl).trim()).toString();
}

/**
 * Names already found (or missing), per file and “vendor:device”. Hardware doesn't change: after the first topology
 * read, pci.ids is never read again, and only a few names stay in memory.
 */
const pciIdsMemo = new Map<string, string | null>();

/** Full name of a device in pci.ids (“JHL7540 Thunderbolt 3 Bridge [Titan Ridge DD 2018]”); null if unknown. */
export async function pciIdsEntry(
  pdev: string,
  pciRoot = '/sys/bus/pci/devices',
  idsPaths: readonly string[] = PCI_IDS,
): Promise<string | null> {
  const id = async (f: string) => (await readText(join(pciRoot, pdev, f)))?.toLowerCase().replace(/^0x/, '') ?? null;
  const [vendor, device] = await Promise.all([id('vendor'), id('device')]);
  if (!vendor || !device) return null;
  for (const path of idsPaths) {
    const key = `${path}\0${vendor}:${device}`;
    const known = pciIdsMemo.get(key);
    if (known !== undefined) return known;
    // Missing file: not remembered (it may be installed later), the next one in the list is tried.
    const text = await readText(path);
    if (text === null) continue;
    const entry = findPciIdsEntry(text, vendor, device);
    pciIdsMemo.set(key, entry);
    return entry;
  }
  return null;
}

/** The name in brackets (“GB203 [GeForce RTX 5070 Ti]”) is preferred over the chip name. */
const displayName = (entry: string) => /\[([^\]]+)\]/.exec(entry)?.[1] ?? entry;

/**
 * Name of a device from its sysfs IDs (`vendor`, `device`: cached attributes, read without waking the card up) and
 * the pci.ids database.
 */
export async function pciName(
  pdev: string,
  pciRoot = '/sys/bus/pci/devices',
  idsPaths: readonly string[] = PCI_IDS,
  fallback: string = pdev,
): Promise<string> {
  const entry = await pciIdsEntry(pdev, pciRoot, idsPaths);
  return entry === null ? fallback : displayName(entry);
}

/**
 * The first bridge below a root port is the chipset if it comes from the platform vendor (the root port's:
 * AMD for Promontory, X570 and 600 Series). A switch from another vendor (PLX/Broadcom, ASMedia, Microchip: NVMe
 * card, riser) is not a chipset: its devices stay attached to the CPU. Thunderbolt and USB4, from the same vendor
 * as the root port on Intel, aren't either: the kernel marks what sits below an external port “removable”,
 * and the full pci.ids name says so.
 */
async function isChipset(up: string, root: string, entry: string | null): Promise<boolean> {
  const [upVendor, rootVendor, removable] = await Promise.all([
    readText(join(up, 'vendor')),
    readText(join(root, 'vendor')),
    readText(join(up, 'removable')),
  ]);
  if (upVendor === null || upVendor !== rootVendor) return false;
  return removable !== 'removable' && !/thunderbolt|usb4/i.test(entry ?? '');
}

/** “600 Series Chipset PCIe Switch Upstream Port” → “600 Series Chipset”. */
export function chipsetLabel(name: string | null): string {
  if (!name) return 'Chipset';
  const cut = name
    .replace(/\s*(PCIe|PCI Express|PCI-E)\b.*$/i, '')
    .replace(/\s*(Upstream|Downstream|Root)\s+Port.*$/i, '')
    .trim();
  return cut || 'Chipset';
}

/** “AMD Ryzen 5 9600X 6-Core Processor” → “AMD Ryzen 5 9600X”; “Intel(R) Core(TM) i7-12700K CPU @ 3.60GHz” → “Intel Core i7-12700K”. */
export function cpuLabel(model: string): string {
  return (
    model
      .replace(/\((R|TM)\)/gi, '')
      .replace(/\s+\d+-Core Processor$/i, '')
      .replace(/\s+Processor$/i, '')
      .replace(/\s+CPU\s*@.*$/i, '')
      .replace(/\s+with Radeon Graphics$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || 'CPU'
  );
}

const VENDORS: Record<string, TopologyNode['vendor']> = { '0x10de': 'nvidia', '0x1002': 'amd', '0x8086': 'intel' };

export interface PciTopologyOptions {
  sysRoot?: string;
  procRoot?: string;
  pciIds?: readonly string[];
}

/** PCIe link `from → to` whose downstream side is `linkPath` and upstream port `portPath`; no link attributes: internal. */
async function pcieLink(
  id: string,
  from: string,
  to: string,
  linkPath: string,
  portPath: string | null,
): Promise<TopologyLink> {
  const speed = async (p: string | null, f: string) => {
    const t = p ? await readText(join(p, f)) : null;
    return t === null ? null : parseLinkSpeed(t);
  };
  const [genL, widthL, genP, widthP, genCur, widthCur] = await Promise.all([
    speed(linkPath, 'max_link_speed'),
    readNum(join(linkPath, 'max_link_width')),
    speed(portPath, 'max_link_speed'),
    portPath ? readNum(join(portPath, 'max_link_width')) : null,
    speed(linkPath, 'current_link_speed'),
    readNum(join(linkPath, 'current_link_width')),
  ]);
  // A suspended card (D3cold) may answer 0xFFFF to a config read: width “63”, to be ignored.
  const sane = (w: number | null) => (w !== null && w > 0 && w <= 32 ? w : null);
  const genMax = minKnown(genL, genP);
  const widthMax = minKnown(sane(widthL), sane(widthP));
  return {
    id,
    from,
    to,
    kind: genMax === null && genCur === null ? 'internal' : 'pcie',
    genMax,
    widthMax,
    genCur,
    widthCur: sane(widthCur),
  };
}

interface BlockDev {
  block: string;
  /** Real directory of the controller (`…/0000:02:00.0/nvme/nvme0`). */
  ctrlPath: string;
  model: string | null;
  sizeBytes: number | null;
}

async function blockDevices(sysRoot: string): Promise<BlockDev[]> {
  const dir = join(sysRoot, 'block');
  const out: BlockDev[] = [];
  for (const block of await physicalDisks(dir)) {
    const ctrlPath = await realpath(join(dir, block, 'device')).catch(() => null);
    if (!ctrlPath) continue;
    const sectors = await readNum(join(dir, block, 'size'));
    out.push({
      block,
      ctrlPath,
      model: await readText(join(ctrlPath, 'model')),
      sizeBytes: sectors === null ? null : sectors * 512,
    });
  }
  return out;
}

async function ramNode(sysRoot: string, procRoot: string): Promise<TopologyNode> {
  const mem = await readText(join(procRoot, 'meminfo'));
  const kb = Number(/^MemTotal:\s+(\d+)\s*kB/m.exec(mem ?? '')?.[1]);
  const temps: number[] = [];
  const hwmon = join(sysRoot, 'class', 'hwmon');
  for (const e of await readdir(hwmon).catch(() => [] as string[])) {
    if ((await readText(join(hwmon, e, 'name'))) !== 'spd5118') continue;
    const t = await readNum(join(hwmon, e, 'temp1_input'));
    if (t !== null) temps.push(t / 1000);
  }
  return {
    id: 'ram',
    kind: 'ram',
    label: 'Memory',
    detail: {
      totalBytes: Number.isFinite(kb) ? kb * 1024 : null,
      dimms: temps.length > 0 ? temps.length : null,
      tempC: temps.length > 0 ? Math.max(...temps) : null,
    },
  };
}

/**
 * Hardware graph: CPU, memory, then each GPU (class 0x03) and NVMe controller (0x0108) with its link to the CPU,
 * directly (root port) or through a chipset node (bridges between the root port and the card that aren't the card's
 * own). Any failed read degrades to unknown: at worst the graph holds only the CPU and memory.
 */
export async function readPciTopology(o: PciTopologyOptions = {}): Promise<TopologyGraph> {
  const sysRoot = o.sysRoot ?? '/sys';
  const procRoot = o.procRoot ?? '/proc';
  const pciIds = o.pciIds ?? PCI_IDS;
  const cpu = await readCpuInfo(procRoot, sysRoot);
  const nodes: TopologyNode[] = [
    {
      id: 'cpu',
      kind: 'cpu',
      label: cpuLabel(cpu.model),
      detail: {
        model: cpu.model || null,
        physicalCores: cpu.physicalCores,
        logicalThreads: cpu.logicalThreads,
        numaNodes: cpu.numaNodes,
      },
    },
    await ramNode(sysRoot, procRoot),
  ];
  const links: TopologyLink[] = [
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

  const devicesDir = join(sysRoot, 'bus', 'pci', 'devices');
  const entries = (await readdir(devicesDir).catch(() => [] as string[])).sort();
  const blocks = await blockDevices(sysRoot);
  const chipsets = new Set<string>();

  for (const busId of entries) {
    const cls = await readText(join(devicesDir, busId, 'class'));
    const kind = cls?.startsWith('0x03') ? 'gpu' : cls?.startsWith('0x0108') ? 'nvme' : null;
    if (!kind) continue;
    const devicePath = await realpath(join(devicesDir, busId)).catch(() => null);
    if (!devicePath) continue;
    const vendorId = await readText(join(devicePath, 'vendor'));

    // Bridges from the root port down to the device's parent.
    const chain: string[] = [];
    let p = dirname(devicePath);
    while (!isHostBridge(p) && p !== dirname(p)) {
      chain.unshift(p);
      p = dirname(p);
    }
    if (!isHostBridge(p)) continue;

    const { linkPath, portPath } = await slotLink(devicePath, vendorId ?? '');
    const cardStart = linkPath === devicePath ? chain.length : chain.indexOf(linkPath);
    const between = chain.slice(1, cardStart);
    let from = 'cpu';
    const up = between[0];
    const root = chain[0];
    if (up && root) {
      const upId = basename(up);
      const entry = await pciIdsEntry(upId, devicesDir, pciIds);
      if (await isChipset(up, root, entry)) {
        from = `chipset:${upId}`;
        if (!chipsets.has(from)) {
          chipsets.add(from);
          const label = chipsetLabel(entry === null ? null : displayName(entry));
          nodes.push({ id: from, kind: 'chipset', label, busId: upId, detail: {} });
          links.push(await pcieLink(`cpu-${from}`, 'cpu', from, up, root));
        }
      }
    }

    const id = `pci:${busId}`;
    if (kind === 'gpu') {
      nodes.push({
        id,
        kind,
        label: await pciName(busId, devicesDir, pciIds, `GPU ${busId}`),
        busId,
        vendor: VENDORS[vendorId ?? ''] ?? 'other',
        detail: {},
      });
    } else {
      const blk = blocks.find((b) => b.ctrlPath.startsWith(`${devicePath}/`));
      nodes.push({
        id,
        kind,
        label: blk?.model || (await pciName(busId, devicesDir, pciIds, `NVMe ${busId}`)),
        busId,
        vendor: VENDORS[vendorId ?? ''] ?? 'other',
        ...(blk ? { block: blk.block } : {}),
        detail: { sizeBytes: blk?.sizeBytes ?? null },
      });
    }
    links.push(await pcieLink(`${from}-${id}`, from, id, linkPath, portPath ?? null));
  }
  return { nodes, links, at: Date.now() };
}
