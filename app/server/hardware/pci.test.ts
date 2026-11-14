import { NodeServices } from '@effect/platform-node';
import { assert, describe, it, layer } from '@effect/vitest';
import type { TopologyGraph } from '@llama-webui/shared';
import { Array as Arr, Effect, FileSystem, Layer, Option, Path, Record } from 'effect';
import { PciIds } from './PciIds.ts';
import { chipsetLabel, cpuLabel, findPciIdsEntry, minKnown, parseLinkSpeed, readPciTopology } from './pci.ts';

interface Dev {
  readonly vendor: string;
  readonly device: string;
  readonly cls: string;
  /** `max_link_speed|max_link_width|current_link_speed|current_link_width`, absent when no link attributes. */
  readonly link?: readonly [string, number, string, number];
  readonly children?: Readonly<Record<string, Dev>>;
}

const PCI_IDS = `# fixture
1002  Advanced Micro Devices, Inc. [AMD/ATI]
\t13c0  Granite Ridge [Radeon 610M]
\t7550  Navi 48 [Radeon RX 9070/9070 XT/9070 GRE]
1022  Advanced Micro Devices, Inc. [AMD]
\t43f4  600 Series Chipset PCIe Switch Upstream Port
10de  NVIDIA Corporation
\t2c05  GB203 [GeForce RTX 5070 Ti]
10b5  Broadcom / PLX
\t8747  PEX 8747 48-Lane, 5-Port PCI Express Gen 3 (8.0 GT/s) Switch
2646  Kingston Technology Company, Inc.
\t5022  OM8PGP4 PCIe 4 NVMe SSD (QLC) (DRAM-less)
8086  Intel Corporation
\t15ef  JHL7540 Thunderbolt 3 Bridge [Titan Ridge DD 2018]
`;

/** One device of a fake sysfs under `dir`, then its children; each is also linked from `byId`, as `bus/pci/devices` does. */
const writeDevice = (
  byId: string,
  dir: string,
  id: string,
  d: Dev,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const at = path.join(dir, id);
    yield* fs.makeDirectory(at, { recursive: true });
    yield* fs.writeFileString(path.join(at, 'vendor'), `${d.vendor}\n`);
    yield* fs.writeFileString(path.join(at, 'device'), `${d.device}\n`);
    yield* fs.writeFileString(path.join(at, 'class'), `${d.cls}\n`);
    if (d.link !== undefined) {
      yield* fs.writeFileString(path.join(at, 'max_link_speed'), `${d.link[0]}\n`);
      yield* fs.writeFileString(path.join(at, 'max_link_width'), `${d.link[1]}\n`);
      yield* fs.writeFileString(path.join(at, 'current_link_speed'), `${d.link[2]}\n`);
      yield* fs.writeFileString(path.join(at, 'current_link_width'), `${d.link[3]}\n`);
    }
    yield* fs.symlink(at, path.join(byId, id));
    yield* Effect.forEach(Record.toEntries(d.children ?? {}), ([childId, child]) =>
      writeDevice(byId, at, childId, child),
    );
  }).pipe(Effect.orDie);

/**
 * A fake sysfs/procfs mirroring the reference machine: two root-port GPUs and an NVMe on the CPU, a Radeon behind a
 * chipset switch (with its own on-card switch), an "internal" bridge device with no link attributes.
 */
