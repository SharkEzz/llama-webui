import type { TensorInfo } from "./gguf";

export interface LayerSizes {
  index: number;
  expertsBytes: number;
  otherBytes: number;
}

export interface WeightSizes {
  layers: LayerSizes[];
  embedBytes: number;
  outputBytes: number;
  otherBytes: number;
  totalBytes: number;
}

/** Bytes of each tensor from consecutive offsets; the last one ends at `fileBytes - dataOffset`. */
export function tensorBytes(tensors: Array<{ offset: number }>, dataOffset: number, fileBytes: number): number[] {
  const end = fileBytes - dataOffset;
  return tensors.map((t, i) => (i + 1 < tensors.length ? tensors[i + 1]!.offset : end) - t.offset);
}

const LAYER = /^blk\.(\d+)\./;
/** What --n-cpu-moe moves to the CPU (llama.cpp: ffn_(up|down|gate)_(ch|)exps); shared experts (_shexp) stay. */
const EXPERTS = /ffn_(gate|up|down)_(ch)?exps/;

/** Groups tensor bytes by layer (experts apart), embedding, output and the rest. */
export function weightSizes(tensors: TensorInfo[]): WeightSizes {
  const layers = new Map<number, LayerSizes>();
  let embedBytes = 0;
  let outputBytes = 0;
  let otherBytes = 0;
  let totalBytes = 0;
  for (const t of tensors) {
    totalBytes += t.bytes;
    const m = LAYER.exec(t.name);
    if (m) {
      const index = Number(m[1]);
      let l = layers.get(index);
      if (!l) layers.set(index, (l = { index, expertsBytes: 0, otherBytes: 0 }));
      if (EXPERTS.test(t.name)) l.expertsBytes += t.bytes;
      else l.otherBytes += t.bytes;
    } else if (t.name.startsWith("token_embd.")) embedBytes += t.bytes;
    else if (t.name.startsWith("output.")) outputBytes += t.bytes;
    else otherBytes += t.bytes;
  }
  return { layers: [...layers.values()].sort((a, b) => a.index - b.index), embedBytes, outputBytes, otherBytes, totalBytes };
}
