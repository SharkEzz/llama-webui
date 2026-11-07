import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseProfileImport } from "./profile";

test("import llama-tui : config entière", async () => {
  const raw = await Bun.file(join(import.meta.dir, "../../testdata/llama-tui-config.json")).json();
  const r = parseProfileImport(raw);
  expect(r.profiles.map((p) => p.name)).toEqual(["qwen3.8-27b-mtp", "qwen3.8-27b-mtp (optimisé) (optimisé)"]);
  expect(r.rejected).toEqual([]);
});

test("import : valides gardés, invalides expliqués", () => {
  const r = parseProfileImport({
    profiles: [
      { name: "ok", model: "m.gguf" },
      { name: "sans-modele" },
      { name: "reserve", model: "m.gguf", args: ["--port", "9000"] },
      { name: "ok", model: "autre.gguf" },
    ],
  });
  expect(r.profiles.map((p) => p.name)).toEqual(["ok"]);
  expect(r.rejected.map((x) => x.name)).toEqual(["sans-modele", "reserve", "ok"]);
  expect(r.rejected[1]!.reason).toContain("--port est géré par llama-webui");
});

test("import : profil seul et tableau", () => {
  expect(parseProfileImport({ name: "a", model: "m" }).profiles).toHaveLength(1);
  expect(
    parseProfileImport([
      { name: "a", model: "m" },
      { name: "b", model: "m" },
    ]).profiles,
  ).toHaveLength(2);
});
