import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAmdCards,
  isRuntimeSuspended,
  parseDpm,
  parseFdinfo,
  parseLinkSpeed,
  readAmdCard,
  readProcAmdVram,
  suspendedAmdReading,
} from "./amdgpu";

const fx = (n: string) => Bun.file(`${import.meta.dir}/../../testdata/${n}`).text();

const tmpDirs: string[] = [];
/** A fresh temp directory, removed once the file's tests are done. */
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

test("parseFdinfo amdgpu", async () => {
  expect(parseFdinfo(await fx("fdinfo-amd-vram.txt"))).toEqual({
    driver: "amdgpu",
    clientId: "157",
    pdev: "0000:08:00.0",
    vramBytes: 6146240 * 1024,
  });
  expect(parseFdinfo(await fx("fdinfo-other.txt"))).toBeNull();
  expect(parseFdinfo("pos: 0\nflags: 1\n")).toBeNull();
});

test("readProcAmdVram dedupes by client id", async () => {
  const root = tmp("llt-proc-");
  const dir = join(root, "123", "fdinfo");
  mkdirSync(dir, { recursive: true });
  const vram = await fx("fdinfo-amd-vram.txt");
  await Bun.write(join(dir, "96"), vram);
  await Bun.write(join(dir, "97"), vram);
  await Bun.write(join(dir, "98"), await fx("fdinfo-amd-igpu.txt"));
  await Bun.write(join(dir, "3"), "pos: 0\n");
  const m = await readProcAmdVram(123, root);
  expect(m.get("amd:0000:08:00.0")).toBe(6146240 * 1024);
  expect(m.get("amd:0000:0d:00.0")).toBe(32 * 1024);
  expect((await readProcAmdVram(999, root)).size).toBe(0);
});

async function drmTree(full = false) {
  const root = tmp("llt-drm-");
  const dev = async (card: string, vendor: string, pdev: string) => {
    const real = join(root, "devices", pdev);
    mkdirSync(join(real, "hwmon", "hwmon3"), { recursive: true });
    await Bun.write(join(real, "vendor"), `${vendor}\n`);
    mkdirSync(join(root, "drm", card), { recursive: true });
    symlinkSync(real, join(root, "drm", card, "device"));
    return real;
  };
  await dev("card0", "0x10de", "0000:01:00.0");
  const amd = await dev("card1", "0x1002", "0000:08:00.0");
  mkdirSync(join(root, "drm", "card1-DP-1"), { recursive: true });
  await Bun.write(join(amd, "gpu_busy_percent"), "42\n");
  await Bun.write(join(amd, "mem_info_vram_used"), "6366834688\n");
  await Bun.write(join(amd, "mem_info_vram_total"), "17095983104\n");
  await Bun.write(join(amd, "hwmon", "hwmon3", "temp1_input"), "38000\n");
  await Bun.write(join(amd, "hwmon", "hwmon3", "power1_average"), "25000000\n");
  if (full) {
    const files: Record<string, string> = {
      current_link_speed: "16.0 GT/s PCIe",
      max_link_speed: "32.0 GT/s PCIe",
      current_link_width: "8",
      max_link_width: "16",
      mem_busy_percent: "12",
      pp_dpm_sclk: "0: 500Mhz\n1: 2400Mhz *\n2: 2520Mhz",
      pp_dpm_mclk: "0: 96Mhz\n1: 1250Mhz *",
      "hwmon/hwmon3/pwm1": "102",
      "hwmon/hwmon3/pwm1_max": "255",
      "hwmon/hwmon3/power1_cap": "300000000",
    };
    await Promise.all(Object.entries(files).map(([f, v]) => Bun.write(join(amd, f), `${v}\n`)));
  }
  return join(root, "drm");
}

test("discoverAmdCards + readAmdCard", async () => {
  const cards = await discoverAmdCards(await drmTree(), async (p) => `GPU ${p}`);
  expect(cards.map((c) => c.card)).toEqual(["card1"]);
  expect(cards[0]!.pdev).toBe("0000:08:00.0");
  expect(cards[0]!.name).toBe("GPU 0000:08:00.0");
  const s = await readAmdCard(cards[0]!);
  expect(s).toEqual({
    key: "amd:0000:08:00.0",
    vendor: "amd",
    name: "GPU 0000:08:00.0",
    busId: "0000:08:00.0",
    utilPct: 42,
    vramUsedBytes: 6366834688,
    vramTotalBytes: 17095983104,
    tempC: 38,
    powerW: 25,
    memUtilPct: null,
    fanPct: null,
    powerLimitW: null,
    clockGrMhz: null,
    clockGrMaxMhz: null,
    clockMemMhz: null,
    pcieGen: null,
    pcieWidth: null,
    pcieGenMax: null,
    pcieWidthMax: null,
  });
});

