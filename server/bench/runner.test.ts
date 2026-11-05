import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type BenchLive, type BenchRun, BenchSpecSchema, DEFAULT_SETTINGS, type ServerState } from "@llama-webui/shared";
import { BenchRunsRepo } from "../db/benchRuns";
import { openDb } from "../db/open";
import { HttpError } from "../http";
import { LogBuffer } from "../logs/buffer";
import type { BuiltCommand } from "../supervisor/args";
import { BenchRunner, type ServerControl } from "./runner";

const FAKE = resolve(import.meta.dir, "../../testdata/fake/fake-llama-server");
const cmdA = { display: "cmdA", profileName: "A", profileId: 1, port: 8080 } as BuiltCommand;

afterEach(() => {
  delete process.env.FAKE_BENCH_OOM;
});

/** Un serveur géré factice (prêt, profil A) qui note les arrêts et relances. */
function setup() {
  const calls: string[] = [];
  let state: ServerState = { kind: "ready", profile: "A", profileId: 1, pid: 1, port: 8080, since: 0 };
  const server: ServerControl = {
    get state() {
      return state;
    },
    lastCommand: cmdA,
    stop: async () => {
      calls.push("stop");
      state = { kind: "idle" };
    },
    start: async (cmd) => {
      calls.push(`start:${cmd.display}`);
      state = { kind: "starting", profile: "A", profileId: 1, pid: 2, port: 8080, since: 0 };
    },
  };
  const lives: (BenchLive | null)[] = [];
  const runs: BenchRun[] = [];
  let ended!: () => void;
  const end = new Promise<void>((r) => (ended = r));
  const runner = new BenchRunner({
    repo: new BenchRunsRepo(openDb(":memory:")),
    settings: () => ({ ...DEFAULT_SETTINGS, binary: FAKE }),
    server,
    logs: new LogBuffer(100),
    gpus: () => [],
    hardware: async () => ({ cpu: "cpu", gpus: [], build: null }),
    onLive: (l) => {
      lives.push(l);
      if (l === null) ended();
    },
    onRun: (r) => runs.push(r),
  });
  return { runner, calls, lives, runs, end };
}

const spec = BenchSpecSchema.parse({ kind: "bench", modelPath: "/m/a.gguf", r: 2 });

test("restarts the server it stopped even when llama-bench fails", async () => {
  process.env.FAKE_BENCH_OOM = "1";
  const { runner, calls, lives, runs, end } = setup();
  const run = await runner.start(spec, { stopServer: true });
  expect(run.status).toBe("running");
  await end;
  const last = runs.at(-1)!;
  expect(last.id).toBe(run.id);
  expect(last.status).toBe("failed");
  expect(last.error!.startsWith("Mémoire insuffisante")).toBe(true);
  expect(calls).toEqual(["stop", "start:cmdA"]);
  expect(lives.at(-1)).toBeNull();
  expect(runner.busy).toBe(false);
});

test("a successful run stores pp/tg and refuses a second run meanwhile", async () => {
  const { runner, lives, runs, end } = setup();
  const refused = await runner.start(spec, { stopServer: false }).catch((e) => e);
  expect(refused).toBeInstanceOf(HttpError);
  expect((refused as HttpError).code).toBe("server-running");

  await runner.start(spec, { stopServer: true });
  const again = await runner.start(spec, { stopServer: true }).catch((e) => e);
  expect((again as HttpError).status).toBe(409);
  await end;
  const last = runs.at(-1)!;
  expect(last.status).toBe("ok");
  expect(last.pp!.tps).toBeCloseTo(9817.38, 1);
  expect(last.tg!.tps).toBeCloseTo(410.81, 1);
  expect(lives.some((l) => l?.phase === "prompt" && l.step !== null)).toBe(true);
});
