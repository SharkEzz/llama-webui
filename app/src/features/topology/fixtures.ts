import type { TopologyGraph, TopologyLink, TopologyNode } from '@llama-webui/shared';

/* Hardware graphs for the tests of the placements and of the streaks: the shapes a machine can have. */

export interface MachineOptions {
  /** GPUs on the CPU's root ports. */
  cpuGpus?: number;
  /** NVMe drives on the CPU's root ports. */
  cpuNvme?: number;
  /** One entry per chipset: what sits behind it. */
  chipsets?: readonly { gpus?: number; nvme?: number }[];
  /** GPUs inside the CPU (an `internal` link). */
  integrated?: number;
  /** Blocks that no link reaches. */
  loose?: number;
  dimms?: number | null;
  threads?: number;
  ram?: boolean;
  cpu?: boolean;
}

const pcie = (id: string, from: string, to: string): TopologyLink => ({
  id,
  from,
  to,
  kind: 'pcie',
  genMax: 4,
  widthMax: 4,
  genCur: 4,
  widthCur: 4,
});

export function machine(o: MachineOptions = {}): TopologyGraph {
  const nodes: TopologyNode[] = [];
  const links: TopologyLink[] = [];
  let bus = 0;
  const next = () => `0000:${(++bus).toString(16).padStart(2, '0')}:00.0`;
  const device = (kind: 'gpu' | 'nvme', from: string | null, n: number) => {
    const busId = next();
    const id = `pci:${busId}`;
    nodes.push(
      kind === 'gpu'
        ? { id, kind, label: `GPU ${n}`, busId, vendor: 'nvidia', detail: {} }
        : { id, kind, label: `Drive ${n}`, busId, block: `nvme${n}n1`, detail: {} },
    );
    if (from) links.push(pcie(`l:${busId}`, from, id));
    return id;
  };

  if (o.cpu !== false)
    nodes.push({
      id: 'cpu',
      kind: 'cpu',
      label: 'Processor',
      detail: { physicalCores: (o.threads ?? 12) / 2, logicalThreads: o.threads ?? 12, numaNodes: 1 },
    });
  if (o.ram !== false) {
    nodes.push({ id: 'ram', kind: 'ram', label: 'Memory', detail: { dimms: o.dimms === undefined ? 2 : o.dimms } });
    if (o.cpu !== false)
      links.push({
        id: 'cpu-ram',
        from: 'cpu',
        to: 'ram',
        kind: 'memory',
        genMax: null,
        widthMax: null,
        genCur: null,
        widthCur: null,
      });
  }
  let gpus = 0;
  let drives = 0;
  for (let i = 0; i < (o.cpuGpus ?? 0); i++) device('gpu', 'cpu', gpus++);
  for (let i = 0; i < (o.cpuNvme ?? 0); i++) device('nvme', 'cpu', drives++);
  for (const behind of o.chipsets ?? []) {
    const busId = next();
    const id = `chipset:${busId}`;
    nodes.push({ id, kind: 'chipset', label: 'Chipset', busId, detail: {} });
    links.push(pcie(`l:${busId}`, 'cpu', id));
    for (let i = 0; i < (behind.gpus ?? 0); i++) device('gpu', id, gpus++);
    for (let i = 0; i < (behind.nvme ?? 0); i++) device('nvme', id, drives++);
  }
  for (let i = 0; i < (o.integrated ?? 0); i++) {
    const id = device('gpu', null, gpus++);
    links.push({
      ...pcie(`l:${id}`, 'cpu', id),
      kind: 'internal',
      genMax: null,
      widthMax: null,
      genCur: null,
      widthCur: null,
    });
  }
  for (let i = 0; i < (o.loose ?? 0); i++) device('gpu', null, gpus++);
  return { at: 0, nodes, links };
}

export const NONE = machine();
export const ONE = machine({ cpuGpus: 1, cpuNvme: 1 });
/** Two GPUs on the CPU, one behind the chipset, an integrated one, one drive. */
export const MINE = machine({ cpuGpus: 2, cpuNvme: 1, chipsets: [{ gpus: 1 }], integrated: 1 });
export const FOUR = machine({ cpuGpus: 4, cpuNvme: 1, chipsets: [{ nvme: 1 }], dimms: 4, threads: 32 });
export const TWO_NVME = machine({ cpuGpus: 1, cpuNvme: 2, chipsets: [{ nvme: 2 }] });
export const TWO_CHIPSETS = machine({
  cpuGpus: 2,
  chipsets: [
    { gpus: 2, nvme: 1 },
    { gpus: 1, nvme: 2 },
  ],
});
export const LOOSE = machine({ cpuGpus: 1, loose: 1 });
export const LARGE = machine({
  cpuGpus: 4,
  cpuNvme: 2,
  chipsets: [{ gpus: 2, nvme: 2 }],
  integrated: 1,
  dimms: 8,
  threads: 32,
});
export const NO_RAM = machine({ cpuGpus: 1, ram: false });
export const NO_CPU = machine({ cpuGpus: 1, cpuNvme: 1, cpu: false });
/** No count of memory modules, an empty chipset, two integrated GPUs. */
export const ODD = machine({ chipsets: [{}], integrated: 2, dimms: null, cpuNvme: 4 });

export const MACHINES = { NONE, ONE, MINE, FOUR, TWO_NVME, TWO_CHIPSETS, LOOSE, LARGE, NO_RAM, NO_CPU, ODD };
