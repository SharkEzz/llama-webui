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
    if (path === "/v1/chat/completions" && req.method === "POST") return chat(req);
    if (path === "/slots") return new Response(Bun.file(`${dir}/slots-busy.json`));
    if (path === "/metrics") return new Response(Bun.file(`${dir}/metrics-after.txt`));
    if (path === "/props") return new Response(Bun.file(`${dir}/props.json`));
    return new Response("not found", { status: 404 });
  },
});
const ANSWER = [
  "## Réponse simulée\n\n",
  "Voici une **liste** :\n\n- un\n- deux\n- trois\n\n",
  "| Flag | Valeur |\n|---|---|\n| `-ngl` | 99 |\n| `-c` | 40000 |\n\n",
  "```ts\nconst x: number = 42 // commentaire\nconsole.log(`x = ${x}`)\n```\n\n",
  "Du HTML brut reste du texte : <b>html</b> <script>alert(1)</script>\n\n",
  "Un [lien](https://github.com/ggml-org/llama.cpp) et du `code en ligne`.",
];

/** Réponse OpenAI en stream : réflexion (si enable_thinking) puis Markdown, un morceau toutes les FAKE_CHAT_DELAY_MS. */
async function chat(req: Request): Promise<Response> {
  const body = (await req.json()) as { messages?: unknown[]; chat_template_kwargs?: { enable_thinking?: boolean } };
  // Contexte simulé : ~4 caractères par jeton, FAKE_N_CTX jetons (comme le refus de llama-server).
  const nCtx = Number(process.env.FAKE_N_CTX ?? 40192);
  const nPrompt = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
  if (nPrompt >= nCtx) {
    const message = `request (${nPrompt} tokens) exceeds the available context size (${nCtx} tokens), try increasing it`;
    return Response.json({ error: { code: 400, message, type: "exceed_context_size_error", n_prompt_tokens: nPrompt, n_ctx: nCtx } }, { status: 400 });
  }
  const delay = Number(process.env.FAKE_CHAT_DELAY_MS ?? 60);
  const lines = Number(process.env.FAKE_CHAT_LINES ?? 0);
  const thinking = body.chat_template_kwargs?.enable_thinking !== false;
  const words = (s: string) => s.match(/\S+\s*|\s+/g) ?? [];
  const parts: { content?: string; reasoning_content?: string }[] = [
    ...(thinking ? words("Je réfléchis à la question posée avant de répondre. ").map((w) => ({ reasoning_content: w })) : []),
    ...ANSWER.flatMap(words).map((w) => ({ content: w })),
    ...Array.from({ length: lines }, (_, i) => ({ content: `\nLigne ${i + 1} d'une très longue réponse.` })),
  ];
  const enc = new TextEncoder();
  const send = (c: ReadableStreamDefaultController, o: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
  let cancelled = false;
  return new Response(
    new ReadableStream({
      async start(c) {
        for (const delta of parts) {
          if (cancelled || req.signal.aborted) return;
          send(c, { choices: [{ index: 0, delta }] });
          if (delay > 0) await Bun.sleep(delay);
        }
        const n = parts.length;
        send(c, {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          timings: { prompt_n: 42, prompt_ms: 210, prompt_per_second: 200, predicted_n: n, predicted_ms: n * delay, predicted_per_second: 51.2, cache_n: 0, draft_n: 20, draft_n_accepted: 10 },
        });
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

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
