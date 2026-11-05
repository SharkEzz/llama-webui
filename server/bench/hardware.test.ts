import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOf } from "./hardware";

test("buildOf reads the version again after the binary is rebuilt", async () => {
  const bin = join(mkdtempSync(join(tmpdir(), "lw-build-")), "llama-server");
  const write = (n: number) => {
    writeFileSync(bin, `#!/bin/sh\necho "version: ${n} (c${n})" >&2\necho "built with cc (build ${n}, commit c${n})" >&2\n`);
    chmodSync(bin, 0o755);
    utimesSync(bin, n * 1000, n * 1000);
  };
  write(1);
  expect(await buildOf(bin)).toBe("b1 (c1)");
  write(2);
  expect(await buildOf(bin)).toBe("b2 (c2)");
});
