import { expect, test } from "bun:test";
import { benchBinary, benchFailure, parseBenchJson, parseBenchProgress, parseDeviceList } from "./parse";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/../../testdata/llama-bench/${name}`).text();

test("parseBenchJson reads pp and tg from a real run", async () => {
  const r = parseBenchJson(await fixture("ok.json"))!;
  expect(r.pp!.tps).toBeCloseTo(9817.38, 1);
  expect(r.pp!.tokens).toBe(64);
  expect(r.tg!.tps).toBeCloseTo(410.81, 1);
  expect(r.tg!.tokens).toBe(16);
  expect(r.tg!.stddev).toBeGreaterThan(0);
  expect(r.build).toBe("b12119 (6f1e65437)");
});

test("parseBenchJson gives null on the truncated output of a failed load", async () => {
  expect(parseBenchJson(await fixture("oom-stdout.json"))).toBeNull();
});

test("benchFailure reports an out-of-memory load", async () => {
  const f = benchFailure((await fixture("oom-stderr.txt")).split("\n"), 1);
  expect(f.oom).toBe(true);
  expect(f.message.startsWith("Mémoire insuffisante : ")).toBe(true);
  expect(f.message).toContain("unable to allocate CUDA1 buffer");
  expect(benchFailure(["rien"], 2)).toEqual({ oom: false, message: "llama-bench terminé (code 2)" });
});

test("parseBenchProgress reads the --progress lines", () => {
  expect(parseBenchProgress("llama-bench: benchmark 2/2: generation run 1/2")).toEqual({ phase: "generation", test: 2, tests: 2, run: 1, runs: 2 });
  expect(parseBenchProgress("llama-bench: benchmark 1/2: warmup prompt run")).toEqual({ phase: "warmup", test: 1, tests: 2, run: null, runs: null });
  expect(parseBenchProgress("llama-bench: benchmark 1/2: starting")).toBeNull();
  expect(parseBenchProgress("ggml_cuda_init: found 2 CUDA devices")).toBeNull();
});

test("parseDeviceList keeps names with parentheses", async () => {
  const d = parseDeviceList(await fixture("list-devices.txt"));
  expect(d).toHaveLength(7);
  expect(d.find((x) => x.id === "Vulkan3")).toEqual({ id: "Vulkan3", name: "AMD Radeon RX 9070 XT (RADV GFX1201)", totalMib: 16304, freeMib: 16225, backend: "Vulkan" });
  expect(d.find((x) => x.id === "BLAS")?.backend).toBe("BLAS");
});

test("benchBinary sits next to the server binary", () => {
  expect(benchBinary("/x/bin/llama-server")).toBe("/x/bin/llama-bench");
  expect(benchBinary("llama-server")).toBe("llama-bench");
  expect(benchBinary("testdata/fake/fake-llama-server")).toBe("testdata/fake/fake-llama-bench");
});
