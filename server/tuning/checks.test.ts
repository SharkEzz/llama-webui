import { expect, test } from "bun:test";
import { type CheckContext, runChecks } from "./checks";
import { hw3 } from "./fixtures";
import type { SysReadings } from "./sysinfo";

const GiB = 1024 ** 3;
const readings: SysReadings = {
  governors: ["schedutil", "schedutil"],
  thp: "madvise",
  memlockLimitBytes: Number.POSITIVE_INFINITY,
  swappiness: 60,
  cmdline: "",
  iommuActive: false,
  modules: ["nvidia_uvm"],
  backendLibs: ["libggml-cuda.so", "libggml-vulkan.so"],
  driver: "580.1",
  cudaDriver: 13000,
  bar1Bytes: {},
  amdDpm: {},
  buildDate: null,
  systemInfo: null,
  cudaDriverError: false,
  modelDisk: { rotational: false, fsType: "ext4" },
};
const ctx = (o: Partial<CheckContext> = {}): CheckContext => ({
  readings,
  gpus: [],
  retainedBusIds: [],
  devices: hw3().devices,
  cpu: hw3().cpu,
  model: null,
  estimate: null,
  mem: null,
  diskSpeed: null,
  now: Date.now(),
  ...o,
});
const byId = (c: CheckContext, id: string) => runChecks(c).find((x) => x.id === id)!;

test("a governor other than performance is a warning with the exact command", () => {
  const g = byId(ctx(), "cpu.governor");
  expect(g.state).toBe("warn");
  expect(g.command).toBe("echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor");
});

test("disk speed: unknown until measured, warning under 2 GiB/s", () => {
  expect(byId(ctx(), "kernel.disk-speed").state).toBe("unknown");
  const slow = { bytesPerSec: 1.2 * GiB, sampledBytes: GiB, path: "/m", at: 0 };
  expect(byId(ctx({ diskSpeed: slow }), "kernel.disk-speed").state).toBe("warn");
  expect(byId(ctx({ diskSpeed: { ...slow, bytesPerSec: 5 * GiB } }), "kernel.disk-speed").state).toBe("ok");
});
