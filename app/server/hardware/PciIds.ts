import { Cache, Context, Duration, Effect, Exit, FileSystem, Layer, Option, String as Str } from 'effect';
import { dual, pipe } from 'effect/Function';

/** Where the `pci.ids` database lives, by distribution. */
const PCI_IDS_FILES: ReadonlyArray<string> = [
  '/usr/share/hwdata/pci.ids',
  '/usr/share/misc/pci.ids',
  '/usr/share/pci.ids',
];

/** Start of the next block: another vendor, or the class section (“C 00  Unclassified device”). */
const VENDOR_LINE = /\n(?:[0-9a-f]{4} {2}|C )/g;

/**
 * “vendor device” entry in the pci.ids text, without splitting it into lines (about 1.5 MiB): the vendor line, then
 * the device line before the next vendor. Subsystem lines (two tabs) and the class section (“C 00”) cannot match.
 */
export const findPciIdsEntry: {
  (vendor: string, device: string): (text: string) => string | null;
  (text: string, vendor: string, device: string): string | null;
} = dual(3, (text: string, vendor: string, device: string): string | null => {
  const vendorAt = Str.startsWith(`${vendor}  `)(text) ? Option.some(0) : Str.indexOf(`\n${vendor}  `)(text);
  if (Option.isNone(vendorAt)) return null;
  // From the vendor line (or the newline before it) to the start of the next block.
  const fromVendor = Str.slice(vendorAt.value)(text);
  VENDOR_LINE.lastIndex = 1;
  const block = Str.slice(0, VENDOR_LINE.exec(fromVendor)?.index)(fromVendor);
  const deviceAt = Str.indexOf(`\n\t${device}  `)(block);
  if (Option.isNone(deviceAt)) return null;
  const rest = Str.slice(deviceAt.value + 2 + device.length)(block);
  const line = Option.match(Str.indexOf('\n')(rest), {
    onNone: () => rest,
    onSome: (end) => Str.slice(0, end)(rest),
  });
  return Str.trim(line);
});

/** The name in brackets (“GB203 [GeForce RTX 5070 Ti]”) is preferred over the chip name. */
const displayName = (entry: string): string => /\[([^\]]+)\]/.exec(entry)?.[1] ?? entry;

/** A PCI id as pci.ids writes it: four lowercase hex digits, without `0x`. */
const idOf = (id: string): string => pipe(id, Str.toLowerCase, Str.replace(/^0x/, ''));

/** Why no file could be read: the answer is not kept, the next call looks at the files again. */
const NoPciIds = 'no pci.ids file could be read';

/** The names of PCI devices, from the `pci.ids` database. Hardware does not change: a name found stays for the process. */
export class PciIds extends Context.Service<
  PciIds,
  {
    /** The name of a device (vendor and device ids as sysfs writes them, `0x` and case ignored); its bracketed name when it has one. */
    readonly name: (vendor: string, device: string) => Effect.Effect<Option.Option<string>>;
    /** The whole entry of a device (“JHL7540 Thunderbolt 3 Bridge [Titan Ridge DD 2018]”), brackets included. */
    readonly entry: (vendor: string, device: string) => Effect.Effect<Option.Option<string>>;
  }
>()('@llama-webui/app/server/hardware/PciIds') {
  /** The first of `files` that lists the device names it. Each file is read once, a missing one is looked at again. */
  static readonly layerWith = (options: {
    readonly files: ReadonlyArray<string>;
  }): Layer.Layer<PciIds, never, FileSystem.FileSystem> =>
    Layer.effect(
      PciIds,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const texts = yield* Cache.makeWith((file: string) => fs.readFileString(file), {
          capacity: Number.MAX_SAFE_INTEGER,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
        });

        // Unknown is kept once some file was read (it lists the device or does not); no file at all is not.
        const entries = yield* Cache.makeWith(
          Effect.fnUntraced(function* (key: string) {
            const [vendor = '', device = ''] = Str.split(key, ':');
            let readOne = false;
            for (const file of options.files) {
              const text = yield* Cache.get(texts, file).pipe(Effect.option);
              if (Option.isNone(text)) continue;
              readOne = true;
              const found = findPciIdsEntry(text.value, vendor, device);
              if (found !== null) return Option.some(found);
            }
            return readOne ? Option.none<string>() : yield* Effect.fail(NoPciIds);
          }),
          {
            capacity: Number.MAX_SAFE_INTEGER,
            timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
          },
        );

        const entry = Effect.fn('PciIds.entry')(function* (vendor: string, device: string) {
          return yield* Cache.get(entries, `${idOf(vendor)}:${idOf(device)}`).pipe(
            Effect.orElseSucceed(() => Option.none<string>()),
          );
        });
        const name = Effect.fn('PciIds.name')(function* (vendor: string, device: string) {
          const found = yield* entry(vendor, device);
          return Option.map(found, displayName);
        });
        return PciIds.of({ name, entry });
      }),
    );

  static readonly layer: Layer.Layer<PciIds, never, FileSystem.FileSystem> = PciIds.layerWith({ files: PCI_IDS_FILES });
}
