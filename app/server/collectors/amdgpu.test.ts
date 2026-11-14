import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { Array as Arr, Effect, FileSystem, Layer, Option, Path, Record, String as Str } from 'effect';
import { PciIds } from '../hardware/PciIds.ts';
import {
  type AmdCard,
  discoverAmdCards,
  isRuntimeSuspended,
  parseDpm,
  parseFdinfo,
  readAmdCard,
  readProcAmdVram,
  suspendedAmdReading,
} from './amdgpu.ts';

const NO_IDS = PciIds.layerWith({ files: [] }).pipe(Layer.provideMerge(NodeServices.layer));

const fx = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.resolve(import.meta.dirname, '../../../testdata', name));
  });

/** Writes `text` at `file`, creating its folders. */
const write = (file: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text);
  });

const mkdir = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dir, { recursive: true });
  });

const link = (target: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.symlink(target, file);
  });

/** A fresh temporary folder, removed with the scope. */
const tmp = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix });
  });

const drmTree = Effect.fn('drmTree')(function* (full: boolean = false) {
  const path = yield* Path.Path;
  const root = yield* tmp('llt-drm-');
  const dev = Effect.fn('dev')(function* (card: string, vendor: string, pdev: string) {
    const real = path.join(root, 'devices', pdev);
    yield* mkdir(path.join(real, 'hwmon', 'hwmon3'));
    yield* write(path.join(real, 'vendor'), `${vendor}\n`);
    yield* mkdir(path.join(root, 'drm', card));
    yield* link(real, path.join(root, 'drm', card, 'device'));
    return real;
  });
  yield* dev('card0', '0x10de', '0000:01:00.0');
  const amd = yield* dev('card1', '0x1002', '0000:08:00.0');
  yield* mkdir(path.join(root, 'drm', 'card1-DP-1'));
  yield* write(path.join(amd, 'gpu_busy_percent'), '42\n');
  yield* write(path.join(amd, 'mem_info_vram_used'), '6366834688\n');
  yield* write(path.join(amd, 'mem_info_vram_total'), '17095983104\n');
  yield* write(path.join(amd, 'hwmon', 'hwmon3', 'temp1_input'), '38000\n');
  yield* write(path.join(amd, 'hwmon', 'hwmon3', 'power1_average'), '25000000\n');
  if (full) {
    const files: Readonly<Record<string, string>> = {
      current_link_speed: '16.0 GT/s PCIe',
      max_link_speed: '32.0 GT/s PCIe',
      current_link_width: '8',
      max_link_width: '16',
      mem_busy_percent: '12',
      pp_dpm_sclk: '0: 500Mhz\n1: 2400Mhz *\n2: 2520Mhz',
      pp_dpm_mclk: '0: 96Mhz\n1: 1250Mhz *',
      'hwmon/hwmon3/pwm1': '102',
      'hwmon/hwmon3/pwm1_max': '255',
      'hwmon/hwmon3/power1_cap': '300000000',
    };
    yield* Effect.forEach(Record.toEntries(files), ([file, value]) => write(path.join(amd, file), `${value}\n`));
  }
  return path.join(root, 'drm');
});

/** A fake sysfs PCI device under `root`/devices/pci0000:00 with its identity and link attributes. */
const pciNode = (root: string) =>
  Effect.fn('pciNode')(function* (
    sub: string,
    vendor: string,
    cls: string,
    cur: readonly [string, string],
    max: readonly [string, string],
  ) {
    const path = yield* Path.Path;
    const p = path.join(root, 'devices', 'pci0000:00', sub);
    yield* mkdir(p);
    const files = {
      vendor,
      class: cls,
      current_link_speed: cur[0],
      current_link_width: cur[1],
      max_link_speed: max[0],
      max_link_width: max[1],
    };
    yield* Effect.forEach(Record.toEntries(files), ([file, value]) => write(path.join(p, file), `${value}\n`));
    return p;
  });

/** Exposes `gpu` as drm `card`, the way /sys/class/drm/cardN/device links to the PCI device. */
const drmCard = (root: string, card: string, gpu: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* mkdir(path.join(root, 'drm', card));
    yield* link(gpu, path.join(root, 'drm', card, 'device'));
    return path.join(root, 'drm');
  });

/**
 * RX 9070 XT behind the chipset, as on the real machine: root port 00:01.1 → chipset upstream 04:00.0 →
 * chipset downstream 05:00.0 (Gen4 x4, `slotMax`) → card switch upstream 06:00.0 → downstream 07:00.0 → GPU 08:00.0.
 */
