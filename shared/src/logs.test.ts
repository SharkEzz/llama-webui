import { expect, test } from "bun:test";
import { type LogLine, type LogView, mergeLogs, onBoot } from "./logs";

const line = (seq: number): LogLine => ({ seq, text: `l${seq}`, level: "info", kind: "other" });
const view = (seqs: number[], extra: Partial<LogView> = {}): LogView => ({
  lines: seqs.map(line),
  seq: (seqs.at(-1) ?? -1) + 1,
  bootId: "a",
  hiddenBefore: -1,
  ...extra,
});

test("onBoot : même démarrage → rien ne change ; autre démarrage → tout repart de zéro, masquage compris", () => {
  const v = view([0, 1, 2], { hiddenBefore: 3 });
  expect(onBoot(v, "a")).toBe(v);
  expect(onBoot(v, "b")).toEqual({ lines: [], seq: 0, bootId: "b", hiddenBefore: -1 });
  expect(onBoot({ ...v, bootId: null }, "a")).toEqual({ ...v, bootId: "a" }); // premier hello : on adopte
});

test("mergeLogs : ajout en fin, rejeu dédoublonné et trié, plafond", () => {
  expect(mergeLogs(view([0, 1]), [line(2), line(3)], 10).lines.map((l) => l.seq)).toEqual([0, 1, 2, 3]);
  const replayed = mergeLogs(view([0, 3]), [line(1), line(2), line(3)], 10);
  expect(replayed.lines.map((l) => l.seq)).toEqual([0, 1, 2, 3]);
  expect(replayed.seq).toBe(4);
  expect(mergeLogs(view([0, 1, 2]), [line(3), line(4)], 3).lines.map((l) => l.seq)).toEqual([2, 3, 4]);
});
