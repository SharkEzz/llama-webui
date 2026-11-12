// Mimics llama-bench: progress on stderr (--progress), real JSON on stdout.
// FAKE_BENCH_OOM=1 or FAKE_BENCH_OOM_ARG=<argv fragment> reproduce a load failure;
// FAKE_PP / FAKE_TG override the throughputs; FAKE_TG_BY_ARG="-ncmoe 8=30;-dev CUDA0,CUDA1=55": first fragment found → that tg.
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const joined = args.join(" ");
const dir = `${import.meta.dirname}/../llama-bench`;
const fixture = (name: string) => readFile(`${dir}/${name}`, "utf8");
const err = (s: string) => process.stderr.write(`${s}\n`);

if (args.includes("--list-devices")) {
  process.stdout.write(await fixture("list-devices.txt"));
  process.exit(0);
}
process.on("SIGTERM", () => process.exit(143));
const step = Number(process.env.FAKE_BENCH_STEP_MS ?? 100);
const r = Number(args[args.indexOf("-r") + 1] ?? 5) || 5;
const oomArg = process.env.FAKE_BENCH_OOM_ARG;

if (process.env.FAKE_BENCH_OOM === "1" || (oomArg && joined.includes(oomArg))) {
  for (const l of (await fixture("oom-stderr.txt")).split("\n")) if (l) err(l);
  process.stdout.write("[\n");
  process.exit(1);
}
for (const [i, kind] of [[1, "prompt"], [2, "generation"]] as const) {
  err(`llama-bench: benchmark ${i}/2: starting`);
  await sleep(step);
  err(`llama-bench: benchmark ${i}/2: warmup ${kind} run`);
  for (let k = 1; k <= r; k++) {
    await sleep(step);
    err(`llama-bench: benchmark ${i}/2: ${kind} run ${k}/${r}`);
  }
}
const byArg = (process.env.FAKE_TG_BY_ARG ?? "")
  .split(";")
  .map((p) => p.split("="))
  .find(([frag]) => frag && joined.includes(frag.replaceAll("/", ",")));
const pp = process.env.FAKE_PP ? Number(process.env.FAKE_PP) : null;
const tg = byArg ? Number(byArg[1]) : process.env.FAKE_TG ? Number(process.env.FAKE_TG) : null;
const out = JSON.parse(await fixture("ok.json")) as { n_prompt: number; n_gen: number; avg_ts: number; stddev_ts: number }[];
for (const t of out) {
  const v = t.n_gen > 0 ? tg : pp;
  if (v !== null) Object.assign(t, { avg_ts: v, stddev_ts: v / 100 });
}
process.stdout.write(JSON.stringify(out, null, 2));
