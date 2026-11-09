// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC (\x1b).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Turns an arbitrary chunk stream into clean, non-empty lines. */
export class LineSplitter {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.map(clean).filter((l) => l.length > 0);
  }

  flush(): string[] {
    const rest = clean(this.buf);
    this.buf = '';
    return rest ? [rest] : [];
  }
}

function clean(line: string): string {
  return line.replace(ANSI, '').replace(/\r$/, '').trimEnd();
}

/**
 * A line llama-server writes from -lv 4 on each time a request (the monitor's `/slots` and `/metrics`, every
 * second) wakes its idle loop: kept out of the ring, it would push everything else out of it within the hour.
 */
const IDLE_NOISE = /\bupdate_slots: all slots are idle\s*$/;

export function isIdleNoise(line: string): boolean {
  return IDLE_NOISE.test(line);
}
