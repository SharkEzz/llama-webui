import type { BenchDevice, TuningHardware } from '@llama-webui/shared';
import type { ModelInfo, TensorInfo } from '../models/gguf';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export interface FakeModel {
  layers?: number;
  /** 0 = dense. */
  experts?: number;
  used?: number;
  expertBytesPerLayer?: number;
  otherBytesPerLayer?: number;
  embedBytes?: number;
  outputBytes?: number;
  contextLength?: number;
}

/** A complete ModelInfo (tensors included) with the given sizes, for the estimator. */
export function fakeModel(o: FakeModel = {}): ModelInfo {
  const layers = o.layers ?? 48;
  const experts = o.experts ?? 0;
  const tensors: TensorInfo[] = [];
  let offset = 0;
  const add = (name: string, bytes: number) => {
    tensors.push({ name, shape: [1], dtype: 0, offset, bytes });
    offset += bytes;
  };
  add('token_embd.weight', o.embedBytes ?? 300 * MiB);
  for (let i = 0; i < layers; i++) {
    add(`blk.${i}.attn_q.weight`, o.otherBytesPerLayer ?? 100 * MiB);
    if (experts > 0) {
      const e = o.expertBytesPerLayer ?? 300 * MiB;
      add(`blk.${i}.ffn_gate_exps.weight`, e / 3);
      add(`blk.${i}.ffn_up_exps.weight`, e / 3);
      add(`blk.${i}.ffn_down_exps.weight`, e / 3);
    }
  }
  add('output_norm.weight', 1 * MiB);
  add('output.weight', o.outputBytes ?? 300 * MiB);
  const fileBytes = offset;
  return {
    path: '/m/fake.gguf',
    kind: 'model',
    hasChatTemplate: true,
    files: ['/m/fake.gguf'],
    fileBytes,
    arch: experts > 0 ? 'qwen3moe' : 'qwen3',
    name: 'fake',
    quant: 'Q4_K_M',
    params: 0,
    blockCount: layers,
    embeddingLength: 4096,
    headCount: 32,
    headCountKv: Array(layers).fill(4),
    keyLength: 128,
    valueLength: 128,
    contextLength: o.contextLength ?? 131072,
    vocabSize: 151936,
    expertCount: experts,
    expertUsedCount: experts > 0 ? (o.used ?? 8) : 0,
    fullAttentionInterval: null,
    slidingWindow: null,
    swaPattern: null,
    nextnLayers: 0,
    recurrent: false,
    ssmStateBytesPerSeq: 0,
    tensors,
  };
}

const dev = (id: string, name: string, totalMib: number, freeMib = totalMib - 300): BenchDevice => ({
  id,
  name,
  totalMib,
  freeMib,
  backend: id.replace(/\d+$/, ''),
});

/** The user's machine: 2 × 16 GiB CUDA, the RX 9070 XT on Vulkan, the iGPU and the Vulkan duplicates of the NVIDIA cards. */
export function hw3(o: { ramAvailableGiB?: number } = {}): TuningHardware {
  return {
    devices: [
      dev('CUDA0', 'NVIDIA GeForce RTX 5070 Ti', 15933),
      dev('CUDA1', 'NVIDIA GeForce RTX 5060 Ti', 15941),
      dev('Vulkan0', 'AMD Ryzen 5 9600X 6-Core Processor (RADV RAPHAEL_MENDOCINO)', 32103),
      dev('Vulkan1', 'NVIDIA GeForce RTX 5070 Ti', 16303),
      dev('Vulkan2', 'NVIDIA GeForce RTX 5060 Ti', 16311),
      dev('Vulkan3', 'AMD Radeon RX 9070 XT (RADV GFX1201)', 16304),
      dev('BLAS', 'OpenBLAS', 0, 0),
    ],
    cpu: { model: 'AMD Ryzen 5 9600X', physicalCores: 6, logicalThreads: 12, flags: ['avx2', 'avx512f'], numaNodes: 1 },
    ramTotalBytes: 61 * GiB,
    ramAvailableBytes: (o.ramAvailableGiB ?? 55) * GiB,
  };
}
