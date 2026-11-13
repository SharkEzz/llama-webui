import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { GpuSample } from '@llama-webui/shared';
import { LineSplitter } from '../logs/lines';
import { readText, type Spawned, spawnProc } from '../proc';

const MIB = 1024 * 1024;

/** A line of `nvidia-smi --query-gpu=uuid,memory.used --format=csv,noheader,nounits -lms N`, with the Monitor's key. */
export function parseSmiLine(line: string): { key: string; bytes: number } | null {
  const m = /^\s*(GPU-[\w-]+),\s*(\d+)\s*$/.exec(line);
  return m ? { key: `nvidia:${m[1]}`, bytes: Number(m[2]) * MIB } : null;
}

export interface VramPeaks {
  /** Per GPU key: first measurement and maximum seen. */
  get(key: string): { first: number; max: number } | undefined;
}

/**
 * Fast VRAM sampling during a run (the Monitor only measures at its interval, 1 s by default, and misses short
 * peaks): `nvidia-smi -lms` for NVIDIA cards, sysfs `mem_info_vram_used` for AMD. Each source that fails is
 * ignored; the runner keeps the Monitor's snapshots as a fallback.
 */
export class VramProbe implements VramPeaks {
  private readonly seen = new Map<string, { first: number; max: number }>();
  private readonly smi: Spawned | null = null;
  private readonly smiDone: Promise<void> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval> | null = null;

  constructor(gpus: GpuSample[], o: { intervalMs?: number; sysRoot?: string } = {}) {
    const intervalMs = o.intervalMs ?? 100;
    const sysRoot = o.sysRoot ?? '/sys';
    if (gpus.some((g) => g.vendor === 'nvidia')) {
      try {
        const smi = spawnProc(
          ['nvidia-smi', '--query-gpu=uuid,memory.used', '--format=csv,noheader,nounits', '-lms', String(intervalMs)],
          { stderr: 'ignore' },
        );
        this.smi = smi;
        this.smiDone = this.read(smi.stdout);
      } catch {}
    }
    const amd = gpus.filter((g) => g.vendor === 'amd' && g.vramTotalBytes > 0);
    if (amd.length > 0) {
      const tick = async () => {
        for (const g of amd) {
          const text = await readText(join(sysRoot, 'bus/pci/devices', g.busId, 'mem_info_vram_used')).catch(() => '');
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
      await Promise.race([this.smiDone, sleep(500, undefined, { ref: false })]);
    }
  }
}
