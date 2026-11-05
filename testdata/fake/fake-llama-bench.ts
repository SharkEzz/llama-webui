// Imite llama-bench : progression sur stderr (--progress), JSON réel sur stdout ; FAKE_BENCH_OOM=1 reproduit un échec de chargement.
const args = process.argv.slice(2);
const dir = `${import.meta.dir}/../llama-bench`;
const fixture = (name: string) => Bun.file(`${dir}/${name}`).text();
const err = (s: string) => process.stderr.write(`${s}\n`);

if (args.includes("--list-devices")) {
  process.stdout.write(await fixture("list-devices.txt"));
  process.exit(0);
}
process.on("SIGTERM", () => process.exit(143));
const step = Number(process.env.FAKE_BENCH_STEP_MS ?? 100);
const r = Number(args[args.indexOf("-r") + 1] ?? 5) || 5;

if (process.env.FAKE_BENCH_OOM === "1") {
  for (const l of (await fixture("oom-stderr.txt")).split("\n")) if (l) err(l);
  process.stdout.write("[\n");
  process.exit(1);
}
for (const [i, kind] of [[1, "prompt"], [2, "generation"]] as const) {
  err(`llama-bench: benchmark ${i}/2: starting`);
  await Bun.sleep(step);
  err(`llama-bench: benchmark ${i}/2: warmup ${kind} run`);
  for (let k = 1; k <= r; k++) {
    await Bun.sleep(step);
    err(`llama-bench: benchmark ${i}/2: ${kind} run ${k}/${r}`);
  }
}
process.stdout.write(await fixture("ok.json"));
