import { expect, test } from "bun:test";
import { externalWatcher } from "./external";

test("no external server is detected while a benchmark owns the port", async () => {
  let detected = 0;
  const check = externalWatcher({
    supervisor: {
      state: { kind: "idle" },
      detectExternal: async () => {
        detected++;
        return true;
      },
      recheckExternal: async () => {},
    },
    port: () => 8080,
    paused: () => true,
  });
  await check();
  expect(detected).toBe(0);
});
