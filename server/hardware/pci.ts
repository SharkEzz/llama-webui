import { readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { TopologyGraph, TopologyLink, TopologyNode } from '@llama-webui/shared';
import { readCpuInfo } from './cpu';

/*
 * Topologie PCIe de la machine, lue dans sysfs (jamais lspci : il réveille les cartes en veille). Partagé avec le
 * collecteur AMD, qui a besoin des mêmes lectures de liens.
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

/** Noms « vendor:device » → nom, par fichier pci.ids (environ 1,5 Mo : lu et découpé une seule fois par process). */
const pciIdsCache = new Map<string, Promise<Map<string, string> | null>>();

function parsePciIds(text: string): Map<string, string> {
  const names = new Map<string, string>();
  let vendor = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line === '') continue;
    if (!line.startsWith('\t')) {
      // Les classes (« C 00  Unclassified device ») terminent la liste des fabricants.
      if (line.startsWith('C ')) break;
      vendor = line.slice(0, 4).toLowerCase();
    } else if (!line.startsWith('\t\t')) {
      const name = line.slice(5).trim();
      names.set(`${vendor}:${line.slice(1, 5).toLowerCase()}`, /\[([^\]]+)\]/.exec(name)?.[1] ?? name);
    }
  }
  return names;
}

function loadPciIds(path: string): Promise<Map<string, string> | null> {
  let p = pciIdsCache.get(path);
  if (!p) {
    p = readText(path).then((text) => {
      // Fichier absent : pas mis en cache (il peut être installé plus tard).
      if (text === null) pciIdsCache.delete(path);
      return text === null ? null : parsePciIds(text);
    });
    pciIdsCache.set(path, p);
  }
  return p;
}

/**
 * Nom d'un périphérique d'après ses identifiants sysfs (`vendor`, `device` : attributs en cache, lus sans réveiller la
 * carte) et la base pci.ids. Le nom entre crochets (« GB203 [GeForce RTX 5070 Ti] ») est préféré au nom de la puce.
 */
export async function pciName(
  pdev: string,
  pciRoot = '/sys/bus/pci/devices',
  idsPaths: readonly string[] = PCI_IDS,
  fallback: string = pdev,
): Promise<string> {
  const id = async (f: string) => (await readText(join(pciRoot, pdev, f)))?.toLowerCase().replace(/^0x/, '') ?? null;
  const [vendor, device] = await Promise.all([id('vendor'), id('device')]);
  if (!vendor || !device) return fallback;
  for (const path of idsPaths) {
    const names = await loadPciIds(path);
    if (names) return names.get(`${vendor}:${device}`) ?? fallback;
  }
  return fallback;
}

/** « 600 Series Chipset PCIe Switch Upstream Port » → « 600 Series Chipset ». */
export function chipsetLabel(name: string | null): string {
  if (!name) return 'Chipset';
  const cut = name
    .replace(/\s*(PCIe|PCI Express|PCI-E)\b.*$/i, '')
    .replace(/\s*(Upstream|Downstream|Root)\s+Port.*$/i, '')
    .trim();
  return cut || 'Chipset';
}

/** « AMD Ryzen 5 9600X 6-Core Processor » → « AMD Ryzen 5 9600X » ; « Intel(R) Core(TM) i7-12700K CPU @ 3.60GHz » → « Intel Core i7-12700K ». */
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

/** Lien PCIe `from → to` dont le côté aval est `linkPath` et le port amont `portPath` ; sans attributs de lien : interne. */
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
  // Une carte en veille (D3cold) peut répondre 0xFFFF à la lecture de config : largeur « 63 », à ignorer.
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
  /** Répertoire réel du contrôleur (`…/0000:02:00.0/nvme/nvme0`). */
  ctrlPath: string;
  model: string | null;
  sizeBytes: number | null;
}

const VIRTUAL = /^(loop|ram|zram)\d/;

async function blockDevices(sysRoot: string): Promise<BlockDev[]> {
  const dir = join(sysRoot, 'block');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: BlockDev[] = [];
  for (const block of entries.sort()) {
    if (VIRTUAL.test(block)) continue;
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
    label: 'Mémoire',
    detail: {
      totalBytes: Number.isFinite(kb) ? kb * 1024 : null,
      dimms: temps.length > 0 ? temps.length : null,
      tempC: temps.length > 0 ? Math.max(...temps) : null,
    },
  };
}

/**
 * Graphe matériel : CPU, mémoire, puis chaque GPU (classe 0x03) et contrôleur NVMe (0x0108) avec son lien vers le CPU,
 * directement (port racine) ou via un nœud chipset (bridges entre le port racine et la carte qui ne sont pas les
 * siens). Toute lecture qui échoue dégrade en inconnu : au pire le graphe ne contient que CPU et mémoire.
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
    if (between.length > 0 && chain[0]) {
      const up = between[0]!;
      const upId = basename(up);
      from = `chipset:${upId}`;
      if (!chipsets.has(from)) {
        chipsets.add(from);
        const name = await pciName(upId, devicesDir, pciIds, '');
        nodes.push({ id: from, kind: 'chipset', label: chipsetLabel(name || null), busId: upId, detail: {} });
        links.push(await pcieLink(`cpu-${from}`, 'cpu', from, up, chain[0]));
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
