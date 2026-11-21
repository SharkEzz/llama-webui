import type {
  BenchDevice,
  Check,
  CheckFamily,
  CpuInfo,
  DiskSpeed,
  Estimate,
  GpuSample,
  MemInfo,
} from '@llama-webui/shared';
import type { ModelInfo } from '../models/gguf';
import { fmtBytes, GiB } from './memory';
import type { SysReadings } from './sysinfo';

export type { Check };

export interface CheckContext {
  readings: SysReadings;
  gpus: GpuSample[];
  /** Bus ids of the cards llama-server will run on. */
  retainedBusIds: string[];
  devices: BenchDevice[];
  cpu: CpuInfo;
  model: ModelInfo | null;
  estimate: Estimate | null;
  mem: MemInfo | null;
  /** Latest sequential-read measurement of the model's disk. */
  diskSpeed: DiskSpeed | null;
  now: number;
}

/** Below this, a model that spills out of RAM is bound by the disk. */
const DISK_OK_BPS = 2 * GiB;

const NA = 'not applicable (card ignored)';
/** Below this GPU use, a card counts as idle: its PCIe link may be trained down (power saving). */
const IDLE_UTIL_PCT = 10;
const OLD_BUILD_MS = 60 * 86400_000;
const NETWORK_FS = /^(nfs|nfs4|cifs|smb3?|fuse|sshfs|9p|afs|ceph|glusterfs)/;

const pcieLabel = (gen: number | null | undefined, width: number | null | undefined) =>
  `x${width ?? '?'} Gen${gen ?? '?'}`;

