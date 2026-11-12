import type { Settings } from '@llama-webui/shared';
import { type AmdCard, discoverAmdCards, isRuntimeSuspended, readAmdCard, readProcAmdVram } from './amdgpu';
import { type DiskSample, DiskSampler, physicalDisks, resolveModelDisk } from './disk';
import type { GpuReading } from './gpu';
import { MemBandwidthSampler } from './membw';
import { gpuNeeds } from './needs';
import { NvidiaMonitor } from './nvidia';
import { NvmlMonitor } from './nvml/monitor';
import { ProcSampler } from './proc';
import { type SystemSample, SystemSampler } from './system';

/** The settings the collectors depend on. */
export type CollectorSettings = Pick<Settings, 'collectors' | 'pollIntervalMs' | 'hiddenGpus'>;

export interface AmdSource {
  cards: () => AmdCard[];
  read: (c: AmdCard) => Promise<GpuReading>;
  /** Process VRAM per card; descriptors open on `skipNodes` (cards not to read) are ignored. */
  procVram: (pid: number, skipNodes: ReadonlySet<string>) => Promise<Map<string, number>>;
  /** Suspended cards: listed but never read, so as not to wake them up. */
  suspended: (c: AmdCard) => Promise<boolean>;
}

export interface SystemSource {
  sample(): Promise<SystemSample | null>;
}

export interface DiskSource {
  sample(modelDisk: string | null): Promise<DiskSample | null>;
  resolveModelDisk(path: string): Promise<string | null>;
}

/** nvidia-smi binary for the fallback (LLAMA_WEBUI_NVIDIA_SMI to test it missing). */
const nvidiaSmiBin = () => process.env.LLAMA_WEBUI_NVIDIA_SMI || 'nvidia-smi';
/** NVML library for the worker (LLAMA_WEBUI_NVML_LIB to test it missing); the system's when unset. */
const nvmlLib = () => process.env.LLAMA_WEBUI_NVML_LIB || undefined;

/**
 * Hardware collectors (copied from llama-tui): NVIDIA through NVML in a Worker (nvidia-smi fallback), AMD through sysfs,
 * the server process, and CPU/memory and disks depending on their switch. configure() follows the settings,
 * except the NVML / nvidia-smi choice, made once at startup.
 */
export class Collectors {
  private _system: SystemSource | undefined;
  private _disk: DiskSource | undefined;
  private _memBw: MemBandwidthSampler | undefined;
  private configuring: Promise<void> = Promise.resolve();

  private constructor(
    readonly nvidia: NvmlMonitor | NvidiaMonitor,
    /** Set when nvidia-smi is the NVIDIA source: it runs in its own process. */
    private readonly smi: NvidiaMonitor | null,
    readonly amd: AmdSource,
    readonly proc: ProcSampler,
  ) {}

  static async start(settings: CollectorSettings): Promise<Collectors> {
    const intervalMs = settings.pollIntervalMs;
    const needs = gpuNeeds(settings.hiddenGpus);
    const nvml = settings.collectors.nvml ? await NvmlMonitor.start({ intervalMs, needs, lib: nvmlLib() }) : null;
    const smi = nvml ? null : new NvidiaMonitor({ intervalMs, bin: nvidiaSmiBin() });
    const amdCards = await discoverAmdCards().catch(() => [] as AmdCard[]);
    const c = new Collectors(
      nvml ?? smi!,
      smi,
      {
        cards: () => amdCards,
        read: readAmdCard,
        procVram: (pid, skipNodes) => readProcAmdVram(pid, '/proc', skipNodes),
        suspended: isRuntimeSuspended,
      },
      new ProcSampler(),
    );
    await c.configure(settings);
    smi?.start();
    return c;
  }

  /** NVIDIA driver read by NVML (null with nvidia-smi or before the first reading). */
  get nvmlSystem(): { driver: string | null; cudaDriver: number | null } | null {
    return this.smi ? null : (this.nvidia as NvmlMonitor).system;
  }

  /** Effective NVIDIA source (shown on the System page). */
  get nvidiaSource(): 'nvml' | 'nvidia-smi' {
    return this.smi ? 'nvidia-smi' : 'nvml';
  }

  /** CPU and memory; undefined when the collector is off. */
  get system(): SystemSource | undefined {
    return this._system;
  }

  /** Disks; undefined when the collector is off. */
  get disk(): DiskSource | undefined {
    return this._disk;
  }

  /** DRAM bandwidth (perf); follows the system collector's switch. */
  get memBw(): MemBandwidthSampler | undefined {
    return this._memBw;
  }

  /** Follows the settings (interval and hidden cards for NVIDIA, system and disk switches). Calls are serialized. */
  configure(settings: CollectorSettings): Promise<void> {
    const run = this.configuring.then(async () => {
      this.nvidia.configure({ intervalMs: settings.pollIntervalMs, needs: gpuNeeds(settings.hiddenGpus) });
      if (!settings.collectors.system) {
        this._system = undefined;
        this._memBw?.stop();
        this._memBw = undefined;
      } else {
        this._system ??= new SystemSampler();
        if (!this._memBw) {
          this._memBw = new MemBandwidthSampler({ intervalMs: settings.pollIntervalMs });
          this._memBw.start();
        } else this._memBw.configure(settings.pollIntervalMs);
      }
      if (!settings.collectors.disk) this._disk = undefined;
      else if (!this._disk) {
        const sampler = new DiskSampler({ disks: await physicalDisks() });
        this._disk = { sample: (d) => sampler.sample(d), resolveModelDisk: (p) => resolveModelDisk(p) };
      }
    });
    this.configuring = run.catch(() => {});
    return run;
  }

  stop(): void {
    this.nvidia.stop();
    this._memBw?.stop();
  }
}