test("parseLinkSpeed", () => {
  expect(parseLinkSpeed("32.0 GT/s PCIe")).toBe(5);
  expect(parseLinkSpeed("16.0 GT/s PCIe")).toBe(4);
  expect(parseLinkSpeed("8.0 GT/s PCIe")).toBe(3);
  expect(parseLinkSpeed("2.5 GT/s PCIe")).toBe(1);
  expect(parseLinkSpeed("Unknown")).toBeNull();
});

test("parseDpm", () => {
  expect(parseDpm("0: 500Mhz\n1: 1200Mhz *\n2: 2520Mhz\n")).toEqual({ curMhz: 1200, maxMhz: 2520 });
  expect(parseDpm("S: 0Mhz *\n1: 500Mhz\n2: 2520Mhz\n")).toEqual({ curMhz: 0, maxMhz: 2520 });
  expect(parseDpm("")).toEqual({ curMhz: null, maxMhz: null });
});

test("readAmdCard reads link, clocks, fan and power cap", async () => {
  const [card] = await discoverAmdCards(await drmTree(true), async (p) => `GPU ${p}`);
  const g = await readAmdCard(card!);
  expect([g.pcieGen, g.pcieWidth, g.pcieGenMax, g.pcieWidthMax]).toEqual([4, 8, 5, 16]);
  expect([g.clockGrMhz, g.clockGrMaxMhz, g.clockMemMhz, g.memUtilPct]).toEqual([2400, 2520, 1250, 12]);
  expect([g.fanPct, g.powerLimitW]).toEqual([40, 300]);
  expect(g.pcieRxBps).toBeUndefined();
});

test("isRuntimeSuspended reads power/runtime_status without touching the device", async () => {
  const dev = tmp("llt-pm-");
  const card = { card: "card1", pdev: "0000:08:00.0", devicePath: dev, hwmonPath: null, name: "Radeon RX 9070" };
  expect(await isRuntimeSuspended(card)).toBe(false); // no attribute
  mkdirSync(join(dev, "power"));
  await Bun.write(join(dev, "power", "runtime_status"), "active\n");
  expect(await isRuntimeSuspended(card)).toBe(false);
  await Bun.write(join(dev, "power", "runtime_status"), "suspended\n");
  expect(await isRuntimeSuspended(card)).toBe(true);
  expect(suspendedAmdReading(card)).toMatchObject({ key: "amd:0000:08:00.0", name: "Radeon RX 9070", busId: "0000:08:00.0", utilPct: null, suspended: true });
});

/** A fake sysfs PCI device under `root`/devices/pci0000:00 with its identity and link attributes. */
const pciNode = (root: string) => async (path: string, vendor: string, cls: string, cur: [string, string], max: [string, string]) => {
  const p = join(root, "devices", "pci0000:00", path);
  mkdirSync(p, { recursive: true });
  const files = { vendor, class: cls, current_link_speed: cur[0], current_link_width: cur[1], max_link_speed: max[0], max_link_width: max[1] };
  await Promise.all(Object.entries(files).map(([f, v]) => Bun.write(join(p, f), `${v}\n`)));
  return p;
};

/** Exposes `gpu` as drm `card`, the way /sys/class/drm/cardN/device links to the PCI device. */
const drmCard = (root: string, card: string, gpu: string) => {
  mkdirSync(join(root, "drm", card), { recursive: true });
  symlinkSync(gpu, join(root, "drm", card, "device"));
  return join(root, "drm");
};

/**
 * RX 9070 XT behind the chipset, as on the real machine: root port 00:01.1 → chipset upstream 04:00.0 →
 * chipset downstream 05:00.0 (Gen4 x4, `slotMax`) → card switch upstream 06:00.0 → downstream 07:00.0 → GPU 08:00.0.
 */
