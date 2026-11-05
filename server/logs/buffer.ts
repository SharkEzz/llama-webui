import { classifyLine, type LogLine } from "@llama-webui/shared";

/** Ring des logs en RAM (pas de persistance). Les abonnés reçoivent les nouvelles lignes par lot (une microtâche). */
export class LogBuffer {
  private buf: LogLine[] = [];
  private next = 0;
  private pending: LogLine[] = [];
  private listeners = new Set<(lines: LogLine[]) => void>();

  constructor(private readonly capacity = 10_000) {}

  push(text: string): void {
    const { level, kind } = classifyLine(text);
    const line: LogLine = { seq: this.next++, text, level, kind };
    this.buf.push(line);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
    if (this.pending.push(line) === 1) {
      queueMicrotask(() => {
        const lines = this.pending;
        this.pending = [];
        for (const fn of this.listeners) fn(lines);
      });
    }
  }

  /** Lignes encore en mémoire dont le numéro est ≥ `seq`. */
  since(seq: number): LogLine[] {
    const first = this.buf[0]?.seq ?? this.next;
    return this.buf.slice(Math.max(0, seq - first));
  }

  /** Numéro de la prochaine ligne. */
  get seq(): number {
    return this.next;
  }

  onLines(fn: (lines: LogLine[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
