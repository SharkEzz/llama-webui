import type { GpuReading } from '@llama-webui/shared';
import { Array as Arr, Effect, FileSystem, Option, Path, String as Str } from 'effect';
import { PciIds } from '../hardware/PciIds.ts';
import { minKnown, parseLinkSpeed, readNum, readText, slotLink } from '../hardware/pci.ts';
import { identityReading } from './gpu.ts';

/*
 * The AMD cards, read from sysfs, hwmon and `/proc/<pid>/fdinfo`: no library, no `rocm-smi`. A failed read is an
 * unknown value, never an error: a card that goes away or sleeps mid-read must not fail the tick.
 */

export interface AmdCard {
  readonly card: string;
  readonly pdev: string;
  readonly devicePath: string;
  readonly hwmonPath: string | null;
  readonly name: string;
  /** The card's DRM nodes (“card1”, “renderD128”): tie an open descriptor to its card without reading its fdinfo. */
  readonly nodes?: ReadonlyArray<string>;
  /** PCI device whose link is the card's slot link: the upstream port of the card's own PCIe switch, or the GPU itself. */
  readonly linkPath?: string;
  /** The port at the other end of that link (motherboard slot or chipset), whose capability bounds the link's maximum. */
  readonly portPath?: string;
  /** The link's maximum, kept once both ends' capabilities have been read: they never change. */
  linkMax?: { readonly gen: number; readonly width: number };
}

const UNITS: Readonly<Record<string, number>> = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

export function parseFdinfo(
  text: string,
): { driver: string; clientId: string; pdev: string; vramBytes: number } | null {
  const kv = new Map<string, string>();
  for (const line of Str.split(text, '\n')) {
    const i = Str.indexOf(':')(line);
    if (Option.isSome(i) && i.value > 0)
      kv.set(Str.trim(Str.slice(0, i.value)(line)), Str.trim(Str.slice(i.value + 1)(line)));
  }
  const driver = kv.get('drm-driver');
  if (driver !== 'amdgpu') return null;
  const pdev = kv.get('drm-pdev');
  const clientId = kv.get('drm-client-id');
  if (pdev === undefined || pdev === '' || clientId === undefined || clientId === '') return null;
  const vram = /^(\d+)\s*(KiB|MiB|GiB)?$/.exec(kv.get('drm-memory-vram') ?? '0');
  const unit = UNITS[vram?.[2] ?? 'KiB'] ?? 1024;
  return { driver, clientId, pdev: Str.toLowerCase(pdev), vramBytes: vram === null ? 0 : Number(vram[1]) * unit };
}

/**
 * AMD VRAM of a process, per card (`amd:<pdev>`), from its fdinfo. Descriptors open on a `skipNodes` node (hidden or
 * suspended card) are recognized by the target of their /proc/<pid>/fd/N link and their fdinfo is not read.
 */
export const readProcAmdVram = Effect.fn('amdgpu.readProcAmdVram')(function* (
  pid: number,
  options: { readonly procRoot?: string; readonly skipNodes: ReadonlySet<string> },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const procRoot = options.procRoot ?? '/proc';
  const dir = path.join(procRoot, String(pid), 'fdinfo');
  const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const seen = new Set<string>();
  const perCard = new Map<string, number>();
  yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.gen(function* () {
        if (options.skipNodes.size > 0) {
          const target = yield* fs.readLink(path.join(procRoot, String(pid), 'fd', entry)).pipe(Effect.option);
          if (Option.isSome(target) && options.skipNodes.has(path.basename(target.value))) return;
        }
        const text = yield* fs.readFileString(path.join(dir, entry)).pipe(Effect.option);
        if (Option.isNone(text) || !Str.includes('amdgpu')(text.value)) return;
        const info = parseFdinfo(text.value);
        if (info === null) return;
        const id = `${info.pdev}#${info.clientId}`;
        if (seen.has(id)) return;
        seen.add(id);
        const key = `amd:${info.pdev}`;
        perCard.set(key, (perCard.get(key) ?? 0) + info.vramBytes);
      }),
    { concurrency: 'unbounded' },
  );
  return perCard as ReadonlyMap<string, number>;
});

