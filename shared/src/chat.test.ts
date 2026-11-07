import { expect, test } from "bun:test";
import { autoTitle, statsFromTimings } from "./chat";

test("statsFromTimings maps llama-server timings", () => {
  const t = {
    prompt_n: 183,
    prompt_per_second: 183.21,
    predicted_n: 412,
    predicted_per_second: 51.23,
    cache_n: 12,
    draft_n: 40,
    draft_n_accepted: 20,
  };
  expect(statsFromTimings(t, 1234, 9000)).toEqual({
    ttftMs: 1234,
    promptTokens: 183,
    cachedTokens: 12,
    genTokens: 412,
    ppTps: 183.21,
    tgTps: 51.23,
    draftN: 40,
    draftAccepted: 20,
    durationMs: 9000,
  });
  const { draft_n: _d, draft_n_accepted: _a, ...plain } = t;
  expect(statsFromTimings(plain, null, 1).draftN).toBeNull();
});

test("autoTitle keeps the first six words within 48 characters", () => {
  expect(autoTitle("  Explique-moi   les shards GGUF de llama.cpp en détail stp ")).toBe(
    "Explique-moi les shards GGUF de llama.cpp…",
  );
  expect(autoTitle("Bonjour")).toBe("Bonjour");
  expect(autoTitle("Un deux trois quatre cinq six sept")).toBe("Un deux trois quatre cinq six…");
  expect(autoTitle("   ")).toBe("Nouvelle conversation");
  expect(autoTitle("a".repeat(60))).toBe(`${"a".repeat(47)}…`);
});
