import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type GpuReading, identityReading } from "./gpu";

export interface AmdCard {
  card: string;
  pdev: string;
  devicePath: string;
  hwmonPath: string | null;
  name: string;
  /** PCI device whose link is the card's slot link: the upstream port of the card's own PCIe switch, or the GPU itself. */
  linkPath?: string;
  /** The port at the other end of that link (motherboard slot or chipset), whose capability bounds the link's maximum. */
  portPath?: string;
  /** The link's maximum, kept once both ends' capabilities have been read: they never change. */
  linkMax?: { gen: number; width: number };
}

export function parseFdinfo(text: string): { driver: string; clientId: string; pdev: string; vramBytes: number } | null {
  const kv = new Map<string, string>();
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const driver = kv.get("drm-driver");
  if (driver !== "amdgpu") return null;
  const pdev = kv.get("drm-pdev");
  const clientId = kv.get("drm-client-id");
  if (!pdev || !clientId) return null;
  const vram = /^(\d+)\s*(KiB|MiB|GiB)?$/.exec(kv.get("drm-memory-vram") ?? "0");
  const mult = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[(vram?.[2] ?? "KiB") as "KiB"];
  return { driver, clientId, pdev: pdev.toLowerCase(), vramBytes: vram ? Number(vram[1]) * mult : 0 };
}

