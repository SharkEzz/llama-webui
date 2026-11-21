import { Array as Arr, Option, Order, String as Str } from 'effect';
import { dual } from 'effect/Function';
import type { TensorInfo } from './gguf.ts';

export interface LayerSizes {
  readonly index: number;
  readonly expertsBytes: number;
  readonly otherBytes: number;
}

export interface WeightSizes {
  readonly layers: ReadonlyArray<LayerSizes>;
  readonly embedBytes: number;
  readonly outputBytes: number;
  readonly otherBytes: number;
  readonly totalBytes: number;
}

/** Bytes of each tensor from consecutive offsets; the last one ends at `fileBytes - dataOffset`. */
export const tensorBytes: {
  (dataOffset: number, fileBytes: number): (tensors: ReadonlyArray<{ readonly offset: number }>) => Array<number>;
  (tensors: ReadonlyArray<{ readonly offset: number }>, dataOffset: number, fileBytes: number): Array<number>;
} = dual(3, (tensors: ReadonlyArray<{ readonly offset: number }>, dataOffset: number, fileBytes: number) => {
  const end = fileBytes - dataOffset;
  return Arr.map(
    tensors,
    (t, i) => Option.match(Arr.get(tensors, i + 1), { onNone: () => end, onSome: (next) => next.offset }) - t.offset,
  );
});

const LAYER = /^blk\.(\d+)\./;
/** What --n-cpu-moe moves to the CPU (llama.cpp: ffn_(up|down|gate)_(ch|)exps); shared experts (_shexp) stay. */
export const EXPERTS = /ffn_(gate|up|down)_(ch)?exps/;

const byIndex = Order.mapInput(Order.Number, (l: LayerSizes) => l.index);

/** Groups tensor bytes by layer (experts apart), embedding, output and the rest. */
export const weightSizes = (tensors: ReadonlyArray<TensorInfo>): WeightSizes => {
  const layers = new Map<number, { index: number; expertsBytes: number; otherBytes: number }>();
  let embedBytes = 0;
  let outputBytes = 0;
  let otherBytes = 0;
  let totalBytes = 0;
  for (const t of tensors) {
    totalBytes += t.bytes;
    const m = Option.fromNullishOr(LAYER.exec(t.name));
    if (Option.isSome(m)) {
      const index = Number(m.value[1]);
      const l = layers.get(index) ?? { index, expertsBytes: 0, otherBytes: 0 };
      layers.set(index, l);
      if (EXPERTS.test(t.name)) l.expertsBytes += t.bytes;
      else l.otherBytes += t.bytes;
    } else if (Str.startsWith('token_embd.')(t.name)) embedBytes += t.bytes;
    else if (Str.startsWith('output.')(t.name)) outputBytes += t.bytes;
    else otherBytes += t.bytes;
  }
  return {
    layers: Arr.sort(Arr.fromIterable(layers.values()), byIndex),
    embedBytes,
    outputBytes,
    otherBytes,
    totalBytes,
  };
};
