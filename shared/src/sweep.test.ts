import { expect, test } from "bun:test";
import type { BenchRun, Measure } from "./bench";
import { expandSpace, itemLabel, rankRuns, SweepSpecSchema } from "./sweep";

test("expandSpace crosses the dimensions in field order and applies -ts only where it fits", () => {
  const { items, droppedTs } = expandSpace(
    { fa: "on" },
    { ngl: ["all", 20], dev: [["CUDA0"], ["CUDA0", "CUDA1"]], ts: [[3, 1]] },
  );
  expect(items).toEqual([
    { fa: "on", ngl: "all", dev: ["CUDA0"] },
    { fa: "on", ngl: "all", dev: ["CUDA0", "CUDA1"], ts: [3, 1] },
    { fa: "on", ngl: 20, dev: ["CUDA0"] },
    { fa: "on", ngl: 20, dev: ["CUDA0", "CUDA1"], ts: [3, 1] },
  ]);
  expect(droppedTs).toBe(2);
  expect(expandSpace({ ngl: 10 }, {}).items).toEqual([{ ngl: 10 }]);
});

test("expandSpace drops duplicates and a base -ts that no longer matches the devices", () => {
  const { items } = expandSpace(
    { ts: [1, 1], dev: ["CUDA0", "CUDA1"] },
    { dev: [["CUDA0"], ["CUDA0", "CUDA1"], ["CUDA0"]] },
  );
  expect(items).toEqual([{ dev: ["CUDA0"] }, { dev: ["CUDA0", "CUDA1"], ts: [1, 1] }]);
});

test("itemLabel names only the varying dimensions", () => {
  expect(
    itemLabel(
      { fa: "on", ngl: "all", dev: ["CUDA0", "Vulkan3"], ncmoe: 8 },
      { ngl: ["all"], dev: [["CUDA0", "Vulkan3"]], ncmoe: [8] },
    ),
  ).toBe("-ngl all · -ncmoe 8 · -dev CUDA0,Vulkan3");
  expect(itemLabel({ ngl: 5 }, {})).toBe("base");
});

const m = (tps: number): Measure => ({ tps, stddev: 0, tokens: 1 });
const run = (id: number, tg: number | null, status: BenchRun["status"] = "ok") =>
  ({ id, status, kind: "bench", pp: tg === null ? null : m(1000), tg: tg === null ? null : m(tg) }) as BenchRun;

test("rankRuns marks ties inside the noise band and leaves failures unranked", () => {
  const ranked = rankRuns([run(1, 44), run(2, null, "failed"), run(3, 50), run(4, 49.2)], "chat", 8192);
  expect(ranked.map((r) => [r.run.id, r.rank, r.tie])).toEqual([
    [3, 1, true],
    [4, 2, true],
    [1, 3, false],
    [2, null, false],
  ]);
  expect(rankRuns([run(1, 50), run(2, 40)], "chat", 8192)[0]!.tie).toBe(false);
});

test("SweepSpecSchema refuses an empty value list for a dimension", () => {
  const r = SweepSpecSchema.safeParse({ name: "s", modelPath: "/m.gguf", preset: "chat", space: { ncmoe: [] } });
  expect(r.success).toBe(false);
});
