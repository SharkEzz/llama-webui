export interface SseEvent {
  /** `message` when the stream does not name the event. */
  event: string;
  data: string;
}

/** Incremental text/event-stream reader: accepts chunks split anywhere, LF or CRLF. */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n')) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (this.data.length > 0) out.push({ event: this.event || 'message', data: this.data.join('\n') });
        this.event = '';
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.data.push(value);
      else if (field === 'event') this.event = value;
    }
    return out;
  }
}

/** A named SSE event, data as single-line JSON. */
export const formatSse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
