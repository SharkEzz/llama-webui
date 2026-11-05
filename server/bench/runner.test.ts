import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BenchLive, type BenchRun, BenchSpecSchema, DEFAULT_SETTINGS, type ServerState } from "@llama-webui/shared";
import { BenchRunsRepo } from "../db/benchRuns";
import { openDb } from "../db/open";
import { HttpError } from "../http";
import { LogBuffer } from "../logs/buffer";
import type { BuiltCommand } from "../supervisor/args";
import { probeHealth } from "../supervisor/health";
import { BenchRunner, type BenchRunnerDeps, type ServerControl } from "./runner";

const FAKE = resolve(import.meta.dir, "../../testdata/fake/fake-llama-server");
const MODEL = join(mkdtempSync(join(tmpdir(), "lw-bench-")), "a.gguf");
writeFileSync(MODEL, "");
const cmdA = { display: "cmdA", profileName: "A", profileId: 1, port: 8080 } as BuiltCommand;

afterEach(() => {
  for (const k of ["FAKE_BENCH_OOM", "FAKE_PP", "FAKE_TG", "FAKE_DRAFT", "FAKE_LOAD_MS"]) delete process.env[k];
});

/** Un serveur géré factice (prêt, profil A) qui note les arrêts et relances. */
function setup(port = 8080, patch?: (s: ServerControl) => void, deps?: Partial<BenchRunnerDeps>) {
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
  patch?.(server);
  const lives: (BenchLive | null)[] = [];
  const runs: BenchRun[] = [];
  let ended!: () => void;
  const end = new Promise<void>((r) => (ended = r));
  const repo = new BenchRunsRepo(openDb(":memory:"));
  const runner = new BenchRunner({
    repo,
    settings: () => ({ ...DEFAULT_SETTINGS, binary: FAKE, port }),
    server,
    logs: new LogBuffer(100),
    gpus: () => [],
    hardware: async () => ({ cpu: "cpu", gpus: [], build: null }),
    onLive: (l) => {
      lives.push(l);
      if (l === null) ended();
    },
    onRun: (r) => runs.push(r),
    ...deps,
  });
  return { runner, calls, lives, runs, end, repo };
}

const spec = BenchSpecSchema.parse({ kind: "bench", modelPath: MODEL, r: 2 });

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

test("a server run measures r times and reports draft acceptance", async () => {
  Object.assign(process.env, { FAKE_PP: "1000", FAKE_TG: "50", FAKE_DRAFT: "1", FAKE_LOAD_MS: "50" });
  const port = 18089;
  const { runner, calls, runs, end } = setup(port);
  await runner.start(BenchSpecSchema.parse({ kind: "server", modelPath: MODEL, r: 2, p: 64, n: 8 }), { stopServer: true });
  await end;
  const last = runs.at(-1)!;
  expect(last.error).toBeNull();
  expect(last.status).toBe("ok");
  expect(last.pp).toEqual({ tps: 1000, stddev: 0, tokens: expect.any(Number) });
  expect(last.tg!.tps).toBe(50);
  expect(last.tg!.stddev).toBe(0);
  expect(last.draftAcceptPct).toBe(47.5);
  expect(last.command).toContain(`--port ${port}`);
  expect(calls).toEqual(["stop", "start:cmdA"]);
  expect(await probeHealth(port)).toBeNull();
}, 20_000);

test("a missing model is refused before anything stops", async () => {
  const { runner, calls } = setup();
  const e = await runner.start(BenchSpecSchema.parse({ kind: "bench", modelPath: "/nulle/part.gguf" }), { stopServer: true }).catch((x) => x);
  expect((e as HttpError).status).toBe(400);
  expect(calls).toEqual([]);
  expect(runner.busy).toBe(false);
});

test("a failed restart is recorded on the run", async () => {
  const { runner, runs, end } = setup(8080, (s) => {
    s.start = async () => {
      throw new Error("port occupé");
    };
  });
  await runner.start(spec, { stopServer: true });
  await end;
  const last = runs.at(-1)!;
  expect(last.status).toBe("ok");
  expect(last.error).toContain("relance de llama-server impossible : port occupé");
});

test("a reload while the server is stopping restarts it once the stop is over", async () => {
  // Comme le superviseur : start est refusé tant qu'une autre opération (l'arrêt) est en cours.
  let stopping = false;
  let release!: () => void;
  const { runner, calls, repo } = setup(8080, (s) => {
    s.stop = async () => {
      stopping = true;
      calls.push("stop");
      await new Promise<void>((r) => (release = r));
      stopping = false;
    };
    s.start = async (cmd) => {
      if (stopping) throw new Error("opération en cours, réessayez");
      calls.push(`start:${cmd.display}`);
    };
  });
  const run = await runner.start(spec, { stopServer: true });
  runner.dispose({ restart: true });
  release();
  await Bun.sleep(50);
  expect(calls).toEqual(["stop", "start:cmdA"]);
  expect(repo.get(run.id)!.status).toBe("interrupted");
});

test("a bench run gets its profile's environment", async () => {
  const { runner, runs, end } = setup(8080, undefined, { profile: () => ({ env: { FAKE_BENCH_OOM: "1" } }) });
  await runner.start(BenchSpecSchema.parse({ kind: "bench", modelPath: MODEL, profileId: 1, r: 1 }), { stopServer: true });
  await end;
  expect(runs.at(-1)!.status).toBe("failed");
});

test("a server run runs in its profile's directory", async () => {
  Object.assign(process.env, { FAKE_LOAD_MS: "50" });
  const cwd = mkdtempSync(join(tmpdir(), "lw-cwd-"));
  const { runner, runs, end } = setup(18090, undefined, { profile: () => ({ cwd, env: {} }) });
  await runner.start(BenchSpecSchema.parse({ kind: "server", modelPath: MODEL, profileId: 1, r: 1, p: 16, n: 4 }), { stopServer: true });
  await end;
  expect(runs.at(-1)!.logExcerpt).toContain(`cwd ${cwd}`);
}, 20_000);
