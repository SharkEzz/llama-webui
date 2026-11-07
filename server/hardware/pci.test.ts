import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chipsetLabel, cpuLabel, findPciIdsEntry, minKnown, parseLinkSpeed, readPciTopology } from './pci';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

interface Dev {
  vendor: string;
  device: string;
  cls: string;
  /** `max_link_speed|max_link_width|current_link_speed|current_link_width`, absent when no link attributes. */
  link?: [string, number, string, number];
  children?: Record<string, Dev>;
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

/**
 * A fake sysfs/procfs mirroring the reference machine: two root-port GPUs and an NVMe on the CPU, a Radeon behind a
 * chipset switch (with its own on-card switch), an "internal" bridge device with no link attributes.
 */
async function machine(extra: Record<string, Dev> = {}): Promise<{ sysRoot: string; procRoot: string; ids: string }> {
  const root = mkdtempSync(join(tmpdir(), 'pci-topo-'));
  tmpDirs.push(root);
  const sys = join(root, 'sys');
  const proc = join(root, 'proc');
  const host = join(sys, 'devices', 'pci0000:00');
  const byId = join(sys, 'bus', 'pci', 'devices');
  mkdirSync(byId, { recursive: true });

  const tree: Record<string, Dev> = {
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

  const write = async (dir: string, id: string, d: Dev) => {
    const p = join(dir, id);
    mkdirSync(p, { recursive: true });
    await Bun.write(join(p, 'vendor'), `${d.vendor}\n`);
    await Bun.write(join(p, 'device'), `${d.device}\n`);
    await Bun.write(join(p, 'class'), `${d.cls}\n`);
    if (d.link) {
      await Bun.write(join(p, 'max_link_speed'), `${d.link[0]}\n`);
      await Bun.write(join(p, 'max_link_width'), `${d.link[1]}\n`);
      await Bun.write(join(p, 'current_link_speed'), `${d.link[2]}\n`);
      await Bun.write(join(p, 'current_link_width'), `${d.link[3]}\n`);
    }
    symlinkSync(p, join(byId, id));
    for (const [cid, c] of Object.entries(d.children ?? {})) await write(p, cid, c);
  };
  for (const [id, d] of Object.entries({ ...tree, ...extra })) await write(host, id, d);

  // NVMe controller and its block device.
  const ctrl = join(host, '0000:00:01.2', '0000:02:00.0', 'nvme', 'nvme0');
  mkdirSync(ctrl, { recursive: true });
  await Bun.write(join(ctrl, 'model'), 'KINGSTON OM8PGP41024N-A0                \n');
  mkdirSync(join(sys, 'block', 'nvme0n1'), { recursive: true });
  symlinkSync(ctrl, join(sys, 'block', 'nvme0n1', 'device'));
  await Bun.write(join(sys, 'block', 'nvme0n1', 'size'), '2000409264\n');
  // A loop device must be ignored.
  mkdirSync(join(sys, 'block', 'loop0'), { recursive: true });

  // DIMM temperature sensors and the CPU sensor.
  for (const [h, name, t] of [
    ['hwmon3', 'k10temp', '41375'],
    ['hwmon5', 'spd5118', '29500'],
    ['hwmon6', 'spd5118', '27750'],
  ] as const) {
    mkdirSync(join(sys, 'class', 'hwmon', h), { recursive: true });
    await Bun.write(join(sys, 'class', 'hwmon', h, 'name'), `${name}\n`);
    await Bun.write(join(sys, 'class', 'hwmon', h, 'temp1_input'), `${t}\n`);
  }
  mkdirSync(join(sys, 'devices', 'system', 'node', 'node0'), { recursive: true });

  mkdirSync(proc, { recursive: true });
  await Bun.write(
    join(proc, 'cpuinfo'),
    Array.from({ length: 12 }, (_, i) =>
      [
        `processor\t: ${i}`,
        'model name\t: AMD Ryzen 5 9600X 6-Core Processor',
        'physical id\t: 0',
        `core id\t: ${i % 6}`,
        'flags\t\t: fpu avx2 avx512f',
      ].join('\n'),
    ).join('\n\n'),
  );
  await Bun.write(join(proc, 'meminfo'), 'MemTotal:       31968264 kB\nMemFree:        1000000 kB\n');

  const ids = join(root, 'pci.ids');
  await Bun.write(ids, PCI_IDS);
  return { sysRoot: sys, procRoot: proc, ids };
}

test('readPciTopology: nodes of the reference machine', async () => {
  const { sysRoot, procRoot, ids } = await machine();
  const g = await readPciTopology({ sysRoot, procRoot, pciIds: [ids] });

  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  expect([...byId.keys()].sort()).toEqual(
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

  const cpu = byId.get('cpu')!;
  expect(cpu.kind).toBe('cpu');
  expect(cpu.label).toBe('AMD Ryzen 5 9600X');
  expect(cpu.detail.model).toBe('AMD Ryzen 5 9600X 6-Core Processor');
  expect(cpu.detail).toMatchObject({ physicalCores: 6, logicalThreads: 12, numaNodes: 1 });

  const ram = byId.get('ram')!;
  expect(ram.kind).toBe('ram');
  expect(ram.detail).toMatchObject({ totalBytes: 31968264 * 1024, dimms: 2, tempC: 29.5 });

  const nv = byId.get('pci:0000:01:00.0')!;
  expect(nv).toMatchObject({ kind: 'gpu', vendor: 'nvidia', busId: '0000:01:00.0', label: 'GeForce RTX 5070 Ti' });

  const ssd = byId.get('pci:0000:02:00.0')!;
  expect(ssd).toMatchObject({
    kind: 'nvme',
    busId: '0000:02:00.0',
    block: 'nvme0n1',
    label: 'KINGSTON OM8PGP41024N-A0',
  });
  expect(ssd.detail).toMatchObject({ sizeBytes: 2000409264 * 512 });

  expect(byId.get('chipset:0000:04:00.0')).toMatchObject({ kind: 'chipset', label: '600 Series Chipset' });
  expect(byId.get('pci:0000:08:00.0')).toMatchObject({
    kind: 'gpu',
    vendor: 'amd',
    label: 'Radeon RX 9070/9070 XT/9070 GRE',
  });
  expect(byId.get('pci:0000:0d:00.0')).toMatchObject({ kind: 'gpu', vendor: 'amd', label: 'Radeon 610M' });
});

test('readPciTopology: links, their capacity is the smaller of both ends', async () => {
  const { sysRoot, procRoot, ids } = await machine();
  const g = await readPciTopology({ sysRoot, procRoot, pciIds: [ids] });
  const link = (to: string) => g.links.find((l) => l.to === to)!;

  expect(link('ram')).toMatchObject({ from: 'cpu', kind: 'memory', genMax: null, widthMax: null });
  // Gen5 x16 card in a Gen5 x8 root port, idling at Gen1 x8.
  expect(link('pci:0000:01:00.0')).toMatchObject({
    from: 'cpu',
    kind: 'pcie',
    genMax: 5,
    widthMax: 8,
    genCur: 1,
    widthCur: 8,
  });
  expect(link('pci:0000:02:00.0')).toMatchObject({ from: 'cpu', kind: 'pcie', genMax: 4, widthMax: 4, genCur: 4 });
  // Chipset uplink: Gen4 x4 switch in a Gen5 x4 root port.
  expect(link('chipset:0000:04:00.0')).toMatchObject({ from: 'cpu', kind: 'pcie', genMax: 4, widthMax: 4 });
  // The Radeon's slot link is its on-card switch's upstream port (06:00.0), plugged into the chipset's 05:00.0.
  expect(link('pci:0000:08:00.0')).toMatchObject({
    from: 'chipset:0000:04:00.0',
    kind: 'pcie',
    genMax: 4,
    widthMax: 4,
    genCur: 4,
    widthCur: 4,
  });
  // No link attributes: an on-die device.
  expect(link('pci:0000:0d:00.0')).toMatchObject({ from: 'cpu', kind: 'internal', genMax: null, genCur: null });
  expect(g.links).toHaveLength(6);
});

test('readPciTopology: a third-party switch or a Thunderbolt bridge is not a chipset', async () => {
  const bridge = (vendor: string, device: string, children: Record<string, Dev>): Dev => ({
    vendor,
    device,
    cls: '0x060400',
    link: ['8.0 GT/s PCIe', 8, '8.0 GT/s PCIe', 8],
    children,
  });
  const { sysRoot, procRoot, ids } = await machine({
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
  const dock = join(sysRoot, 'devices', 'pci0000:00', '0000:00:08.3');
  mkdirSync(join(dock, '0000:30:00.0', '0000:31:00.0'), { recursive: true });
  for (const [dir, vendor, device, cls] of [
    [dock, '0x1022', '0x14dd', '0x060400'],
    [join(dock, '0000:30:00.0'), '0x1022', '0x1234', '0x060400'],
    [join(dock, '0000:30:00.0', '0000:31:00.0'), '0x2646', '0x5022', '0x010802'],
  ] as const) {
    await Bun.write(join(dir, 'vendor'), `${vendor}\n`);
    await Bun.write(join(dir, 'device'), `${device}\n`);
    await Bun.write(join(dir, 'class'), `${cls}\n`);
  }
  await Bun.write(join(dock, '0000:30:00.0', 'removable'), 'removable\n');
  const byId = join(sysRoot, 'bus', 'pci', 'devices');
  symlinkSync(dock, join(byId, '0000:00:08.3'));
  symlinkSync(join(dock, '0000:30:00.0'), join(byId, '0000:30:00.0'));
  symlinkSync(join(dock, '0000:30:00.0', '0000:31:00.0'), join(byId, '0000:31:00.0'));

  const g = await readPciTopology({ sysRoot, procRoot, pciIds: [ids] });
  // Only the real chipset (AMD 600 Series under an AMD root port).
  expect(g.nodes.filter((n) => n.kind === 'chipset').map((n) => n.busId)).toEqual(['0000:04:00.0']);
  expect(g.links.find((l) => l.to === 'pci:0000:0c:00.0')?.from).toBe('cpu');
  expect(g.links.find((l) => l.to === 'pci:0000:22:00.0')?.from).toBe('cpu');
  expect(g.links.find((l) => l.to === 'pci:0000:31:00.0')?.from).toBe('cpu');
});

test('readPciTopology: unreadable sysfs still yields CPU and RAM', async () => {
  const g = await readPciTopology({ sysRoot: '/nonexistent/sys', procRoot: '/nonexistent/proc', pciIds: [] });
  expect(g.nodes.map((n) => n.id)).toEqual(['cpu', 'ram']);
  expect(g.links).toHaveLength(1);
});

test('cpuLabel', () => {
  expect(cpuLabel('AMD Ryzen 5 9600X 6-Core Processor')).toBe('AMD Ryzen 5 9600X');
  expect(cpuLabel('Intel(R) Core(TM) i7-12700K CPU @ 3.60GHz')).toBe('Intel Core i7-12700K');
  expect(cpuLabel('AMD Ryzen 7 7840HS w/ Radeon 780M Graphics')).toBe('AMD Ryzen 7 7840HS w/ Radeon 780M Graphics');
  expect(cpuLabel('')).toBe('CPU');
});

test('readPciTopology: a sleeping card reporting width 63 (config read 0xFFFF) gives an unknown width', async () => {
  const { sysRoot, procRoot, ids } = await machine();
  await Bun.write(join(sysRoot, 'bus', 'pci', 'devices', '0000:01:00.0', 'current_link_width'), '63\n');
  const g = await readPciTopology({ sysRoot, procRoot, pciIds: [ids] });
  expect(g.links.find((l) => l.to === 'pci:0000:01:00.0')).toMatchObject({ widthMax: 8, widthCur: null });
});

test('parseLinkSpeed / minKnown / chipsetLabel', () => {
  expect(parseLinkSpeed('32.0 GT/s PCIe')).toBe(5);
  expect(parseLinkSpeed('2.5 GT/s PCIe')).toBe(1);
  expect(parseLinkSpeed('Unknown')).toBeNull();
  expect(minKnown(5, null)).toBe(5);
  expect(minKnown(0, 4)).toBe(4);
  expect(minKnown(5, 4)).toBe(4);
  expect(chipsetLabel('600 Series Chipset PCIe Switch Upstream Port')).toBe('600 Series Chipset');
  expect(chipsetLabel('Z790 Chipset PCI Express Root Port')).toBe('Z790 Chipset');
  expect(chipsetLabel(null)).toBe('Chipset');
});

test('findPciIdsEntry: the device line of its own vendor only, not a subsystem or a class line', () => {
  const ids = [
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
  ].join('\n');
  expect(findPciIdsEntry(ids, '1002', '7550')).toBe('Navi 48 [Radeon RX 9070/9070 XT/9070 GRE]');
  expect(findPciIdsEntry(ids, '1000', '0001')).toBe('Other'); // vendor on the first line
  expect(findPciIdsEntry(ids, '1003', '2424')).toBe('ULSI device');
  expect(findPciIdsEntry(ids, '1002', '2424')).toBeNull(); // another vendor's device, or a subsystem
  expect(findPciIdsEntry(ids, '1000', '7550')).toBeNull();
  expect(findPciIdsEntry(ids, 'ffff', '0000')).toBeNull(); // the class section is not a device list
  expect(findPciIdsEntry(ids, 'abcd', '0001')).toBeNull();
});