async function chipsetCard(prefix: string, slotMax: [string, string] = ["16.0 GT/s PCIe", "4"]) {
  const root = tmp(prefix);
  const node = pciNode(root);
  const chip = "0000:00:01.1/0000:04:00.0/0000:05:00.0";
  await node("0000:00:01.1", "0x1022", "0x060400", ["16.0 GT/s PCIe", "4"], ["16.0 GT/s PCIe", "16"]);
  await node("0000:00:01.1/0000:04:00.0", "0x1022", "0x060400", ["16.0 GT/s PCIe", "4"], ["16.0 GT/s PCIe", "4"]);
  await node(chip, "0x1022", "0x060400", ["16.0 GT/s PCIe", "4"], slotMax);
  const up = await node(`${chip}/0000:06:00.0`, "0x1002", "0x060400", ["16.0 GT/s PCIe", "4"], ["32.0 GT/s PCIe", "16"]);
  await node(`${chip}/0000:06:00.0/0000:07:00.0`, "0x1002", "0x060400", ["32.0 GT/s PCIe", "16"], ["32.0 GT/s PCIe", "16"]);
  const gpu = await node(`${chip}/0000:06:00.0/0000:07:00.0/0000:08:00.0`, "0x1002", "0x030000", ["32.0 GT/s PCIe", "16"], ["32.0 GT/s PCIe", "16"]);
  const [card] = await discoverAmdCards(drmCard(root, "card1", gpu), async () => "Radeon RX 9070 XT");
  return { card: card!, slot: join(root, "devices", "pci0000:00", chip), up };
}

test("a card behind its own PCIe switch reports the slot link, bounded by the slot (RX 9070 XT in a Gen4 x4 chipset slot)", async () => {
  const { card } = await chipsetCard("llt-sw-");
  // The walk stops at the chipset's (non-AMD) downstream port, not at the root port further up.
  expect(card.linkPath!.endsWith("/0000:06:00.0")).toBe(true);
  expect(card.portPath!.endsWith("/0000:05:00.0")).toBe(true);
  const g = await readAmdCard(card);
  expect([g.pcieGen, g.pcieWidth, g.pcieGenMax, g.pcieWidthMax]).toEqual([4, 4, 4, 4]);
});

test("the slot link walk stops below an ATI-chipset root port (vendor 0x1002) and is bounded by it", async () => {
  // 990FX root port 00:02.0 (AMD/ATI, Gen2 x16) → x8 card's switch upstream 01:00.0 → downstream 02:00.0 → GPU 03:00.0.
  const root = tmp("llt-rp-");
  const node = pciNode(root);
  await node("0000:00:02.0", "0x1002", "0x060400", ["5.0 GT/s PCIe", "8"], ["5.0 GT/s PCIe", "16"]);
  await node("0000:00:02.0/0000:01:00.0", "0x1002", "0x060400", ["5.0 GT/s PCIe", "8"], ["16.0 GT/s PCIe", "8"]);
  await node("0000:00:02.0/0000:01:00.0/0000:02:00.0", "0x1002", "0x060400", ["16.0 GT/s PCIe", "16"], ["16.0 GT/s PCIe", "16"]);
  const gpu = await node("0000:00:02.0/0000:01:00.0/0000:02:00.0/0000:03:00.0", "0x1002", "0x030000", ["16.0 GT/s PCIe", "16"], ["16.0 GT/s PCIe", "16"]);
  const [card] = await discoverAmdCards(drmCard(root, "card0", gpu), async () => "Radeon RX 6600");
  expect(card!.linkPath!.endsWith("/0000:01:00.0")).toBe(true);
  const g = await readAmdCard(card!);
  expect([g.pcieGen, g.pcieWidth, g.pcieGenMax, g.pcieWidthMax]).toEqual([2, 8, 2, 8]);
});

test("a slot port reporting max_link_width 0 leaves the card's width as the maximum, and is read again until known", async () => {
  // The chipset port's LNKCAP read fails at startup (width 0), then succeeds.
  const { card, slot } = await chipsetCard("llt-w0-", ["16.0 GT/s PCIe", "0"]);
  let g = await readAmdCard(card);
  expect([g.pcieGenMax, g.pcieWidthMax]).toEqual([4, 16]);
  expect(card.linkMax).toBeUndefined();
  await Bun.write(join(slot, "max_link_width"), "4\n");
  g = await readAmdCard(card);
  expect([g.pcieGenMax, g.pcieWidthMax]).toEqual([4, 4]);
  // Known on both ends: kept, no longer read.
  expect(card.linkMax).toEqual({ gen: 4, width: 4 });
  await Bun.write(join(slot, "max_link_width"), "0\n");
  expect((await readAmdCard(card)).pcieWidthMax).toBe(4);
});

test("a link that is down or retraining (current width 0) has an unknown width, not x0", async () => {
  const { card, up } = await chipsetCard("llt-wd-");
  await Bun.write(join(up, "current_link_width"), "0\n");
  expect((await readAmdCard(card)).pcieWidth).toBeNull();
});