const chipsetCard = Effect.fn('chipsetCard')(function* (
  prefix: string,
  slotMax: readonly [string, string] = ['16.0 GT/s PCIe', '4'],
) {
  const path = yield* Path.Path;
  const root = yield* tmp(prefix);
  const node = pciNode(root);
  const chip = '0000:00:01.1/0000:04:00.0/0000:05:00.0';
  yield* node('0000:00:01.1', '0x1022', '0x060400', ['16.0 GT/s PCIe', '4'], ['16.0 GT/s PCIe', '16']);
  yield* node('0000:00:01.1/0000:04:00.0', '0x1022', '0x060400', ['16.0 GT/s PCIe', '4'], ['16.0 GT/s PCIe', '4']);
  yield* node(chip, '0x1022', '0x060400', ['16.0 GT/s PCIe', '4'], slotMax);
  const up = yield* node(
    `${chip}/0000:06:00.0`,
    '0x1002',
    '0x060400',
    ['16.0 GT/s PCIe', '4'],
    ['32.0 GT/s PCIe', '16'],
  );
  yield* node(
    `${chip}/0000:06:00.0/0000:07:00.0`,
    '0x1002',
    '0x060400',
    ['32.0 GT/s PCIe', '16'],
    ['32.0 GT/s PCIe', '16'],
  );
  const gpu = yield* node(
    `${chip}/0000:06:00.0/0000:07:00.0/0000:08:00.0`,
    '0x1002',
    '0x030000',
    ['32.0 GT/s PCIe', '16'],
    ['32.0 GT/s PCIe', '16'],
  );
  const drmRoot = yield* drmCard(root, 'card1', gpu);
  const [card] = yield* discoverAmdCards({ drmRoot });
  assert.isDefined(card);
  return { card: card as AmdCard, slot: path.join(root, 'devices', 'pci0000:00', chip), up };
});

const nums = (g: {
  pcieGen?: number | null;
  pcieWidth?: number | null;
  pcieGenMax?: number | null;
  pcieWidthMax?: number | null;
}) => [g.pcieGen, g.pcieWidth, g.pcieGenMax, g.pcieWidthMax];

