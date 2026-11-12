// Imitates llama-server for the bench runner and parser tests. Plain Node script (erasable TypeScript).
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

/** Exits once stdout and stderr are flushed: `process.exit` drops the writes still queued on a pipe. */
const exit = async (code: number): Promise<never> => {
  for (const s of [process.stdout, process.stderr]) await new Promise<void>((done) => s.write("", () => done()));
  process.exit(code);
};

/** A fetch-style handler on node:http: the request is aborted when the client goes away, the body is streamed. */
function serve(port: number, hostname: string, handler: (req: Request) => Response | Promise<Response>) {
  const server = createServer(async (inc, out) => {
    const ac = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    out.on("close", () => {
      if (out.writableFinished) return;
      ac.abort();
      void reader?.cancel().catch(() => {});
    });
    const method = inc.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : (Readable.toWeb(inc) as ReadableStream<Uint8Array>);
    let res: Response;
    try {
      const init = { method, headers: inc.headers as Record<string, string>, body, signal: ac.signal, duplex: "half" };
      res = await handler(new Request(`http://${hostname}:${port}${inc.url ?? "/"}`, init as RequestInit));
    } catch (e) {
      res = new Response(String(e), { status: 500 });
    }
    out.writeHead(res.status, Object.fromEntries(res.headers));
    if (!res.body) return void out.end();
    reader = res.body.getReader();
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) out.write(r.value);
      out.end();
    } catch {
      out.destroy();
    }
  });
  server.listen(port, hostname);
  return server;
}

/** A fixture file with its content type. */
const file = async (path: string) =>
  new Response(await readFile(path), {
    headers: { "content-type": path.endsWith(".json") ? "application/json;charset=utf-8" : "text/plain;charset=utf-8" },
  });

const args = process.argv.slice(2);
if (args.includes("--help")) {
  // A short catalogue, so a --help call (flag catalogue) exits at once instead of starting a server on 8080.
  process.stdout.write("----- common params -----\n\n-c,    --ctx-size N                     size of the prompt context\n");
  await exit(0);
}
if (args.includes("--version")) {
  process.stderr.write("version: 0.0.0-fake (build 1, commit fake)\n");
  await exit(0);
}
const port = Number(args[args.indexOf("--port") + 1] ?? 8080);
const slow = process.env.FAKE_SLOW_ARG !== undefined && args.includes(process.env.FAKE_SLOW_ARG);
const loadMs = slow ? Number(process.env.FAKE_SLOW_MS ?? 5000) : Number(process.env.FAKE_LOAD_MS ?? 300);
const t0 = Date.now();
const dir = import.meta.dirname;
const log = (s: string) => process.stderr.write(`0.00.000.000 I ${s}\n`);

log("srv  main: loading model");
log(`srv  main: cwd ${process.cwd()}`);
if (process.env.FAKE_EXIT_LINES !== undefined) {
  for (const l of process.env.FAKE_EXIT_LINES.split("|")) log(l);
  await exit(1);
}
if (process.env.FAKE_FAIL_ARG !== undefined && args.includes(process.env.FAKE_FAIL_ARG)) {
  log("ggml_cuda: out of memory");
  await exit(1);
}
const server = serve(port, "127.0.0.1", async (req) => {
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
      timings: {
        prompt_n: Math.ceil(((body as { prompt?: string }).prompt ?? "").length / 4),
        prompt_per_second: Number(process.env.FAKE_PP ?? 1000),
        predicted_n: body.n_predict ?? 0,
        predicted_per_second: Number(process.env.FAKE_TG ?? 50),
        // A repeated raw prompt makes the model copy it: drafts almost all accepted (see server benchmark).
        ...(process.env.FAKE_DRAFT === "1" ? { draft_n: 40, draft_n_accepted: 40 } : {}),
      },
    });
  }
  if (path === "/v1/chat/completions" && req.method === "POST") return chat(req);
  if (path === "/slots") return file(`${dir}/slots-busy.json`);
  if (path === "/metrics") return file(`${dir}/metrics-after.txt`);
  if (path === "/props") return file(`${dir}/props.json`);
  return new Response("not found", { status: 404 });
});
const ANSWER = [
  "## Simulated reply\n\n",
  "Here is a **list**:\n\n- one\n- two\n- three\n\n",
  "| Flag | Value |\n|---|---|\n| `-ngl` | 99 |\n| `-c` | 40000 |\n\n",
  "```ts\nconst x: number = 42 // comment\nconsole.log(`x = ${x}`)\n```\n\n",
  "Raw HTML stays text: <b>html</b> <script>alert(1)</script>\n\n",
  "A [link](https://github.com/ggml-org/llama.cpp) and some `inline code`.",
];

/** Streamed OpenAI reply: reasoning (if enable_thinking) then Markdown, one chunk every FAKE_CHAT_DELAY_MS. */
async function chat(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    messages?: unknown[];
    stream?: boolean;
    max_tokens?: number;
    chat_template_kwargs?: { enable_thinking?: boolean };
  };
  // Simulated context: ~4 characters per token, FAKE_N_CTX tokens (like llama-server's refusal).
  const nCtx = Number(process.env.FAKE_N_CTX ?? 40192);
  const nPrompt = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
  if (nPrompt >= nCtx) {
    const message = `request (${nPrompt} tokens) exceeds the available context size (${nCtx} tokens), try increasing it`;
    return Response.json({ error: { code: 400, message, type: "exceed_context_size_error", n_prompt_tokens: nPrompt, n_ctx: nCtx } }, { status: 400 });
  }
  // Non-streamed (server benchmark): a whole reply with its timings.
  if (body.stream !== true) {
    return Response.json({
      choices: [{ index: 0, message: { role: "assistant", content: "x".repeat(body.max_tokens ?? 0) }, finish_reason: "length" }],
      timings: {
        prompt_n: nPrompt,
        prompt_per_second: Number(process.env.FAKE_PP ?? 1000),
        predicted_n: body.max_tokens ?? 0,
        predicted_per_second: Number(process.env.FAKE_TG ?? 50),
        ...(process.env.FAKE_DRAFT === "1" ? { draft_n: 40, draft_n_accepted: 19 } : {}),
      },
    });
  }
  const delay = Number(process.env.FAKE_CHAT_DELAY_MS ?? 60);
  const lines = Number(process.env.FAKE_CHAT_LINES ?? 0);
  const thinking = body.chat_template_kwargs?.enable_thinking !== false;
  const words = (s: string) => s.match(/\S+\s*|\s+/g) ?? [];
  const parts: { content?: string; reasoning_content?: string }[] = [
    ...(thinking ? words("Let me think about the question before answering. ").map((w) => ({ reasoning_content: w })) : []),
    ...ANSWER.flatMap(words).map((w) => ({ content: w })),
    ...Array.from({ length: lines }, (_, i) => ({ content: `\nLine ${i + 1} of a very long reply.` })),
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
          if (delay > 0) await sleep(delay);
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
  server.closeAllConnections();
  server.close();
  void exit(0);
});

if (process.env.FAKE_EXIT_AFTER_MS) {
  setTimeout(() => process.exit(Number(process.env.FAKE_EXIT_CODE ?? 1)), Number(process.env.FAKE_EXIT_AFTER_MS));
}
setInterval(() => {}, 1 << 30);
