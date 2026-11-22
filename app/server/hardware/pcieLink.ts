import { Effect, type FileSystem, Path, String as Str } from 'effect';
import { dual } from 'effect/Function';
import { readTrimmed } from '../collectors/read.ts';

/** The number a file holds, null when it cannot be read or is not one. */
export const readNum = (file: string | null): Effect.Effect<number | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (file === null) return null;
    const text = yield* readTrimmed(file);
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

/**
 * A PCIe link width that is a sane lane count (1..32).
 * A suspended card (D3cold) may answer 0xFFFF to a config read (width "63"), and a link down reads 0: both are unknown.
 */
export const saneLinkWidth = (w: number | null): number | null =>
  w !== null && Number.isInteger(w) && w > 0 && w <= 32 ? w : null;

const isBridge = Effect.fnUntraced(function* (dir: string) {
  const path = yield* Path.Path;
  const cls = yield* readTrimmed(path.join(dir, 'class'));
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
    if ((yield* readTrimmed(path.join(parent, 'vendor'))) !== vendor || !(yield* isBridge(parent))) break;
    link = parent;
  }
  const port = path.dirname(link);
  return isHostBridge(port) || port === link ? { linkPath: link } : { linkPath: link, portPath: port };
});

const readSpeed = Effect.fnUntraced(function* (dir: string | null, file: string) {
  if (dir === null) return null;
  const path = yield* Path.Path;
  const text = yield* readTrimmed(path.join(dir, file));
  return text === null ? null : parseLinkSpeed(text);
});

const readWidth = Effect.fnUntraced(function* (dir: string | null, file: string) {
  if (dir === null) return null;
  const path = yield* Path.Path;
  const width = yield* readNum(path.join(dir, file));
  return saneLinkWidth(width);
});

/** Maximum PCIe gen & width across both ends of a link (`linkPath` and optional upstream `portPath`). */
export const readLinkMax = Effect.fnUntraced(function* (linkPath: string, portPath: string | null) {
  const [genL, widthL, genP, widthP] = yield* Effect.all(
    [
      readSpeed(linkPath, 'max_link_speed'),
      readWidth(linkPath, 'max_link_width'),
      readSpeed(portPath, 'max_link_speed'),
      readWidth(portPath, 'max_link_width'),
    ],
    { concurrency: 'unbounded' },
  );
  const complete =
    portPath === null
      ? genL !== null && widthL !== null
      : genL !== null && widthL !== null && genP !== null && widthP !== null;
  return {
    gen: minKnown(genL, genP),
    width: minKnown(widthL, widthP),
    complete,
  };
});

/** Current PCIe gen & width of `linkPath`. */
export const readLinkCurrent = Effect.fnUntraced(function* (linkPath: string) {
  const [gen, width] = yield* Effect.all(
    [readSpeed(linkPath, 'current_link_speed'), readWidth(linkPath, 'current_link_width')],
    { concurrency: 'unbounded' },
  );
  return { gen, width };
});
