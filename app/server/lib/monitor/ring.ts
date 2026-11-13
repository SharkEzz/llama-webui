/** Fixed-capacity numeric ring buffer. */
export class Ring {
  private buf: number[];
  private start = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    this.buf = new Array<number>(capacity).fill(0);
  }

  /** A ring of `capacity` holding the newest of these values. */
  static of(values: number[], capacity: number): Ring {
    const r = new Ring(capacity);
    for (const v of values.slice(-capacity)) r.push(v);
    return r;
  }

  push(v: number): void {
    const idx = (this.start + this.size) % this.capacity;
    this.buf[idx] = v;
    if (this.size < this.capacity) this.size++;
    else this.start = (this.start + 1) % this.capacity;
  }

  values(): number[] {
    const out = new Array<number>(this.size);
    for (let i = 0; i < this.size; i++) out[i] = this.buf[(this.start + i) % this.capacity]!;
    return out;
  }

  last(): number | undefined {
    return this.size === 0 ? undefined : this.buf[(this.start + this.size - 1) % this.capacity];
  }

  max(): number {
    let m = 0;
    for (let i = 0; i < this.size; i++) m = Math.max(m, this.buf[(this.start + i) % this.capacity]!);
    return m;
  }

  get length(): number {
    return this.size;
  }
}