const machine = Effect.fn('machine')(function* (extra: Readonly<Record<string, Dev>> = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-pci-topo-' });
  const sys = path.join(root, 'sys');
  const proc = path.join(root, 'proc');
  const host = path.join(sys, 'devices', 'pci0000:00');
  const byId = path.join(sys, 'bus', 'pci', 'devices');
  yield* fs.makeDirectory(byId, { recursive: true });

  const tree: Readonly<Record<string, Dev>> = {
    '0000:00:01.1': {
      vendor: '0x1022',
      device: '0x14da',
      cls: '0x060400',
      link: ['32.0 GT/s PCIe', 8, '2.5 GT/s PCIe', 8],
      children: {
        '0000:01:00.0': {
          vendor: '0x10de',
          device: '0x2c05',
          cls: '0x030000',
          link: ['32.0 GT/s PCIe', 16, '2.5 GT/s PCIe', 8],
        },
      },
    },
    '0000:00:01.2': {
      vendor: '0x1022',
      device: '0x14da',
      cls: '0x060400',
      link: ['32.0 GT/s PCIe', 4, '16.0 GT/s PCIe', 4],
      children: {
        '0000:02:00.0': {
          vendor: '0x2646',
          device: '0x5022',
          cls: '0x010802',
          link: ['16.0 GT/s PCIe', 4, '16.0 GT/s PCIe', 4],
        },
      },
    },
    '0000:00:02.1': {
      vendor: '0x1022',
      device: '0x14db',
      cls: '0x060400',
      link: ['32.0 GT/s PCIe', 4, '16.0 GT/s PCIe', 4],
      children: {
        '0000:04:00.0': {
          vendor: '0x1022',
          device: '0x43f4',
          cls: '0x060400',
          link: ['16.0 GT/s PCIe', 4, '16.0 GT/s PCIe', 4],
          children: {
            '0000:05:00.0': {
              vendor: '0x1022',
              device: '0x43f5',
              cls: '0x060400',
              link: ['16.0 GT/s PCIe', 4, '16.0 GT/s PCIe', 4],
              children: {
                '0000:06:00.0': {
                  vendor: '0x1002',
                  device: '0x1478',
                  cls: '0x060400',
                  link: ['32.0 GT/s PCIe', 16, '16.0 GT/s PCIe', 4],
                  children: {
                    '0000:07:00.0': {
                      vendor: '0x1002',
                      device: '0x1479',
                      cls: '0x060400',
                      link: ['32.0 GT/s PCIe', 16, '32.0 GT/s PCIe', 16],
                      children: {
                        '0000:08:00.0': {
                          vendor: '0x1002',
                          device: '0x7550',
                          cls: '0x030000',
                          link: ['32.0 GT/s PCIe', 16, '32.0 GT/s PCIe', 16],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '0000:00:08.1': {
      vendor: '0x1022',
      device: '0x14dd',
      cls: '0x060400',
      children: {
        '0000:0d:00.0': { vendor: '0x1002', device: '0x13c0', cls: '0x030000' },
      },
    },
  };
  yield* Effect.forEach(Record.toEntries({ ...tree, ...extra }), ([id, d]) => writeDevice(byId, host, id, d));

  // NVMe controller and its block device.
  const ctrl = path.join(host, '0000:00:01.2', '0000:02:00.0', 'nvme', 'nvme0');
  yield* fs.makeDirectory(ctrl, { recursive: true });
  yield* fs.writeFileString(path.join(ctrl, 'model'), 'KINGSTON OM8PGP41024N-A0                \n');
  yield* fs.makeDirectory(path.join(sys, 'block', 'nvme0n1'), { recursive: true });
  yield* fs.symlink(ctrl, path.join(sys, 'block', 'nvme0n1', 'device'));
  yield* fs.writeFileString(path.join(sys, 'block', 'nvme0n1', 'size'), '2000409264\n');
  // A loop device must be ignored.
  yield* fs.makeDirectory(path.join(sys, 'block', 'loop0'), { recursive: true });

  // DIMM temperature sensors and the CPU sensor.
  for (const [h, name, t] of [
    ['hwmon3', 'k10temp', '41375'],
    ['hwmon5', 'spd5118', '29500'],
    ['hwmon6', 'spd5118', '27750'],
  ] as const) {
    yield* fs.makeDirectory(path.join(sys, 'class', 'hwmon', h), { recursive: true });
    yield* fs.writeFileString(path.join(sys, 'class', 'hwmon', h, 'name'), `${name}\n`);
    yield* fs.writeFileString(path.join(sys, 'class', 'hwmon', h, 'temp1_input'), `${t}\n`);
  }
  yield* fs.makeDirectory(path.join(sys, 'devices', 'system', 'node', 'node0'), { recursive: true });

  yield* fs.makeDirectory(proc, { recursive: true });
  yield* fs.writeFileString(
    path.join(proc, 'cpuinfo'),
    Arr.join(
      Arr.makeBy(12, (i) =>
        Arr.join(
          [
            `processor\t: ${i}`,
            'model name\t: AMD Ryzen 5 9600X 6-Core Processor',
            'physical id\t: 0',
            `core id\t: ${i % 6}`,
            'flags\t\t: fpu avx2 avx512f',
          ],
          '\n',
        ),
      ),
      '\n\n',
    ),
  );
  yield* fs.writeFileString(path.join(proc, 'meminfo'), 'MemTotal:       31968264 kB\nMemFree:        1000000 kB\n');

  const ids = path.join(root, 'pci.ids');
  yield* fs.writeFileString(ids, PCI_IDS);
  return { sysRoot: sys, procRoot: proc, ids };
});

/** `program` with the names of `PciIds` read from `files`. */
const withIds = <A, E>(
  files: ReadonlyArray<string>,
  program: Effect.Effect<A, E, PciIds | FileSystem.FileSystem | Path.Path>,
) =>
  Layer.build(PciIds.layerWith({ files })).pipe(
    Effect.flatMap((context) => Effect.provideContext(program, context)),
    Effect.scoped,
  );

/** The topology of a fake machine, names from `ids`. */
const topologyOf = (machineOf: { sysRoot: string; procRoot: string; ids: string }) =>
  withIds([machineOf.ids], readPciTopology({ sysRoot: machineOf.sysRoot, procRoot: machineOf.procRoot }));

const linkTo = (graph: TopologyGraph, to: string) =>
  Arr.findFirst(graph.links, (l) => l.to === to).pipe(Option.getOrUndefined);

layer(NodeServices.layer)('pci', (it) => {
  it.effect('readPciTopology: nodes of the reference machine', () =>
    Effect.gen(function* () {
      const g = yield* machine().pipe(Effect.flatMap(topologyOf));
      const byId = new Map(Arr.map(g.nodes, (n) => [n.id, n] as const));
      assert.deepStrictEqual(
        [...byId.keys()].sort(),
        [
          'cpu',
          'ram',
          'pci:0000:01:00.0',
          'pci:0000:02:00.0',
          'chipset:0000:04:00.0',
          'pci:0000:08:00.0',
          'pci:0000:0d:00.0',
        ].sort(),
      );

      const cpu = byId.get('cpu');
      assert.strictEqual(cpu?.kind, 'cpu');
      assert.strictEqual(cpu?.label, 'AMD Ryzen 5 9600X');
      assert.deepStrictEqual(cpu?.detail, {
        model: 'AMD Ryzen 5 9600X 6-Core Processor',
        physicalCores: 6,
        logicalThreads: 12,
        numaNodes: 1,
      });

      const ram = byId.get('ram');
      assert.strictEqual(ram?.kind, 'ram');
      assert.deepStrictEqual(ram?.detail, { totalBytes: 31968264 * 1024, dimms: 2, tempC: 29.5 });

      assert.deepStrictEqual(byId.get('pci:0000:01:00.0'), {
        id: 'pci:0000:01:00.0',
        kind: 'gpu',
        vendor: 'nvidia',
        busId: '0000:01:00.0',
        label: 'GeForce RTX 5070 Ti',
        detail: {},
      });
      assert.deepStrictEqual(byId.get('pci:0000:02:00.0'), {
        id: 'pci:0000:02:00.0',
        kind: 'nvme',
        busId: '0000:02:00.0',
        vendor: 'other',
        block: 'nvme0n1',
        label: 'KINGSTON OM8PGP41024N-A0',
        detail: { sizeBytes: 2000409264 * 512 },
      });
      assert.deepStrictEqual(byId.get('chipset:0000:04:00.0'), {
        id: 'chipset:0000:04:00.0',
        kind: 'chipset',
        label: '600 Series Chipset',
        busId: '0000:04:00.0',
        detail: {},
      });
      const radeon = byId.get('pci:0000:08:00.0');
      assert.strictEqual(radeon?.vendor, 'amd');
      assert.strictEqual(radeon?.label, 'Radeon RX 9070/9070 XT/9070 GRE');
      const igpu = byId.get('pci:0000:0d:00.0');
      assert.strictEqual(igpu?.vendor, 'amd');
      assert.strictEqual(igpu?.label, 'Radeon 610M');
    }).pipe(Effect.scoped),
  );

  it.effect('readPciTopology: links, their capacity is the smaller of both ends', () =>
    Effect.gen(function* () {
      const g = yield* machine().pipe(Effect.flatMap(topologyOf));
      const memory = linkTo(g, 'ram');
      assert.deepStrictEqual(memory, {
        id: 'cpu-ram',
        from: 'cpu',
        to: 'ram',
        kind: 'memory',
        genMax: null,
        widthMax: null,
        genCur: null,
        widthCur: null,
      });
      // Gen5 x16 card in a Gen5 x8 root port, idling at Gen1 x8.
      assert.deepStrictEqual(linkTo(g, 'pci:0000:01:00.0'), {
        id: 'cpu-pci:0000:01:00.0',
        from: 'cpu',
        to: 'pci:0000:01:00.0',
        kind: 'pcie',
        genMax: 5,
        widthMax: 8,
        genCur: 1,
        widthCur: 8,
      });
      assert.deepStrictEqual(linkTo(g, 'pci:0000:02:00.0'), {
        id: 'cpu-pci:0000:02:00.0',
        from: 'cpu',
        to: 'pci:0000:02:00.0',
        kind: 'pcie',
        genMax: 4,
        widthMax: 4,
        genCur: 4,
        widthCur: 4,
      });
      // Chipset uplink: Gen4 x4 switch in a Gen5 x4 root port.
      const uplink = linkTo(g, 'chipset:0000:04:00.0');
      assert.deepStrictEqual([uplink?.from, uplink?.kind, uplink?.genMax, uplink?.widthMax], ['cpu', 'pcie', 4, 4]);
      // The Radeon's slot link is its on-card switch's upstream port (06:00.0), plugged into the chipset's 05:00.0.
      assert.deepStrictEqual(linkTo(g, 'pci:0000:08:00.0'), {
        id: 'chipset:0000:04:00.0-pci:0000:08:00.0',
        from: 'chipset:0000:04:00.0',
        to: 'pci:0000:08:00.0',
        kind: 'pcie',
        genMax: 4,
        widthMax: 4,
        genCur: 4,
        widthCur: 4,
      });
      // No link attributes: an on-die device.
      assert.deepStrictEqual(linkTo(g, 'pci:0000:0d:00.0'), {
        id: 'cpu-pci:0000:0d:00.0',
        from: 'cpu',
        to: 'pci:0000:0d:00.0',
        kind: 'internal',
        genMax: null,
        widthMax: null,
        genCur: null,
        widthCur: null,
      });
      assert.strictEqual(g.links.length, 6);
    }).pipe(Effect.scoped),
  );

  it.effect('readPciTopology: a third-party switch or a Thunderbolt bridge is not a chipset', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bridge = (vendor: string, device: string, children: Record<string, Dev>): Dev => ({
        vendor,
        device,
        cls: '0x060400',
        link: ['8.0 GT/s PCIe', 8, '8.0 GT/s PCIe', 8],
        children,
      });
      const m = yield* machine({
        // NVMe carrier card: PLX switch in a CPU slot.
        '0000:00:03.1': bridge('0x1022', '0x14db', {
          '0000:0a:00.0': bridge('0x10b5', '0x8747', {
            '0000:0b:00.0': bridge('0x10b5', '0x8747', {
              '0000:0c:00.0': {
                vendor: '0x2646',
                device: '0x5022',
                cls: '0x010802',
                link: ['16.0 GT/s PCIe', 4, '8.0 GT/s PCIe', 4],
              },
            }),
          }),
        }),
        // eGPU behind a Thunderbolt controller whose vendor is the root port's.
        '0000:00:07.0': bridge('0x8086', '0x15ef', {
          '0000:20:00.0': bridge('0x8086', '0x15ef', {
            '0000:21:00.0': bridge('0x8086', '0x15ef', {
              '0000:22:00.0': {
                vendor: '0x10de',
                device: '0x2c05',
                cls: '0x030000',
                link: ['32.0 GT/s PCIe', 16, '8.0 GT/s PCIe', 4],
              },
            }),
          }),
        }),
      });
      // USB4 dock on an AMD root port, unknown to pci.ids: the kernel marks it removable.
      const byId = path.join(m.sysRoot, 'bus', 'pci', 'devices');
      const dock = path.join(m.sysRoot, 'devices', 'pci0000:00', '0000:00:08.3');
      yield* fs.makeDirectory(path.join(dock, '0000:30:00.0', '0000:31:00.0'), { recursive: true });
      for (const [dir, vendor, device, cls] of [
        [dock, '0x1022', '0x14dd', '0x060400'],
        [path.join(dock, '0000:30:00.0'), '0x1022', '0x1234', '0x060400'],
        [path.join(dock, '0000:30:00.0', '0000:31:00.0'), '0x2646', '0x5022', '0x010802'],
      ] as const) {
        yield* fs.writeFileString(path.join(dir, 'vendor'), `${vendor}\n`);
        yield* fs.writeFileString(path.join(dir, 'device'), `${device}\n`);
        yield* fs.writeFileString(path.join(dir, 'class'), `${cls}\n`);
      }
      yield* fs.writeFileString(path.join(dock, '0000:30:00.0', 'removable'), 'removable\n');
      yield* fs.symlink(dock, path.join(byId, '0000:00:08.3'));
      yield* fs.symlink(path.join(dock, '0000:30:00.0'), path.join(byId, '0000:30:00.0'));
      yield* fs.symlink(path.join(dock, '0000:30:00.0', '0000:31:00.0'), path.join(byId, '0000:31:00.0'));

      const g = yield* topologyOf(m);
      // Only the real chipset (AMD 600 Series under an AMD root port).
      assert.deepStrictEqual(
        Arr.map(
          Arr.filter(g.nodes, (n) => n.kind === 'chipset'),
          (n) => n.busId,
        ),
        ['0000:04:00.0'],
      );
      assert.strictEqual(linkTo(g, 'pci:0000:0c:00.0')?.from, 'cpu');
      assert.strictEqual(linkTo(g, 'pci:0000:22:00.0')?.from, 'cpu');
      assert.strictEqual(linkTo(g, 'pci:0000:31:00.0')?.from, 'cpu');
    }).pipe(Effect.scoped),
  );

  it.effect('readPciTopology: unreadable sysfs still yields CPU and RAM', () =>
    Effect.gen(function* () {
      const g = yield* withIds([], readPciTopology({ sysRoot: '/nonexistent/sys', procRoot: '/nonexistent/proc' }));
      assert.deepStrictEqual(
        Arr.map(g.nodes, (n) => n.id),
        ['cpu', 'ram'],
      );
      assert.strictEqual(g.links.length, 1);
    }),
  );

  it.effect('readPciTopology: a sleeping card reporting width 63 (config read 0xFFFF) gives an unknown width', () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const m = yield* machine();
      yield* fs.writeFileString(
        path.join(m.sysRoot, 'bus', 'pci', 'devices', '0000:01:00.0', 'current_link_width'),
        '63\n',
      );
      const g = yield* topologyOf(m);
      const link = linkTo(g, 'pci:0000:01:00.0');
      assert.deepStrictEqual([link?.widthMax, link?.widthCur], [8, null]);
    }).pipe(Effect.scoped),
  );
});

describe('pci helpers', () => {
  it('cpuLabel', () => {
    assert.strictEqual(cpuLabel('AMD Ryzen 5 9600X 6-Core Processor'), 'AMD Ryzen 5 9600X');
    assert.strictEqual(cpuLabel('Intel(R) Core(TM) i7-12700K CPU @ 3.60GHz'), 'Intel Core i7-12700K');
    assert.strictEqual(
      cpuLabel('AMD Ryzen 7 7840HS w/ Radeon 780M Graphics'),
      'AMD Ryzen 7 7840HS w/ Radeon 780M Graphics',
    );
    assert.strictEqual(cpuLabel(''), 'CPU');
  });

  it('parseLinkSpeed / minKnown / chipsetLabel', () => {
    assert.strictEqual(parseLinkSpeed('32.0 GT/s PCIe'), 5);
    assert.strictEqual(parseLinkSpeed('2.5 GT/s PCIe'), 1);
    assert.strictEqual(parseLinkSpeed('Unknown'), null);
    assert.strictEqual(minKnown(5, null), 5);
    assert.strictEqual(minKnown(0, 4), 4);
    assert.strictEqual(minKnown(5, 4), 4);
    assert.strictEqual(chipsetLabel('600 Series Chipset PCIe Switch Upstream Port'), '600 Series Chipset');
    assert.strictEqual(chipsetLabel('Z790 Chipset PCI Express Root Port'), 'Z790 Chipset');
    assert.strictEqual(chipsetLabel(null), 'Chipset');
  });

  it('findPciIdsEntry: the device line of its own vendor only, not a subsystem or a class line', () => {
    const ids = Arr.join(
      [
        '# comment',
        '1000  Broadcom',
        '\t0001  Other',
        '1002  Advanced Micro Devices, Inc. [AMD/ATI]',
        '\t7550  Navi 48 [Radeon RX 9070/9070 XT/9070 GRE]',
        '\t\t1458 2424  Subsys',
        '1003  ULSI',
        '\t2424  ULSI device',
        'ffff  Illegal Vendor ID',
        '',
        'C 00  Unclassified device',
        '\t0000  Non-VGA unclassified device',
      ],
      '\n',
    );
    assert.strictEqual(findPciIdsEntry(ids, '1002', '7550'), 'Navi 48 [Radeon RX 9070/9070 XT/9070 GRE]');
    assert.strictEqual(findPciIdsEntry(ids, '1000', '0001'), 'Other'); // vendor on the first line
    assert.strictEqual(findPciIdsEntry(ids, '1003', '2424'), 'ULSI device');
    assert.strictEqual(findPciIdsEntry(ids, '1002', '2424'), null); // another vendor's device, or a subsystem
    assert.strictEqual(findPciIdsEntry(ids, '1000', '7550'), null);
    assert.strictEqual(findPciIdsEntry(ids, 'ffff', '0000'), null); // the class section is not a device list
    assert.strictEqual(findPciIdsEntry(ids, 'abcd', '0001'), null);
  });
});

layer(NodeServices.layer)('PciIds', (it) => {
  it.effect('PciIds: a missing file is looked at again, a found name is not read twice', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-pci-ids-' });
      const file = path.join(dir, 'pci.ids');
      const program = Effect.gen(function* () {
        const ids = yield* PciIds;
        // No file yet: nothing known, and not kept.
        const missing = yield* ids.name('10de', '2c05');
        assert.deepStrictEqual(missing, Option.none());
        yield* fs.writeFileString(file, PCI_IDS);
        // The bracketed name is the one shown; `0x` and capitals are accepted.
        const bracketed = yield* ids.name('0x10DE', '2C05');
        assert.deepStrictEqual(bracketed, Option.some('GeForce RTX 5070 Ti'));
        const entry = yield* ids.entry('10de', '2c05');
        assert.deepStrictEqual(entry, Option.some('GB203 [GeForce RTX 5070 Ti]'));
        // A device the file does not list stays unknown, a name with no brackets is the whole entry.
        const unlisted = yield* ids.name('10de', 'ffff');
        assert.deepStrictEqual(unlisted, Option.none());
        const plain = yield* ids.name('1022', '43f4');
        assert.deepStrictEqual(plain, Option.some('600 Series Chipset PCIe Switch Upstream Port'));
        // Found names are kept, and so is the file: deleting it changes nothing, even for a device not asked yet.
        yield* fs.remove(file);
        const again = yield* ids.name('10de', '2c05');
        assert.deepStrictEqual(again, Option.some('GeForce RTX 5070 Ti'));
        const other = yield* ids.name('1002', '7550');
        assert.deepStrictEqual(other, Option.some('Radeon RX 9070/9070 XT/9070 GRE'));
      });
      yield* withIds([path.join(dir, 'missing.ids'), file], program);
    }).pipe(Effect.scoped),
  );
});