export async function readProcAmdVram(pid: number, procRoot = "/proc"): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const dir = join(procRoot, String(pid), "fdinfo");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  const seen = new Set<string>();
  await Promise.all(
    entries.map(async (e) => {
      let text: string;
      try {
        text = await Bun.file(join(dir, e)).text();
      } catch {
        return;
      }
      if (!text.includes("amdgpu")) return;
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

const readText = async (p: string): Promise<string | null> => {
  try {
    return (await Bun.file(p).text()).trim();
  } catch {
    return null;
  }
};
const readNum = async (p: string | null): Promise<number | null> => {
  if (!p) return null;
  const t = await readText(p);
  const n = t === null ? NaN : Number(t);
  return Number.isFinite(n) ? n : null;
};

export async function lspciName(pdev: string): Promise<string> {
  try {
    const p = Bun.spawn(["lspci", "-mm", "-s", pdev], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    const fields = [...out.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
    const dev = fields[2];
    if (dev) return /\[([^\]]+)\]/.exec(dev)?.[1] ?? dev;
  } catch {}
  return `AMD GPU ${pdev}`;
}

export async function discoverAmdCards(drmRoot = "/sys/class/drm", nameOf: (pdev: string) => Promise<string> = lspciName): Promise<AmdCard[]> {
  let entries: string[];
  try {
    entries = await readdir(drmRoot);
  } catch {
    return [];
  }
  const cards: AmdCard[] = [];
  for (const card of entries.filter((e) => /^card\d+$/.test(e)).sort()) {
    const devLink = join(drmRoot, card, "device");
    if ((await readText(join(devLink, "vendor"))) !== "0x1002") continue;
    let devicePath: string;
    try {
      devicePath = await realpath(devLink);
    } catch {
      continue;
    }
    const pdev = basename(devicePath).toLowerCase();
    let hwmonPath: string | null = null;
    try {
      const hw = (await readdir(join(devicePath, "hwmon"))).sort()[0];
      if (hw) hwmonPath = join(devicePath, "hwmon", hw);
    } catch {}
    cards.push({ card, pdev, devicePath, hwmonPath, name: await nameOf(pdev), ...(await slotLink(devicePath)) });
  }
  return cards;
}

/** A sysfs host bridge directory (pciDDDD:BB): what sits right under it is a root port or a root-bus device. */
const isHostBridge = (dir: string) => /^pci[0-9a-f]{4,}:[0-9a-f]{2}$/i.test(basename(dir));

/**
 * Recent Radeon cards sit behind a PCIe switch on the card itself: the GPU's own link goes to that switch
 * and always reads its full width (e.g. Gen5 x16). The slot link is the switch's upstream port: the walk
 * climbs AMD bridges (vendor 0x1002, class 0x0604: any PCI bridge) above the GPU, and stops at the first
 * other bridge (a chipset port) or at a root port, which is never on the card even when it is AMD's own
 * (old ATI chipsets: RD890, 990FX). The link's other end is the port it plugs into, whose capability
 * bounds the link's maximum (a Gen4 x4 chipset slot); a host bridge has no link, so it gives no port.
 */
export async function slotLink(devicePath: string): Promise<{ linkPath: string; portPath?: string }> {
  let link = devicePath;
  for (let i = 0; i < 8; i++) {
    const parent = dirname(link);
    if (parent === link || isHostBridge(dirname(parent))) break;
    const [vendor, cls] = await Promise.all([readText(join(parent, "vendor")), readText(join(parent, "class"))]);
    if (vendor !== "0x1002" || !cls?.startsWith("0x0604")) break;
    link = parent;
  }
  const port = dirname(link);
  return isHostBridge(port) || port === link ? { linkPath: link } : { linkPath: link, portPath: port };
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
    readWith(join(link, "max_link_speed"), parseLinkSpeed),
    readNum(join(link, "max_link_width")),
    port ? readWith(join(port, "max_link_speed"), parseLinkSpeed) : null,
    port ? readNum(join(port, "max_link_width")) : null,
  ]);
  const max = { gen: minKnown(gen, portGen), width: minKnown(width, portWidth) };
  const ends = port ? [gen, width, portGen, portWidth] : [gen, width];
  if (ends.every((v) => v !== null && v > 0)) card.linkMax = max as { gen: number; width: number };
  return max;
}

/** The smaller of two link capabilities; either may be unknown (a width of 0 is unknown too). */
const minKnown = (a: number | null, b: number | null): number | null => {
  const ka = a !== null && a > 0 ? a : null;
  const kb = b !== null && b > 0 ? b : null;
  return ka === null ? kb : kb === null ? ka : Math.min(ka, kb);
};

const GEN_BY_RATE: Record<string, number> = { "2.5": 1, "5": 2, "8": 3, "16": 4, "32": 5, "64": 6 };

/** sysfs `current_link_speed` ("32.0 GT/s PCIe") → PCIe generation. */
export function parseLinkSpeed(text: string): number | null {
  const m = /^([\d.]+)\s*GT\/s/.exec(text.trim());
  return m ? (GEN_BY_RATE[String(Number(m[1]))] ?? null) : null;
}

/** `pp_dpm_sclk` / `pp_dpm_mclk`: the current level is marked with "*". */
export function parseDpm(text: string): { curMhz: number | null; maxMhz: number | null } {
  let curMhz: number | null = null;
  let maxMhz: number | null = null;
  for (const line of text.split("\n")) {
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

const ratioPct = (v: number | null, max: number | null): number | null => (v === null || max === null || max <= 0 ? null : Math.round((v / max) * 100));

/**
 * True when the kernel has runtime-suspended the card (laptop dGPU, idle secondary card).
 * Reading power/runtime_status does not wake the device; reading the GPU attributes does.
 */
export async function isRuntimeSuspended(card: AmdCard): Promise<boolean> {
  try {
    return (await Bun.file(join(card.devicePath, "power", "runtime_status")).text()).trim() === "suspended";
  } catch {
    return false;
  }
}

/** Placeholder sample for a suspended card: identity only, every metric unknown. */
const amdIdentity = (card: AmdCard) => ({ key: `amd:${card.pdev}`, vendor: "amd" as const, name: card.name, busId: card.pdev });

export const suspendedAmdReading = (card: AmdCard): GpuReading => identityReading(amdIdentity(card), "suspended");
/** A card no tab shows: listed, not read. */
export const hiddenAmdReading = (card: AmdCard): GpuReading => identityReading(amdIdentity(card), "hidden");

export async function readAmdCard(card: AmdCard): Promise<GpuReading> {
  const d = card.devicePath;
  const hw = card.hwmonPath;
  const h = (f: string) => hw && join(hw, f);
  const link = card.linkPath ?? d;
  const [util, used, total, temp, pAvg, memBusy, gen, max, width, sclk, mclk, pwm, pwmMax, cap] = await Promise.all([
    readNum(join(d, "gpu_busy_percent")),
    readNum(join(d, "mem_info_vram_used")),
    readNum(join(d, "mem_info_vram_total")),
    readNum(h("temp1_input")),
    readNum(h("power1_average")),
    readNum(join(d, "mem_busy_percent")),
    readWith(join(link, "current_link_speed"), parseLinkSpeed),
    linkMax(card, link),
    readNum(join(link, "current_link_width")),
    readWith(join(d, "pp_dpm_sclk"), parseDpm),
    readWith(join(d, "pp_dpm_mclk"), parseDpm),
    readNum(h("pwm1")),
    readNum(h("pwm1_max")),
    readNum(h("power1_cap")),
  ]);
  const power = pAvg ?? (await readNum(h("power1_input")));
  let fanPct = ratioPct(pwm, pwmMax);
  if (fanPct === null) {
    const [rpm, rpmMax] = await Promise.all([readNum(h("fan1_input")), readNum(h("fan1_max"))]);
    fanPct = ratioPct(rpm, rpmMax);
  }
  return {
    key: `amd:${card.pdev}`,
    vendor: "amd",
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