export function runChecks(ctx: CheckContext): Check[] {
  const { readings: r, estimate } = ctx;
  const out: Check[] = [];
  const push = (c: Check) => out.push(c);
  const retained = (bus: string) => ctx.retainedBusIds.includes(bus);
  const overflow = (estimate?.ok ?? false) && (estimate?.params.ngl !== 'all' || !!estimate?.params.ncmoe);
  const nvidia = ctx.gpus.filter((g) => g.vendor === 'nvidia');
  const amd = ctx.gpus.filter((g) => g.vendor === 'amd');

  const pcie = (family: CheckFamily, g: GpuSample) => {
    const id = `${family}.pcie.${g.busId}`;
    const label = `PCIe link ${g.name}`;
    const impact = 'slower loading and CPU↔GPU offload';
    if (g.pcieGenMax == null || g.pcieWidthMax == null)
      return push({ id, family, label, state: 'unknown', detail: 'unknown PCIe link', impact });
    if (g.pcieGen == null || g.pcieWidth == null)
      return push({
        id,
        family,
        label,
        state: 'unknown',
        detail: 'measured under load: start the server first',
        impact,
      });
    const below =
      (g.pcieGen as number) < (g.pcieGenMax as number) || (g.pcieWidth as number) < (g.pcieWidthMax as number);
    // An idle link trains down to save power (ASPM): below its maximum, it only says something under load (#36).
    if (below && (g.utilPct ?? 0) < IDLE_UTIL_PCT)
      return push({
        id,
        family,
        label,
        state: 'unknown',
        detail: `${pcieLabel(g.pcieGen, g.pcieWidth)} while idle (max ${pcieLabel(g.pcieGenMax, g.pcieWidthMax)}): measured under load`,
        impact,
      });
    push({
      id,
      family,
      label,
      state: below ? 'warn' : 'ok',
      detail: `${pcieLabel(g.pcieGen, g.pcieWidth)} (max ${pcieLabel(g.pcieGenMax, g.pcieWidthMax)})${below ? ': check the slot, riser or BIOS' : ''}`,
      persistence: below ? 'permanent' : undefined,
      impact,
    });
  };

  if (nvidia.length > 0) {
    for (const g of nvidia) {
      const bus = g.busId;
      const on = retained(bus);
      // nvidia-smi's own index need not match ours (sorted by bus id): the UUID names the card unambiguously.
      const smiId = g.key.startsWith('nvidia:') ? g.key.slice('nvidia:'.length) : bus;
      // persistence
      {
        const id = `nvidia.persistence.${bus}`;
        const label = `Persistence ${g.name}`;
        const impact = 'slower first load and card wake-up';
        if (!on) push({ id, family: 'nvidia', label, state: 'na', detail: NA, impact });
        else if (g.persistence == null)
          push({ id, family: 'nvidia', label, state: 'unknown', detail: 'not reported by NVML', impact });
        else if (g.persistence) push({ id, family: 'nvidia', label, state: 'ok', detail: 'enabled', impact });
        else
          push({
            id,
            family: 'nvidia',
            label,
            state: 'warn',
            detail: 'disabled',
            command: `sudo nvidia-smi -i ${smiId} -pm 1`,
            persistence: 'session',
            impact,
          });
      }
      // power limit
      {
        const id = `nvidia.powerlimit.${bus}`;
        const label = `Power limit ${g.name}`;
        const impact = 'clocks capped under load';
        if (!on) push({ id, family: 'nvidia', label, state: 'na', detail: NA, impact });
        else if (g.powerLimitW == null || g.powerDefaultLimitW == null)
          push({ id, family: 'nvidia', label, state: 'unknown', detail: 'unknown limit', impact });
        else if (g.powerLimitW < g.powerDefaultLimitW - 1)
          push({
            id,
            family: 'nvidia',
            label,
            state: 'warn',
            detail: `${Math.round(g.powerLimitW)} W, default ${Math.round(g.powerDefaultLimitW)} W`,
            command: `sudo nvidia-smi -i ${smiId} -pl ${Math.round(g.powerDefaultLimitW)}`,
            persistence: 'session',
            impact,
          });
        else
          push({
            id,
            family: 'nvidia',
            label,
            state: 'ok',
            detail: `${Math.round(g.powerLimitW)} W (default)`,
            impact,
          });
      }
      pcie('nvidia', g);
      // resizable BAR
      {
        const id = `nvidia.rebar.${bus}`;
        const label = `Resizable BAR ${g.name}`;
        const impact = 'host→VRAM transfers through a 256 MiB window';
        const bar = r.bar1Bytes[bus];
        if (bar === undefined || g.vramTotalBytes <= 0)
          push({ id, family: 'nvidia', label, state: 'unknown', detail: 'unknown BAR1 size', impact });
        else if (bar < g.vramTotalBytes)
          push({
            id,
            family: 'nvidia',
            label,
            state: 'warn',
            detail: `BAR1 ${fmtBytes(bar)} < VRAM ${fmtBytes(g.vramTotalBytes)}: enable Resizable BAR / Above 4G decoding in the BIOS`,
            persistence: 'permanent',
            impact,
          });
        else push({ id, family: 'nvidia', label, state: 'ok', detail: `BAR1 ${fmtBytes(bar)}`, impact });
      }
    }
    {
      const id = 'nvidia.driver';
      const label = 'NVIDIA driver';
      const impact = 'the build’s CUDA backend fails to start';
      const cuda =
        r.cudaDriver == null
          ? ''
          : `, CUDA ${Math.floor(r.cudaDriver / 1000)}.${Math.floor((r.cudaDriver % 1000) / 10)}`;
      if (r.cudaDriverError)
        push({
          id,
          family: 'nvidia',
          label,
          state: 'warn',
          detail: `too old for the build’s CUDA (driver ${r.driver ?? '?'}${cuda}): update the driver`,
          persistence: 'permanent',
          impact,
        });
      else if (r.driver === null)
        push({ id, family: 'nvidia', label, state: 'unknown', detail: 'unknown version', impact });
      else push({ id, family: 'nvidia', label, state: 'ok', detail: `driver ${r.driver}${cuda}`, impact });
    }
    {
      const id = 'nvidia.uvm';
      const label = 'Module nvidia_uvm';
      const impact = 'CUDA fails to initialize';
      if (r.modules.length === 0)
        push({ id, family: 'nvidia', label, state: 'unknown', detail: '/proc/modules unreadable', impact });
      else if (r.modules.includes('nvidia_uvm'))
        push({ id, family: 'nvidia', label, state: 'ok', detail: 'loaded', impact });
      else
        push({
          id,
          family: 'nvidia',
          label,
          state: 'warn',
          detail: 'missing',
          command: 'sudo modprobe nvidia_uvm',
          persistence: 'session',
          impact,
        });
    }
  }

  if (amd.length > 0) {
    const anyRetained = amd.some((g) => retained(g.busId));
    for (const g of amd) {
      const id = `amd.dpm.${g.busId}`;
      const label = `DPM level ${g.name}`;
      const impact = 'clocks fluctuate under load';
      const dpm = r.amdDpm[g.busId];
      if (!retained(g.busId)) push({ id, family: 'amd', label, state: 'na', detail: NA, impact });
      else if (!dpm)
        push({
          id,
          family: 'amd',
          label,
          state: 'unknown',
          detail: 'power_dpm_force_performance_level unreadable',
          impact,
        });
      else if (dpm.level === 'auto')
        push({
          id,
          family: 'amd',
          label,
          state: 'warn',
          detail: 'auto',
          command: `echo high | sudo tee ${dpm.path}`,
          persistence: 'session',
          impact,
        });
      else push({ id, family: 'amd', label, state: 'ok', detail: dpm.level, impact });
      pcie('amd', g);
    }
    {
      const id = 'amd.hip';
      const label = 'Backend ROCm/HIP';
      const impact = 'the AMD card runs on Vulkan, slower';
      if (!anyRetained) push({ id, family: 'amd', label, state: 'na', detail: NA, impact });
      else if (r.backendLibs.length === 0)
        push({ id, family: 'amd', label, state: 'unknown', detail: 'build libraries not found', impact });
      else if (r.backendLibs.some((l) => l.startsWith('libggml-hip')))
        push({ id, family: 'amd', label, state: 'ok', detail: 'present', impact });
      else
        push({
          id,
          family: 'amd',
          label,
          state: 'warn',
          detail: 'missing: rebuild llama.cpp with -DGGML_HIP=ON, otherwise Vulkan',
          persistence: 'permanent',
          impact,
        });
    }
    {
      const id = 'amd.rocm-gfx';
      const label = 'Card recognized by ROCm';
      const impact = 'HIP rejects the card without HSA_OVERRIDE_GFX_VERSION';
      if (!anyRetained) push({ id, family: 'amd', label, state: 'na', detail: NA, impact });
      else
        push({
          id,
          family: 'amd',
          label,
          state: 'unknown',
          detail: 'rocminfo not queried: if HIP rejects the card, add HSA_OVERRIDE_GFX_VERSION=… to the profile env',
          impact,
        });
    }
  }

  // CPU / memory
  {
    const id = 'cpu.governor';
    const label = 'CPU governor';
    const impact = 'slower prompt processing and CPU offload';
    const bad = r.governors.filter((g) => g !== 'performance');
    if (r.governors.length === 0)
      push({ id, family: 'cpu', label, state: 'unknown', detail: 'cpufreq unreadable', impact });
    else if (bad.length === 0) push({ id, family: 'cpu', label, state: 'ok', detail: 'performance', impact });
    else
      push({
        id,
        family: 'cpu',
        label,
        state: 'warn',
        detail: bad[0]!,
        command: 'echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor',
        persistence: 'session',
        impact,
      });
  }
  {
    const id = 'cpu.thp';
    const label = 'Transparent hugepages';
    const impact = 'slower access to weights in RAM';
    if (r.thp === null) push({ id, family: 'cpu', label, state: 'unknown', detail: 'unreadable', impact });
    else if (r.thp === 'never')
      push({
        id,
        family: 'cpu',
        label,
        state: 'warn',
        detail: 'never; permanent: transparent_hugepage=madvise on the kernel cmdline',
        command: 'echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/enabled',
        persistence: 'session',
        impact,
      });
    else push({ id, family: 'cpu', label, state: 'ok', detail: r.thp, impact });
  }
  {
    const id = 'cpu.memlock';
    const label = 'memlock limit';
    const impact = '--mlock fails, weights can be evicted';
    const wantsMlock = estimate?.serverArgs.includes('--mlock') ?? false;
    const need = ctx.model?.fileBytes ?? 0;
    if (!wantsMlock) push({ id, family: 'cpu', label, state: 'ok', detail: '--mlock not recommended here', impact });
    else if (r.memlockLimitBytes === null)
      push({ id, family: 'cpu', label, state: 'unknown', detail: 'unreadable', impact });
    else if (r.memlockLimitBytes < need)
      push({
        id,
        family: 'cpu',
        label,
        state: 'warn',
        detail: `${fmtBytes(r.memlockLimitBytes)} < model ${fmtBytes(need)}; permanent: /etc/security/limits.conf`,
        command: 'ulimit -l unlimited',
        persistence: 'session',
        impact,
      });
    else
      push({
        id,
        family: 'cpu',
        label,
        state: 'ok',
        detail: r.memlockLimitBytes === Number.POSITIVE_INFINITY ? 'unlimited' : fmtBytes(r.memlockLimitBytes),
        impact,
      });
  }
  {
    const id = 'cpu.swappiness';
    const label = 'vm.swappiness';
    const impact = 'weights in RAM get swapped out';
    if (r.swappiness === null) push({ id, family: 'cpu', label, state: 'unknown', detail: 'unreadable', impact });
    else if (overflow && r.swappiness > 10)
      push({
        id,
        family: 'cpu',
        label,
        state: 'warn',
        detail: `${r.swappiness} while the model spills into RAM; permanent: /etc/sysctl.d/`,
        command: 'sudo sysctl vm.swappiness=10',
        persistence: 'session',
        impact,
      });
    else push({ id, family: 'cpu', label, state: 'ok', detail: String(r.swappiness), impact });
  }
  {
    const id = 'cpu.numa';
    const label = 'NUMA nodes';
    const impact = 'remote memory accesses';
    if (ctx.cpu.numaNodes <= 1) push({ id, family: 'cpu', label, state: 'ok', detail: 'single node', impact });
    else if (estimate?.serverArgs.includes('--numa'))
      push({
        id,
        family: 'cpu',
        label,
        state: 'ok',
        detail: `${ctx.cpu.numaNodes} nodes, --numa distribute recommended`,
        impact,
      });
    else
      push({
        id,
        family: 'cpu',
        label,
        state: 'warn',
        detail: `${ctx.cpu.numaNodes} nodes without --numa: add --numa distribute to the profile`,
        persistence: 'permanent',
        impact,
      });
  }

  // Build llama.cpp
  {
    const id = 'build.cuda';
    const label = 'Backend CUDA';
    const impact = 'NVIDIA cards go unused';
    const cudaListed = ctx.devices.some((d) => d.backend === 'CUDA');
    if (cudaListed) push({ id, family: 'build', label, state: 'ok', detail: 'present', impact });
    else if (nvidia.length === 0) push({ id, family: 'build', label, state: 'ok', detail: 'no NVIDIA card', impact });
    else if (r.backendLibs.length === 0)
      push({ id, family: 'build', label, state: 'unknown', detail: 'build libraries not found', impact });
    else if (r.backendLibs.some((l) => l.startsWith('libggml-cuda')))
      push({ id, family: 'build', label, state: 'ok', detail: 'present', impact });
    else
      push({
        id,
        family: 'build',
        label,
        state: 'warn',
        detail: 'missing: rebuild llama.cpp with -DGGML_CUDA=ON',
        persistence: 'permanent',
        impact,
      });
  }
  {
    const id = 'build.simd';
    const label = 'Build SIMD instructions';
    const impact = 'slower CPU compute';
    const want = ['AVX2', 'AVX512'].filter((f) => ctx.cpu.flags.includes(f === 'AVX2' ? 'avx2' : 'avx512f'));
    if (r.systemInfo === null)
      push({
        id,
        family: 'build',
        label,
        state: 'unknown',
        detail: 'no system_info in the logs: start the server first',
        impact,
      });
    else {
      const missing = want.filter((f) => !new RegExp(`\\b${f} = 1\\b`).test(r.systemInfo as string));
      if (missing.length === 0)
        push({ id, family: 'build', label, state: 'ok', detail: want.join(', ') || 'none', impact });
      else
        push({
          id,
          family: 'build',
          label,
          state: 'warn',
          detail: `${missing.join(', ')} available but unused: rebuild with -DGGML_NATIVE=ON`,
          persistence: 'permanent',
          impact,
        });
    }
  }
  {
    const id = 'build.age';
    const label = 'Build age';
    const impact = 'missing recent optimizations and fixes';
    if (r.buildDate === null)
      push({ id, family: 'build', label, state: 'unknown', detail: 'unknown date (no git repository)', impact });
    else {
      const days = Math.floor((ctx.now - r.buildDate) / 86400_000);
      if (ctx.now - r.buildDate > OLD_BUILD_MS)
        push({
          id,
          family: 'build',
          label,
          state: 'warn',
          detail: `${days} ${days === 1 ? 'day' : 'days'}`,
          command: 'git pull && cmake --build build',
          persistence: 'permanent',
          impact,
        });
      else push({ id, family: 'build', label, state: 'ok', detail: `${days} ${days === 1 ? 'day' : 'days'}`, impact });
    }
  }

  // Kernel / disk
  {
    const id = 'kernel.iommu';
    const label = 'IOMMU';
    const impact = 'slower copies between cards';
    const pt =
      /\biommu=pt\b/.test(r.cmdline) || /\bamd_iommu=off\b/.test(r.cmdline) || /\bintel_iommu=off\b/.test(r.cmdline);
    if (r.iommuActive === null)
      push({ id, family: 'kernel', label, state: 'unknown', detail: '/sys/class/iommu unreadable', impact });
    else if (!r.iommuActive || pt)
      push({ id, family: 'kernel', label, state: 'ok', detail: r.iommuActive ? 'passthrough' : 'inactive', impact });
    else if (ctx.retainedBusIds.length < 2)
      push({ id, family: 'kernel', label, state: 'ok', detail: 'active, single card', impact });
    else
      push({
        id,
        family: 'kernel',
        label,
        state: 'warn',
        detail: 'active without passthrough: add iommu=pt to the kernel cmdline (reboot)',
        persistence: 'permanent',
        impact,
      });
  }
  {
    const id = 'kernel.disk';
    const label = 'Model disk';
    const impact = 'slow loading';
    const d = r.modelDisk;
    if (d === null) push({ id, family: 'kernel', label, state: 'unknown', detail: 'unknown', impact });
    else if (d.rotational === true)
      push({
        id,
        family: 'kernel',
        label,
        state: 'warn',
        detail: 'spinning disk: move the model to a local SSD',
        persistence: 'permanent',
        impact,
      });
    else if (d.fsType && NETWORK_FS.test(d.fsType))
      push({
        id,
        family: 'kernel',
        label,
        state: 'warn',
        detail: `${d.fsType}: move the model to a local SSD`,
        persistence: 'permanent',
        impact,
      });
    else
      push({
        id,
        family: 'kernel',
        label,
        state: 'ok',
        detail: `${d.fsType ?? '?'}${d.rotational === false ? ', SSD' : ''}`,
        impact,
      });
  }
  {
    const id = 'kernel.disk-speed';
    const label = 'Model disk bandwidth';
    const impact = 'a model that spills out of RAM reads the disk on every token';
    const d = ctx.diskSpeed;
    if (!d)
      push({
        id,
        family: 'kernel',
        label,
        state: 'unknown',
        detail: 'not measured: “Measure disk” button',
        impact,
      });
    else if (d.bytesPerSec < DISK_OK_BPS)
      push({
        id,
        family: 'kernel',
        label,
        state: 'warn',
        detail: `sequential read ${fmtBytes(d.bytesPerSec)}/s${overflow ? ' while the model spills over' : ''}`,
        impact,
      });
    else
      push({
        id,
        family: 'kernel',
        label,
        state: 'ok',
        detail: `sequential read ${fmtBytes(d.bytesPerSec)}/s`,
        impact,
      });
  }
  {
    const id = 'kernel.swap';
    const label = 'Swap';
    const impact = 'stuttering generation';
    if (ctx.mem === null) push({ id, family: 'kernel', label, state: 'unknown', detail: 'unknown memory', impact });
    else if (overflow && ctx.mem.swapUsedBytes > 0)
      push({
        id,
        family: 'kernel',
        label,
        state: 'warn',
        detail: `${fmtBytes(ctx.mem.swapUsedBytes)} used while the model spills over: lower -c or raise --n-cpu-moe`,
        impact,
      });
    else
      push({
        id,
        family: 'kernel',
        label,
        state: 'ok',
        detail: ctx.mem.swapUsedBytes > 0 ? `${fmtBytes(ctx.mem.swapUsedBytes)} used` : 'unused',
        impact,
      });
  }

  return out;
}

export function summarize(checks: Check[]): { warn: number; ok: number; unknown: number; na: number } {
  const s = { warn: 0, ok: 0, unknown: 0, na: 0 };
  for (const c of checks) s[c.state]++;
  return s;
}
