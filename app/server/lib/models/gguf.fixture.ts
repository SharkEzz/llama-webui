import { writeFile } from 'node:fs/promises';

export type KvValue =
  | { type: 'u32'; value: number }
  | { type: 'u64'; value: bigint }
  | { type: 'f32'; value: number }
  | { type: 'string'; value: string }
  | { type: 'u32[]'; value: number[] };

export interface FakeTensor {
  name: string;
  shape: number[];
  dtype?: number;
  bytes: number;
}

const T = { u32: 4, f32: 6, string: 8, array: 9, u64: 10 } as const;
const ALIGN = 32;

class Out {
  private parts: Uint8Array[] = [];
  private enc = new TextEncoder();
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    this.parts.push(b);
  }
  u64(n: bigint) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    this.parts.push(b);
  }
  f32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, n, true);
    this.parts.push(b);
  }
  str(s: string) {
    const b = this.enc.encode(s);
    this.u64(BigInt(b.length));
    this.parts.push(b);
  }
  raw(b: Uint8Array) {
    this.parts.push(b);
  }
  get length() {
    return this.parts.reduce((n, p) => n + p.length, 0);
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let i = 0;
    for (const p of this.parts) {
      out.set(p, i);
      i += p.length;
    }
    return out;
  }
}

/**
 * Writes a GGUF v3 file: magic, version, counts, the kv pairs, the tensor infos, padding to 32 bytes, then
 * `bytes` zero bytes per tensor (offsets are the running total rounded up to 32).
 */
export async function writeGguf(path: string, kv: Record<string, KvValue>, tensors: FakeTensor[]): Promise<void> {
  const o = new Out();
  o.raw(new TextEncoder().encode('GGUF'));
  o.u32(3);
  o.u64(BigInt(tensors.length));
  o.u64(BigInt(Object.keys(kv).length));
  for (const [key, v] of Object.entries(kv)) {
    o.str(key);
    if (v.type === 'u32') {
      o.u32(T.u32);
      o.u32(v.value);
    } else if (v.type === 'u64') {
      o.u32(T.u64);
      o.u64(v.value);
    } else if (v.type === 'f32') {
      o.u32(T.f32);
      o.f32(v.value);
    } else if (v.type === 'string') {
      o.u32(T.string);
      o.str(v.value);
    } else {
      o.u32(T.array);
      o.u32(T.u32);
      o.u64(BigInt(v.value.length));
      for (const n of v.value) o.u32(n);
    }
  }
  let offset = 0;
  const offsets: number[] = [];
  for (const t of tensors) {
    offsets.push(offset);
    offset += Math.ceil(t.bytes / ALIGN) * ALIGN;
  }
  tensors.forEach((t, i) => {
    o.str(t.name);
    o.u32(t.shape.length);
    for (const d of t.shape) o.u64(BigInt(d));
    o.u32(t.dtype ?? 0);
    o.u64(BigInt(offsets[i]!));
  });
  const pad = (ALIGN - (o.length % ALIGN)) % ALIGN;
  o.raw(new Uint8Array(pad));
  const last = tensors[tensors.length - 1];
  const dataBytes = last ? offsets[offsets.length - 1]! + last.bytes : 0;
  o.raw(new Uint8Array(dataBytes));
  await writeFile(path, o.bytes());
}
