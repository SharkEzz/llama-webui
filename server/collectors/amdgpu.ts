import { readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { minKnown, parseLinkSpeed, pciName, readNum, readText, slotLink } from '../hardware/pci';
import { type GpuReading, identityReading } from './gpu';

export interface AmdCard {
  card: string;
  pdev: string;
  devicePath: string;
  hwmonPath: string | null;
  name: string;
  /** The card's DRM nodes (“card1”, “renderD128”): tie an open descriptor to its card without reading its fdinfo. */
  nodes?: string[];
  /** PCI device whose link is the card's slot link: the upstream port of the card's own PCIe switch, or the GPU itself. */
  linkPath?: string;
  /** The port at the other end of that link (motherboard slot or chipset), whose capability bounds the link's maximum. */
  portPath?: string;
  /** The link's maximum, kept once both ends' capabilities have been read: they never change. */
  linkMax?: { gen: number; width: number };
}

export function parseFdinfo(
  text: string,
): { driver: string; clientId: string; pdev: string; vramBytes: number } | null {
  const kv = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const driver = kv.get('drm-driver');
  if (driver !== 'amdgpu') return null;
  const pdev = kv.get('drm-pdev');
  const clientId = kv.get('drm-client-id');
  if (!pdev || !clientId) return null;
  const vram = /^(\d+)\s*(KiB|MiB|GiB)?$/.exec(kv.get('drm-memory-vram') ?? '0');
  const mult = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[(vram?.[2] ?? 'KiB') as 'KiB'];
  return { driver, clientId, pdev: pdev.toLowerCase(), vramBytes: vram ? Number(vram[1]) * mult : 0 };
}

/**
 * AMD VRAM of a process, per card, from its fdinfo. Descriptors open on a `skipNodes` node (hidden or suspended card)
 * are recognized by the target of their /proc/<pid>/fd/N link and their fdinfo is not read.
 */
export async function readProcAmdVram(
  pid: number,
  procRoot = '/proc',
  skipNodes?: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const dir = join(procRoot, String(pid), 'fdinfo');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  const seen = new Set<string>();
  await Promise.all(
    entries.map(async (e) => {
      if (skipNodes && skipNodes.size > 0) {
        const target = await readlink(join(procRoot, String(pid), 'fd', e)).catch(() => null);
        if (target && skipNodes.has(basename(target))) return;
      }
      let text: string;
      try {
        text = await readFile(join(dir, e), 'utf8');
      } catch {
        return;
      }
      if (!text.includes('amdgpu')) return;
      const info = parseFdinfo(text);
      if (!info) return;
      const id = `${info.pdev}#${info.clientId}`;
      if (seen.has(id)) return;
      seen.add(id);
      const k = `amd:${info.pdev}`;
      out.set(k, (out.get(k) ?? 0) + info.vramBytes);
    }),
  );
  return out;
}

/** Name of an AMD card from pci.ids; falls back to “AMD GPU <pdev>”. */
export const pciIdsName = (pdev: string, pciRoot?: string, idsPaths?: readonly string[]): Promise<string> =>
  pciName(pdev, pciRoot, idsPaths, `AMD GPU ${pdev}`);

export async function discoverAmdCards(
  drmRoot = '/sys/class/drm',
  nameOf: (pdev: string) => Promise<string> = (pdev) => pciIdsName(pdev),
): Promise<AmdCard[]> {
  let entries: string[];
  try {
    entries = await readdir(drmRoot);
  } catch {
    return [];
  }
  const cards: AmdCard[] = [];
  for (const card of entries.filter((e) => /^card\d+$/.test(e)).sort()) {
    const devLink = join(drmRoot, card, 'device');
    if ((await readText(join(devLink, 'vendor'))) !== '0x1002') continue;
    let devicePath: string;
    try {
      devicePath = await realpath(devLink);
    } catch {
      continue;
    }
    const pdev = basename(devicePath).toLowerCase();
    let hwmonPath: string | null = null;
    try {
      const hw = (await readdir(join(devicePath, 'hwmon'))).sort()[0];
      if (hw) hwmonPath = join(devicePath, 'hwmon', hw);
    } catch {}
    const nodes: string[] = [];
    for (const e of entries.filter((n) => /^(card|renderD)\d+$/.test(n)).sort()) {
      const real = await realpath(join(drmRoot, e, 'device')).catch(() => null);
      if (real === devicePath) nodes.push(e);
    }
    cards.push({ card, pdev, devicePath, hwmonPath, name: await nameOf(pdev), nodes, ...(await slotLink(devicePath)) });
  }
  return cards;
}

/**
 * The link's maximum: at most what both of its ends support. Capabilities never change, so it is kept on
 * the card once every one is known; until then (a port powered down or failing its read at startup) it is
 * read again on each poll.
 */
async function linkMax(card: AmdCard, link: string): Promise<{ gen: number | null; width: number | null }> {
  if (card.linkMax) return card.linkMax;
  const port = card.portPath;
  const [gen, width, portGen, portWidth] = await Promise.all([
    readWith(join(link, 'max_link_speed'), parseLinkSpeed),
    readNum(join(link, 'max_link_width')),
    port ? readWith(join(port, 'max_link_speed'), parseLinkSpeed) : null,
    port ? readNum(join(port, 'max_link_width')) : null,
  ]);
  const max = { gen: minKnown(gen, portGen), width: minKnown(width, portWidth) };
  const ends = port ? [gen, width, portGen, portWidth] : [gen, width];
  if (ends.every((v) => v !== null && v > 0)) card.linkMax = max as { gen: number; width: number };
  return max;
}

/** `pp_dpm_sclk` / `pp_dpm_mclk`: the current level is marked with "*". */
export function parseDpm(text: string): { curMhz: number | null; maxMhz: number | null } {
  let curMhz: number | null = null;
  let maxMhz: number | null = null;
  for (const line of text.split('\n')) {
    const m = /^\s*\w+:\s*(\d+)\s*Mhz(\s*\*)?/i.exec(line);
    if (!m) continue;
    const mhz = Number(m[1]);
    if (m[2]) curMhz = mhz;
    maxMhz = Math.max(maxMhz ?? 0, mhz);
  }
  return { curMhz, maxMhz };
}

const readWith = async <T>(p: string | null, parse: (t: string) => T): Promise<T | null> => {
  if (!p) return null;
  const t = await readText(p);
  return t === null ? null : parse(t);
};

const ratioPct = (v: number | null, max: number | null): number | null =>
  v === null || max === null || max <= 0 ? null : Math.round((v / max) * 100);

/**
 * True when the kernel has runtime-suspended the card (laptop dGPU, idle secondary card).
 * Reading power/runtime_status does not wake the device; reading the GPU attributes does.
 */
export async function isRuntimeSuspended(card: AmdCard): Promise<boolean> {
  try {
    return (await readFile(join(card.devicePath, 'power', 'runtime_status'), 'utf8')).trim() === 'suspended';
  } catch {
    return false;
  }
}

/** Placeholder sample for a suspended card: identity only, every metric unknown. */
const amdIdentity = (card: AmdCard) => ({
  key: `amd:${card.pdev}`,
  vendor: 'amd' as const,
  name: card.name,
  busId: card.pdev,
});

export const suspendedAmdReading = (card: AmdCard): GpuReading => identityReading(amdIdentity(card), 'suspended');
/** A card no tab shows: listed, not read. */
export const hiddenAmdReading = (card: AmdCard): GpuReading => identityReading(amdIdentity(card), 'hidden');

export async function readAmdCard(card: AmdCard): Promise<GpuReading> {
  const d = card.devicePath;
  const hw = card.hwmonPath;
  const h = (f: string) => hw && join(hw, f);
  const link = card.linkPath ?? d;
  const [util, used, total, temp, pAvg, memBusy, gen, max, width, sclk, mclk, pwm, pwmMax, cap] = await Promise.all([
    readNum(join(d, 'gpu_busy_percent')),
    readNum(join(d, 'mem_info_vram_used')),
    readNum(join(d, 'mem_info_vram_total')),
    readNum(h('temp1_input')),
    readNum(h('power1_average')),
    readNum(join(d, 'mem_busy_percent')),
    readWith(join(link, 'current_link_speed'), parseLinkSpeed),
    linkMax(card, link),
    readNum(join(link, 'current_link_width')),
    readWith(join(d, 'pp_dpm_sclk'), parseDpm),
    readWith(join(d, 'pp_dpm_mclk'), parseDpm),
    readNum(h('pwm1')),
    readNum(h('pwm1_max')),
    readNum(h('power1_cap')),
  ]);
  const power = pAvg ?? (await readNum(h('power1_input')));
  let fanPct = ratioPct(pwm, pwmMax);
  if (fanPct === null) {
    const [rpm, rpmMax] = await Promise.all([readNum(h('fan1_input')), readNum(h('fan1_max'))]);
    fanPct = ratioPct(rpm, rpmMax);
  }
  return {
    key: `amd:${card.pdev}`,
    vendor: 'amd',
    name: card.name,
    busId: card.pdev,
    utilPct: util,
    vramUsedBytes: used ?? 0,
    vramTotalBytes: total ?? 0,
    tempC: temp === null ? null : temp / 1000,
    powerW: power === null ? null : power / 1e6,
    memUtilPct: memBusy,
    fanPct,
    powerLimitW: cap === null ? null : cap / 1e6,
    clockGrMhz: sclk?.curMhz ?? null,
    clockGrMaxMhz: sclk?.maxMhz ?? null,
    clockMemMhz: mclk?.curMhz ?? null,
    pcieGen: gen,
    // A link that is down or retraining reads a width of 0: unknown, like an unknown maximum.
    pcieWidth: width !== null && width > 0 ? width : null,
    pcieGenMax: max.gen,
    pcieWidthMax: max.width,
  };
}