/** The cards of `/sys/class/drm` whose vendor is AMD, with their name, DRM nodes and slot link. */
export const discoverAmdCards = Effect.fn('amdgpu.discoverAmdCards')(function* (
  options: { readonly drmRoot?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ids = yield* PciIds;
  const drmRoot = options.drmRoot ?? '/sys/class/drm';
  const entries = yield* fs.readDirectory(drmRoot).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const sorted = Arr.sort(entries, (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0));
  const nodeNames = Arr.filter(sorted, (e) => /^(card|renderD)\d+$/.test(e));
  const found: Array<AmdCard> = [];
  for (const card of Arr.filter(sorted, (e) => /^card\d+$/.test(e))) {
    const devLink = path.join(drmRoot, card, 'device');
    if ((yield* readText(path.join(devLink, 'vendor'))) !== '0x1002') continue;
    const real = yield* fs.realPath(devLink).pipe(Effect.option);
    if (Option.isNone(real)) continue;
    const devicePath = real.value;
    const pdev = Str.toLowerCase(path.basename(devicePath));
    const hwmons = yield* fs
      .readDirectory(path.join(devicePath, 'hwmon'))
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const hwmon = Arr.head(Arr.sort(hwmons, (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)));
    const hwmonPath = Option.match(hwmon, { onNone: () => null, onSome: (h) => path.join(devicePath, 'hwmon', h) });
    const nodes = yield* Effect.filter(nodeNames, (node) =>
      fs.realPath(path.join(drmRoot, node, 'device')).pipe(
        Effect.map((p) => p === devicePath),
        Effect.orElseSucceed(() => false),
      ),
    );
    const device = yield* readText(path.join(devicePath, 'device'));
    const named = device === null ? Option.none<string>() : yield* ids.name('0x1002', device);
    found.push({
      card,
      pdev,
      devicePath,
      hwmonPath,
      name: Option.getOrElse(named, () => `AMD GPU ${pdev}`),
      nodes,
      ...(yield* slotLink({ devicePath })),
    });
  }
  return found as ReadonlyArray<AmdCard>;
});

const readWith = <T>(file: string | null, parse: (text: string) => T) =>
  Effect.gen(function* () {
    if (file === null) return null;
    const text = yield* readText(file);
    return text === null ? null : parse(text);
  });

/**
 * The link's maximum: at most what both of its ends support. Capabilities never change, so it is kept on
 * the card once every one is known; until then (a port powered down or failing its read at startup) it is
 * read again on each poll.
 */
const linkMax = (card: AmdCard, link: string) =>
  Effect.gen(function* () {
    if (card.linkMax !== undefined) return card.linkMax;
    const path = yield* Path.Path;
    const port = card.portPath ?? null;
    const [gen, width, portGen, portWidth] = yield* Effect.all(
      [
        readWith(path.join(link, 'max_link_speed'), parseLinkSpeed),
        readNum(path.join(link, 'max_link_width')),
        readWith(port === null ? null : path.join(port, 'max_link_speed'), parseLinkSpeed),
        readNum(port === null ? null : path.join(port, 'max_link_width')),
      ],
      { concurrency: 'unbounded' },
    );
    const max = { gen: minKnown(gen, portGen), width: minKnown(width, portWidth) };
    const ends = port === null ? [gen, width] : [gen, width, portGen, portWidth];
    if (Arr.every(ends, (v) => v !== null && v > 0) && max.gen !== null && max.width !== null) {
      card.linkMax = { gen: max.gen, width: max.width };
    }
    return max;
  });

/** `pp_dpm_sclk` / `pp_dpm_mclk`: the current level is marked with "*". */
export function parseDpm(text: string): { curMhz: number | null; maxMhz: number | null } {
  let curMhz: number | null = null;
  let maxMhz: number | null = null;
  for (const line of Str.split(text, '\n')) {
    const m = /^\s*\w+:\s*(\d+)\s*Mhz(\s*\*)?/i.exec(line);
    if (m === null) continue;
    const mhz = Number(m[1]);
    if (m[2] !== undefined) curMhz = mhz;
    maxMhz = Math.max(maxMhz ?? 0, mhz);
  }
  return { curMhz, maxMhz };
}

const ratioPct = (v: number | null, max: number | null): number | null =>
  v === null || max === null || max <= 0 ? null : Math.round((v / max) * 100);

/**
 * True when the kernel has runtime-suspended the card (laptop dGPU, idle secondary card).
 * Reading power/runtime_status does not wake the device; reading the GPU attributes does.
 */
export const isRuntimeSuspended = (card: AmdCard): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return (yield* readText(path.join(card.devicePath, 'power', 'runtime_status'))) === 'suspended';
  });

/** Identity of a card with every metric unknown. */
const amdIdentity = (card: AmdCard) => ({
  key: `amd:${card.pdev}`,
  vendor: 'amd' as const,
  name: card.name,
  busId: card.pdev,
});

/** A card the kernel put to sleep: identity only, every metric unknown. */
export const suspendedAmdReading = (card: AmdCard): GpuReading => identityReading(amdIdentity(card), 'suspended');

/** A card no tab shows: listed, not read. */
export const hiddenAmdReading = (card: AmdCard): GpuReading => identityReading(amdIdentity(card), 'hidden');

const finiteOrNull = (n: number | null): number | null => (n !== null && Number.isFinite(n) ? n : null);

export const readAmdCard = Effect.fn('amdgpu.readAmdCard')(function* (card: AmdCard) {
  const path = yield* Path.Path;
  const d = card.devicePath;
  const hw = card.hwmonPath;
  const h = (file: string): string | null => (hw === null ? null : path.join(hw, file));
  const link = card.linkPath ?? d;
  const [util, used, total, temp, pAvg, memBusy, gen, max, width, sclk, mclk, pwm, pwmMax, cap] = yield* Effect.all(
    [
      readNum(path.join(d, 'gpu_busy_percent')),
      readNum(path.join(d, 'mem_info_vram_used')),
      readNum(path.join(d, 'mem_info_vram_total')),
      readNum(h('temp1_input')),
      readNum(h('power1_average')),
      readNum(path.join(d, 'mem_busy_percent')),
      readWith(path.join(link, 'current_link_speed'), parseLinkSpeed),
      linkMax(card, link),
      readNum(path.join(link, 'current_link_width')),
      readWith(path.join(d, 'pp_dpm_sclk'), parseDpm),
      readWith(path.join(d, 'pp_dpm_mclk'), parseDpm),
      readNum(h('pwm1')),
      readNum(h('pwm1_max')),
      readNum(h('power1_cap')),
    ],
    { concurrency: 'unbounded' },
  );
  const power = pAvg ?? (yield* readNum(h('power1_input')));
  let fanPct = ratioPct(pwm, pwmMax);
  if (fanPct === null) {
    const [rpm, rpmMax] = yield* Effect.all([readNum(h('fan1_input')), readNum(h('fan1_max'))]);
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
    pcieGen: finiteOrNull(gen),
    // A link that is down or retraining reads a width of 0: unknown, like an unknown maximum.
    pcieWidth: width !== null && Number.isInteger(width) && width > 0 ? width : null,
    pcieGenMax: max.gen,
    pcieWidthMax: max.width,
  } satisfies GpuReading;
});
