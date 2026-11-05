// Imitates llama-server for supervisor tests.
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] ?? 8080);
const slow = process.env.FAKE_SLOW_ARG !== undefined && args.includes(process.env.FAKE_SLOW_ARG);
const loadMs = slow ? Number(process.env.FAKE_SLOW_MS ?? 5000) : Number(process.env.FAKE_LOAD_MS ?? 300);
const t0 = Date.now();
const dir = import.meta.dir;
const log = (s: string) => process.stderr.write(`0.00.000.000 I ${s}\n`);

log("srv  main: loading model");
if (process.env.FAKE_EXIT_LINES !== undefined) {
  for (const l of process.env.FAKE_EXIT_LINES.split("|")) log(l);
  process.exit(1);
}
if (process.env.FAKE_FAIL_ARG !== undefined && args.includes(process.env.FAKE_FAIL_ARG)) {
  log("ggml_cuda: out of memory");
  process.exit(1);
}
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const loading = Date.now() - t0 < loadMs;
    if (path === "/health") return loading ? new Response('{"error":"loading"}', { status: 503 }) : Response.json({ status: "ok" });
    if (loading) return new Response("", { status: 503 });
    if (path === "/completion" && req.method === "POST") {
      const body = (await req.json()) as { n_predict?: number };
      if (process.env.FAKE_CRASH_ON_PREDICT !== undefined && body.n_predict === Number(process.env.FAKE_CRASH_ON_PREDICT)) {
        // Dies mid-request, as llama-server does on a CUDA out-of-memory: the socket closes, no answer.
        log("CUDA error: out of memory");
        setTimeout(() => process.exit(1), 20);
        return new Promise<Response>(() => {});
      }
      return Response.json({
        content: "x".repeat(body.n_predict ?? 0),
        timings: { prompt_per_second: Number(process.env.FAKE_PP ?? 1000), predicted_per_second: Number(process.env.FAKE_TG ?? 50) },
      });
    }
    if (path === "/slots") return new Response(Bun.file(`${dir}/slots-busy.json`));
    if (path === "/metrics") return new Response(Bun.file(`${dir}/metrics-after.txt`));
    if (path === "/props") return new Response(Bun.file(`${dir}/props.json`));
    return new Response("not found", { status: 404 });
  },
});
setTimeout(() => log("srv  main: server is listening on http://127.0.0.1:" + port), loadMs);

process.on("SIGTERM", () => {
  if (process.env.FAKE_IGNORE_TERM === "1") {
    log("srv  main: ignoring SIGTERM");
    return;
  }
  log("srv  main: shutting down");
  server.stop(true);
  process.exit(0);
});

if (process.env.FAKE_EXIT_AFTER_MS) {
  setTimeout(() => process.exit(Number(process.env.FAKE_EXIT_CODE ?? 1)), Number(process.env.FAKE_EXIT_AFTER_MS));
}
setInterval(() => {}, 1 << 30);
