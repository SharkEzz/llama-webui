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
const valueOf = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const port = Number(valueOf("--port") ?? 8080);
const host = valueOf("--host") ?? "127.0.0.1";
const slow = process.env.FAKE_SLOW_ARG !== undefined && args.includes(process.env.FAKE_SLOW_ARG);
const loadMs = slow ? Number(process.env.FAKE_SLOW_MS ?? 5000) : Number(process.env.FAKE_LOAD_MS ?? 300);
const t0 = Date.now();
const dir = import.meta.dirname;
const log = (s: string) => process.stderr.write(`0.00.000.000 I ${s}\n`);

log("srv  main: loading model");
log(`srv  main: cwd ${process.cwd()}`);
// FAKE_ECHO_ENV=A,B: one line per variable, its value as the fake sees it.
for (const name of (process.env.FAKE_ECHO_ENV ?? "").split(",").filter(Boolean)) {
  log(`srv  main: env ${name}=${process.env[name] ?? "(unset)"}`);
}
if (process.env.FAKE_EXIT_LINES !== undefined) {
  for (const l of process.env.FAKE_EXIT_LINES.split("|")) log(l);
  await exit(1);
}
if (process.env.FAKE_FAIL_ARG !== undefined && args.includes(process.env.FAKE_FAIL_ARG)) {
  log("ggml_cuda: out of memory");
  // FAKE_TAIL: a last line written without its newline.
  if (process.env.FAKE_TAIL !== undefined) process.stderr.write(process.env.FAKE_TAIL);
  await exit(1);
}
const sseEnabled = process.env.FAKE_SSE === "1";
const sseStages = (process.env.FAKE_SSE_STAGES ?? "text_model").split(",").filter(Boolean);
const sseStageOnly = process.env.FAKE_SSE_STAGE_ONLY === "1";
const sseMemory = {
  n_ctx: Number(process.env.FAKE_N_CTX ?? 40192),
  devices: [
    { kind: "device", name: "CUDA0", total: 24 * 1024 ** 3, free: 10 * 1024 ** 3, model: 12 * 1024 ** 3, context: 2 * 1024 ** 3, compute: 512 * 1024 ** 2 },
    { kind: "host", name: "Host", model: 0, context: 0, compute: 128 * 1024 ** 2 },
  ],
};
const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const sseEnc = new TextEncoder();
let sseLastEvent: unknown = null;
let isSleeping = false;
let isLoading = loadMs > 0;

function sseEmit(event: string, data?: Record<string, unknown>) {
  if (!sseEnabled) return;
  const payload = { model: "fake-model", event, ...(data === undefined ? {} : { data }) };
  sseLastEvent = payload;
  const bytes = sseEnc.encode(`data: ${JSON.stringify(payload)}\n\n`);
  for (const client of sseClients) {
    try {
      client.enqueue(bytes);
    } catch {
      sseClients.delete(client);
    }
  }
}

function enterSleep() {
  isSleeping = true;
  sseEmit("status_change", { status: "sleeping" });
}

function runLoadCycle(firstLoad: boolean) {
  isLoading = loadMs > 0;
  if (!sseEnabled) {
    if (loadMs > 0) setTimeout(() => { isLoading = false; }, loadMs);
    return;
  }
  sseEmit("status_change", { status: "loading" });
  if (loadMs <= 0) {
    isLoading = false;
    isSleeping = false;
    sseEmit("status_change", firstLoad ? { status: "loaded", info: { id: "fake-model" }, memory: sseMemory } : { status: "loaded" });
    return;
  }
  const steps = sseStages.flatMap((stage) => [
    { stage, value: 0 },
    { stage, value: 0.5 },
    { stage, value: 1 },
  ]);
  const stepMs = Math.max(10, Math.floor(loadMs / (steps.length + 1)));
  steps.forEach((step, idx) => {
    setTimeout(() => {
      sseEmit("status_change", {
        status: "loading",
        progress: sseStageOnly && step.stage === "mmproj_model" && step.value === 0
          ? { stage: step.stage }
          : { stages: sseStages, current: step.stage, value: step.value },
      });
    }, stepMs * idx);
  });
  setTimeout(() => {
    if (process.env.FAKE_SSE_FAIL === "1") {
      sseEmit("status_change", { status: "unloaded", exit_code: 1 });
      log("failed to load model");
      void exit(1);
      return;
    }
    isLoading = false;
    isSleeping = false;
    sseEmit("status_change", firstLoad ? { status: "loaded", info: { id: "fake-model" }, memory: sseMemory } : { status: "loaded" });
  }, loadMs);
}

function wakeIfSleeping() {
  if (!isSleeping) return;
  isSleeping = false;
  runLoadCycle(false);
}

const server = serve(port, host, async (req) => {
  const path = new URL(req.url).pathname;
  const loading = isLoading || Date.now() - t0 < loadMs;
  if (path === "/models/sse" && sseEnabled) {
    if (process.env.FAKE_SSE_STALL === "headers") {
      await new Promise<void>((done) => req.signal.addEventListener("abort", () => done(), { once: true }));
      return new Response(null, { status: 204 });
    }
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        if (process.env.FAKE_SSE_STALL === "events") {
          c.enqueue(sseEnc.encode(": waiting\n\n"));
        } else {
          sseClients.add(c);
          if (sseLastEvent !== null) c.enqueue(sseEnc.encode(`data: ${JSON.stringify(sseLastEvent)}\n\n`));
        }
        req.signal.addEventListener("abort", () => {
          sseClients.delete(c);
          try { c.close(); } catch {}
        });
      },
      cancel() {
        if (ctrl !== null) sseClients.delete(ctrl);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }
  if (path === "/health") return loading ? new Response('{"error":{"type":"unavailable_error"}}', { status: 503 }) : Response.json({ status: "ok" });
  if (loading) return new Response("", { status: 503 });
  if (path === "/test/sleep" && req.method === "POST" && sseEnabled) {
    enterSleep();
    return new Response(null, { status: 204 });
  }
  if (path === "/completion" && req.method === "POST") {
    wakeIfSleeping();
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
  if (path === "/v1/chat/completions" && req.method === "POST") {
    wakeIfSleeping();
    return chat(req);
  }
  if (path === "/slots") {
    wakeIfSleeping();
    return file(`${dir}/slots-busy.json`);
  }
  if (path === "/metrics") return file(`${dir}/metrics-after.txt`);
  if (path === "/props") return file(`${dir}/props.json`);
  return new Response("not found", { status: 404 });
});
runLoadCycle(true);
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

setTimeout(() => log(`srv  main: server is listening on http://${host}:${port}`), loadMs);

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