layer(NO_IDS)('amdgpu', (it) => {
  it.effect('parseFdinfo amdgpu', () =>
    Effect.gen(function* () {
      const vramText = yield* fx('fdinfo-amd-vram.txt');
      const otherText = yield* fx('fdinfo-other.txt');
      assert.deepStrictEqual(parseFdinfo(vramText), {
        driver: 'amdgpu',
        clientId: '157',
        pdev: '0000:08:00.0',
        vramBytes: 6146240 * 1024,
      });
      assert.isNull(parseFdinfo(otherText));
      assert.isNull(parseFdinfo('pos: 0\nflags: 1\n'));
    }),
  );

  it.effect('readProcAmdVram dedupes by client id', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* tmp('llt-proc-');
        const dir = path.join(root, '123', 'fdinfo');
        const vram = yield* fx('fdinfo-amd-vram.txt');
        yield* write(path.join(dir, '96'), vram);
        yield* write(path.join(dir, '97'), vram);
        const igpu = yield* fx('fdinfo-amd-igpu.txt');
        yield* write(path.join(dir, '98'), igpu);
        yield* write(path.join(dir, '3'), 'pos: 0\n');
        const m = yield* readProcAmdVram(123, { procRoot: root, skipNodes: new Set() });
        assert.strictEqual(m.get('amd:0000:08:00.0'), 6146240 * 1024);
        assert.strictEqual(m.get('amd:0000:0d:00.0'), 32 * 1024);
        assert.strictEqual((yield* readProcAmdVram(999, { procRoot: root, skipNodes: new Set() })).size, 0);
      }),
    ),
  );

  it.effect('discoverAmdCards + readAmdCard', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drmRoot = yield* drmTree();
        const cards = yield* discoverAmdCards({ drmRoot });
        assert.deepStrictEqual(
          Arr.map(cards, (c) => c.card),
          ['card1'],
        );
        const [card] = cards;
        assert.isDefined(card);
        assert.strictEqual(card?.pdev, '0000:08:00.0');
        assert.strictEqual(card?.name, 'AMD GPU 0000:08:00.0');
        const s = yield* readAmdCard(card as AmdCard);
        assert.deepStrictEqual(s, {
          key: 'amd:0000:08:00.0',
          vendor: 'amd',
          name: 'AMD GPU 0000:08:00.0',
          busId: '0000:08:00.0',
          utilPct: 42,
          vramUsedBytes: 6366834688,
          vramTotalBytes: 17095983104,
          tempC: 38,
          powerW: 25,
          memUtilPct: null,
          fanPct: null,
          powerLimitW: null,
          clockGrMhz: null,
          clockGrMaxMhz: null,
          clockMemMhz: null,
          pcieGen: null,
          pcieWidth: null,
          pcieGenMax: null,
          pcieWidthMax: null,
        });
      }),
    ),
  );

  it('parseDpm', () => {
    assert.deepStrictEqual(parseDpm('0: 500Mhz\n1: 1200Mhz *\n2: 2520Mhz\n'), { curMhz: 1200, maxMhz: 2520 });
    assert.deepStrictEqual(parseDpm('S: 0Mhz *\n1: 500Mhz\n2: 2520Mhz\n'), { curMhz: 0, maxMhz: 2520 });
    assert.deepStrictEqual(parseDpm(''), { curMhz: null, maxMhz: null });
  });

  it.effect('readAmdCard reads link, clocks, fan and power cap', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const drmRoot = yield* drmTree(true);
        const [card] = yield* discoverAmdCards({ drmRoot });
        const g = yield* readAmdCard(card as AmdCard);
        assert.deepStrictEqual(nums(g), [4, 8, 5, 16]);
        assert.deepStrictEqual([g.clockGrMhz, g.clockGrMaxMhz, g.clockMemMhz, g.memUtilPct], [2400, 2520, 1250, 12]);
        assert.deepStrictEqual([g.fanPct, g.powerLimitW], [40, 300]);
        assert.isUndefined((g as { pcieRxBps?: number }).pcieRxBps);
      }),
    ),
  );

  it.effect('isRuntimeSuspended reads power/runtime_status without touching the device', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const dev = yield* tmp('llt-pm-');
        const card = { card: 'card1', pdev: '0000:08:00.0', devicePath: dev, hwmonPath: null, name: 'Radeon RX 9070' };
        const noAttribute = yield* isRuntimeSuspended(card);
        assert.isFalse(noAttribute);
        yield* write(path.join(dev, 'power', 'runtime_status'), 'active\n');
        const active = yield* isRuntimeSuspended(card);
        assert.isFalse(active);
        yield* write(path.join(dev, 'power', 'runtime_status'), 'suspended\n');
        const suspended = yield* isRuntimeSuspended(card);
        assert.isTrue(suspended);
        assert.deepStrictEqual(suspendedAmdReading(card), {
          key: 'amd:0000:08:00.0',
          vendor: 'amd',
          name: 'Radeon RX 9070',
          busId: '0000:08:00.0',
          utilPct: null,
          vramUsedBytes: 0,
          vramTotalBytes: 0,
          tempC: null,
          powerW: null,
          suspended: true,
        });
      }),
    ),
  );

  it.effect(
    'a card behind its own PCIe switch reports the slot link, bounded by the slot (RX 9070 XT in a Gen4 x4 chipset slot)',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { card } = yield* chipsetCard('llt-sw-');
          // The walk stops at the chipset's (non-AMD) downstream port, not at the root port further up.
          assert.isTrue(Str.endsWith('/0000:06:00.0')(card.linkPath ?? ''));
          assert.isTrue(Str.endsWith('/0000:05:00.0')(card.portPath ?? ''));
          const reading = yield* readAmdCard(card);
          assert.deepStrictEqual(nums(reading), [4, 4, 4, 4]);
        }),
      ),
  );

  it.effect('the slot link walk stops below an ATI-chipset root port (vendor 0x1002) and is bounded by it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        // 990FX root port 00:02.0 (AMD/ATI, Gen2 x16) → x8 card's switch upstream 01:00.0 → downstream 02:00.0 → GPU 03:00.0.
        const root = yield* tmp('llt-rp-');
        const node = pciNode(root);
        yield* node('0000:00:02.0', '0x1002', '0x060400', ['5.0 GT/s PCIe', '8'], ['5.0 GT/s PCIe', '16']);
        yield* node('0000:00:02.0/0000:01:00.0', '0x1002', '0x060400', ['5.0 GT/s PCIe', '8'], ['16.0 GT/s PCIe', '8']);
        yield* node(
          '0000:00:02.0/0000:01:00.0/0000:02:00.0',
          '0x1002',
          '0x060400',
          ['16.0 GT/s PCIe', '16'],
          ['16.0 GT/s PCIe', '16'],
        );
        const gpu = yield* node(
          '0000:00:02.0/0000:01:00.0/0000:02:00.0/0000:03:00.0',
          '0x1002',
          '0x030000',
          ['16.0 GT/s PCIe', '16'],
          ['16.0 GT/s PCIe', '16'],
        );
        const drmRoot = yield* drmCard(root, 'card0', gpu);
        const [card] = yield* discoverAmdCards({ drmRoot });
        assert.isTrue(Str.endsWith('/0000:01:00.0')(card?.linkPath ?? ''));
        const reading = yield* readAmdCard(card as AmdCard);
        assert.deepStrictEqual(nums(reading), [2, 8, 2, 8]);
      }),
    ),
  );

  it.effect(
    "a slot port reporting max_link_width 0 leaves the card's width as the maximum, and is read again until known",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          // The chipset port's LNKCAP read fails at startup (width 0), then succeeds.
          const { card, slot } = yield* chipsetCard('llt-w0-', ['16.0 GT/s PCIe', '0']);
          let g = yield* readAmdCard(card);
          assert.deepStrictEqual([g.pcieGenMax, g.pcieWidthMax], [4, 16]);
          assert.isUndefined(card.linkMax);
          yield* write(path.join(slot, 'max_link_width'), '4\n');
          g = yield* readAmdCard(card);
          assert.deepStrictEqual([g.pcieGenMax, g.pcieWidthMax], [4, 4]);
          // Known on both ends: kept, no longer read.
          assert.deepStrictEqual(card.linkMax, { gen: 4, width: 4 });
          yield* write(path.join(slot, 'max_link_width'), '0\n');
          g = yield* readAmdCard(card);
          assert.strictEqual(g.pcieWidthMax, 4);
        }),
      ),
  );

  it.effect('a link that is down or retraining (current width 0) has an unknown width, not x0', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { card, up } = yield* chipsetCard('llt-wd-');
        yield* write(path.join(up, 'current_link_width'), '0\n');
        const g = yield* readAmdCard(card);
        assert.isNull(g.pcieWidth);
      }),
    ),
  );

  it.effect(
    'pciIdsName names a card from sysfs ids and pci.ids, without lspci (which would wake a suspended card)',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* tmp('llw-pciids-');
          const dev = path.join(root, 'devices', '0000:08:00.0');
          yield* write(path.join(dev, 'vendor'), '0x1002\n');
          yield* write(path.join(dev, 'device'), '0x7550\n');
          yield* mkdir(path.join(root, 'drm', 'card1'));
          yield* link(dev, path.join(root, 'drm', 'card1', 'device'));
          const drmRoot = path.join(root, 'drm');
          // pci.ids itself is read and parsed by PciIds (hardware/PciIds.test.ts): here, the ids sysfs holds reach it.
          const ids = PciIds.of({
            name: (vendor, device) =>
              Effect.succeed(
                vendor === '0x1002' && device === '0x7550'
                  ? Option.some('Radeon RX 9070/9070 XT/9070 GRE')
                  : Option.none<string>(),
              ),
            entry: () => Effect.succeed(Option.none<string>()),
          });
          const [named] = yield* discoverAmdCards({ drmRoot }).pipe(Effect.provideService(PciIds, ids));
          assert.strictEqual(named?.name, 'Radeon RX 9070/9070 XT/9070 GRE');
          yield* write(path.join(dev, 'device'), '0x9999\n');
          const [other] = yield* discoverAmdCards({ drmRoot }).pipe(Effect.provideService(PciIds, ids));
          assert.strictEqual(other?.name, 'AMD GPU 0000:08:00.0');
        }),
      ),
  );

  it.effect("discoverAmdCards lists each card's DRM nodes (card and render), so fds can be matched to a card", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const drm = yield* drmTree();
        yield* mkdir(path.join(drm, 'renderD128'));
        yield* link(path.join(path.dirname(drm), 'devices', '0000:08:00.0'), path.join(drm, 'renderD128', 'device'));
        yield* mkdir(path.join(drm, 'renderD129'));
        yield* link(path.join(path.dirname(drm), 'devices', '0000:01:00.0'), path.join(drm, 'renderD129', 'device'));
        const [card] = yield* discoverAmdCards({ drmRoot: drm });
        assert.deepStrictEqual(card?.nodes, ['card1', 'renderD128']);
      }),
    ),
  );

  it.effect('readProcAmdVram skips fds on cards not to read (hidden or suspended), without opening their fdinfo', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* tmp('llt-proc-skip-');
        const fdinfo = path.join(root, '123', 'fdinfo');
        const fd = path.join(root, '123', 'fd');
        yield* mkdir(fd);
        const vramText = yield* fx('fdinfo-amd-vram.txt');
        const igpuText = yield* fx('fdinfo-amd-igpu.txt');
        yield* write(path.join(fdinfo, '96'), vramText);
        yield* write(path.join(fdinfo, '98'), igpuText);
        yield* link('/dev/dri/renderD128', path.join(fd, '96'));
        yield* link('/dev/dri/renderD129', path.join(fd, '98'));
        const m = yield* readProcAmdVram(123, { procRoot: root, skipNodes: new Set(['card2', 'renderD129']) });
        assert.strictEqual(m.get('amd:0000:08:00.0'), 6146240 * 1024);
        assert.isFalse(m.has('amd:0000:0d:00.0'));
      }),
    ),
  );
});
