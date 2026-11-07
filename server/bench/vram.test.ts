import { expect, test } from "bun:test";
import { parseSmiLine } from "./vram";

test("parseSmiLine reads nvidia-smi loop lines as monitor keys", () => {
  expect(parseSmiLine("GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28, 47")).toEqual({
    key: "nvidia:GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28",
    bytes: 47 * 1024 * 1024,
  });
  expect(parseSmiLine("GPU-x, [N/A]")).toBeNull();
  expect(parseSmiLine("")).toBeNull();
});
