import { join } from 'node:path';
import type { GpuSample } from '@llama-webui/shared';
import { LineSplitter } from '../logs/lines';

const MIB = 1024 * 1024;

/** Une ligne de `nvidia-smi --query-gpu=uuid,memory.used --format=csv,noheader,nounits -lms N`, avec la clé du Monitor. */
export function parseSmiLine(line: string): { key: string; bytes: number } | null {
  const m = /^\s*(GPU-[\w-]+),\s*(\d+)\s*$/.exec(line);
  return m ? { key: `nvidia:${m[1]}`, bytes: Number(m[2]) * MIB } : null;
}

export interface VramPeaks {
  /** Par clé de GPU : première mesure et maximum vu. */
  get(key: string): { first: number; max: number } | undefined;
}

/**
 * Relevé rapide de la VRAM pendant un run (le Monitor ne mesure qu'à son intervalle, 1 s par défaut, et rate les pics
 * courts) : `nvidia-smi -lms` pour les cartes NVIDIA, sysfs `mem_info_vram_used` pour les AMD. Chaque source qui échoue
 * est ignorée ; le runner garde les snapshots du Monitor en secours.
 */
export class VramProbe implements VramPeaks {
  private readonly seen = new Map<string, { first: number; max: number }>();
  private readonly smi: ReturnType<typeof Bun.spawn> | null = null;
  private readonly smiDone: Promise<void> = Promise.resolve();
  private readonly timer: Timer | null = null;

  constructor(gpus: GpuSample[], o: { intervalMs?: number; sysRoot?: string } = {}) {
    const intervalMs = o.intervalMs ?? 100;
    const sysRoot = o.sysRoot ?? '/sys';
    if (gpus.some((g) => g.vendor === 'nvidia')) {
      try {
        this.smi = Bun.spawn(
          ['nvidia-smi', '--query-gpu=uuid,memory.used', '--format=csv,noheader,nounits', '-lms', String(intervalMs)],
          { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
        );
        this.smiDone = this.read(this.smi.stdout as ReadableStream<Uint8Array>);
      } catch {}
    }
    const amd = gpus.filter((g) => g.vendor === 'amd' && g.vramTotalBytes > 0);
    if (amd.length > 0) {
      const tick = async () => {
        for (const g of amd) {
          const text = await Bun.file(join(sysRoot, 'bus/pci/devices', g.busId, 'mem_info_vram_used'))
            .text()
            .catch(() => '');
          const bytes = Number(text.trim());
          if (text.trim() !== '' && Number.isFinite(bytes)) this.note(g.key, bytes);
        }
      };
      void tick();
      this.timer = setInterval(() => void tick(), intervalMs);
    }
  }

  private note(key: string, bytes: number): void {
    const s = this.seen.get(key);
    if (!s) this.seen.set(key, { first: bytes, max: bytes });
    else if (bytes > s.max) s.max = bytes;
  }

  private async read(stream: ReadableStream<Uint8Array>): Promise<void> {
    const split = new LineSplitter();
    const dec = new TextDecoder();
    try {
      for await (const chunk of stream)
        for (const l of split.push(dec.decode(chunk, { stream: true }))) {
          const s = parseSmiLine(l);
          if (s) this.note(s.key, s.bytes);
        }
    } catch {}
  }

  get(key: string): { first: number; max: number } | undefined {
    return this.seen.get(key);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.smi) {
      try {
        this.smi.kill('SIGTERM');
      } catch {}
      await Promise.race([this.smiDone, Bun.sleep(500)]);
    }
  }
}
