import type { Settings } from '@llama-webui/shared';
import { type AmdCard, discoverAmdCards, isRuntimeSuspended, readAmdCard, readProcAmdVram } from './amdgpu';
import { type DiskSample, DiskSampler, physicalDisks, resolveModelDisk } from './disk';
import type { GpuReading } from './gpu';
import { gpuNeeds } from './needs';
import { NvidiaMonitor } from './nvidia';
import { NvmlMonitor } from './nvml/monitor';
import { ProcSampler } from './proc';
import { type SystemSample, SystemSampler } from './system';

/** Ce dont les collecteurs dépendent dans les réglages. */
export type CollectorSettings = Pick<Settings, 'collectors' | 'pollIntervalMs' | 'hiddenGpus'>;

export interface AmdSource {
  cards: () => AmdCard[];
  read: (c: AmdCard) => Promise<GpuReading>;
  /** VRAM du process par carte ; les descripteurs ouverts sur `skipNodes` (cartes à ne pas lire) sont ignorés. */
  procVram: (pid: number, skipNodes: ReadonlySet<string>) => Promise<Map<string, number>>;
  /** Cartes en veille : listées mais jamais lues, pour ne pas les réveiller. */
  suspended: (c: AmdCard) => Promise<boolean>;
}

export interface SystemSource {
  sample(): Promise<SystemSample | null>;
}

export interface DiskSource {
  sample(modelDisk: string | null): Promise<DiskSample | null>;
  resolveModelDisk(path: string): Promise<string | null>;
}

/** Binaire nvidia-smi du repli (LLAMA_WEBUI_NVIDIA_SMI pour le tester absent). */
const nvidiaSmiBin = () => process.env.LLAMA_WEBUI_NVIDIA_SMI || 'nvidia-smi';

/**
 * Collecteurs matériels (copiés de llama-tui) : NVIDIA par NVML dans un Worker (repli nvidia-smi), AMD par sysfs,
 * le process du serveur, et CPU/mémoire et disques selon leur interrupteur. configure() suit les réglages,
 * sauf le choix NVML / nvidia-smi, fait une fois au démarrage.
 */
export class Collectors {
  private _system: SystemSource | undefined;
  private _disk: DiskSource | undefined;
  private configuring: Promise<void> = Promise.resolve();

  private constructor(
    readonly nvidia: NvmlMonitor | NvidiaMonitor,
    /** Défini quand nvidia-smi est la source NVIDIA : il tourne dans son propre process. */
    private readonly smi: NvidiaMonitor | null,
    readonly amd: AmdSource,
    readonly proc: ProcSampler,
  ) {}

  static async start(settings: CollectorSettings): Promise<Collectors> {
    const intervalMs = settings.pollIntervalMs;
    const needs = gpuNeeds(settings.hiddenGpus);
    const nvml = settings.collectors.nvml ? await NvmlMonitor.start({ intervalMs, needs }) : null;
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

  /** Pilote NVIDIA lu par NVML (null avec nvidia-smi ou avant la première lecture). */
  get nvmlSystem(): { driver: string | null; cudaDriver: number | null } | null {
    return this.smi ? null : (this.nvidia as NvmlMonitor).system;
  }

  /** Source NVIDIA effective (affichée dans Système). */
  get nvidiaSource(): 'nvml' | 'nvidia-smi' {
    return this.smi ? 'nvidia-smi' : 'nvml';
  }

  /** CPU et mémoire ; undefined quand le collecteur est coupé. */
  get system(): SystemSource | undefined {
    return this._system;
  }

  /** Disques ; undefined quand le collecteur est coupé. */
  get disk(): DiskSource | undefined {
    return this._disk;
  }

  /** Suit les réglages (cadence et cartes masquées côté NVIDIA, interrupteurs système et disque). Appels en série. */
  configure(settings: CollectorSettings): Promise<void> {
    const run = this.configuring.then(async () => {
      this.nvidia.configure({ intervalMs: settings.pollIntervalMs, needs: gpuNeeds(settings.hiddenGpus) });
      if (!settings.collectors.system) this._system = undefined;
      else this._system ??= new SystemSampler();
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
  }
}
