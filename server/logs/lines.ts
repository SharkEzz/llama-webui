// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC (\x1b).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Turns an arbitrary chunk stream into clean, non-empty lines. */
export class LineSplitter {
  private buf = "";

  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    return parts.map(clean).filter((l) => l.length > 0);
  }

  flush(): string[] {
    const rest = clean(this.buf);
    this.buf = "";
    return rest ? [rest] : [];
  }
}

function clean(line: string): string {
  return line.replace(ANSI, "").replace(/\r$/, "").trimEnd();
}
