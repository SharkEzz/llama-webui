import { expect, test } from "bun:test";
import type { ChatEvent } from "@llama-webui/shared";
import { ConversationsRepo } from "../db/conversations";
import { openDb } from "../db/open";
import { ChatRuns } from "./runs";

const enc = new TextEncoder();
const chunk = (delta: Record<string, string>, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta }], ...extra })}\n\n`;
const TIMINGS = { prompt_n: 10, prompt_per_second: 200, predicted_n: 3, predicted_per_second: 51.23 };
const tick = () => Bun.sleep(5);

/** Un llama-server simulé : le test pousse les morceaux du flux un par un. */
function setup() {
  const repo = new ConversationsRepo(openDb(":memory:"));
  const conv = repo.create({ profileId: null, modelPath: "/m.gguf" });
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  let body: Record<string, unknown> = {};
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    signal = init!.signal!;
    body = JSON.parse(String(init!.body));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
      },
    });
    signal.addEventListener("abort", () => ctl.error(new DOMException("aborted", "AbortError")));
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const runs = new ChatRuns({ repo, target: () => ({ port: 8080, profileId: null, modelPath: "/m.gguf" }), fetch: fetchFn, flushMs: 0 });
  return {
    repo,
    conv,
    runs,
    push: async (s: string) => {
      ctl.enqueue(enc.encode(s));
      await tick();
    },
    end: () => ctl.close(),
    signal: () => signal,
    body: () => body,
  };
}

const answer = (repo: ConversationsRepo, id: number) => repo.messages(id).find((m) => m.role === "assistant")!;

test("a run keeps going and is saved when its listener leaves", async () => {
  const t = setup();
  const run = t.runs.send(t.conv.id, "Salut toi");
  const events: ChatEvent[] = [];
  const leave = run.subscribe((e) => events.push(e));
  await tick();
  await t.push(chunk({ reasoning_content: "Hmm." }));
  leave();
  await t.push(chunk({ content: "Bonjour" }));
  await t.push(chunk({ content: " !" }));
  await t.push(chunk({}, { timings: TIMINGS }));
  await t.push("data: [DONE]\n\n");
  t.end();
  await run.done;
  expect(events.map((e) => e.type)).toEqual(["start", "delta"]);
  const a = answer(t.repo, t.conv.id);
  expect([a.status, a.content, a.reasoning]).toEqual(["done", "Bonjour !", "Hmm."]);
  expect(a.stats?.tgTps).toBe(51.23);
  expect(a.stats?.ttftMs).not.toBeNull();
  expect(t.repo.conversation(t.conv.id)!.title).toBe("Salut toi");
  expect(t.runs.live(t.conv.id)).toBeUndefined();
});

test("stop saves the partial answer as stopped", async () => {
  const t = setup();
  const run = t.runs.send(t.conv.id, "Salut");
  await tick();
  await t.push(chunk({ content: "Bon" }));
  expect(t.runs.stop(t.conv.id)).toBe(true);
  await run.done;
  const a = answer(t.repo, t.conv.id);
  expect([a.status, a.content]).toEqual(["stopped", "Bon"]);
  expect(t.signal().aborted).toBe(true);
});

test("a late subscriber gets what was already written", async () => {
  const t = setup();
  const run = t.runs.send(t.conv.id, "Salut");
  await tick();
  await t.push(chunk({ content: "Bon" }));
  await t.push(chunk({ content: "jour" }));
  const events: ChatEvent[] = [];
  run.subscribe((e) => events.push(e));
  await t.push(chunk({ content: " !" }));
  t.end();
  await run.done;
  expect(events[0]!.type).toBe("start");
  expect(events[1]).toEqual({ type: "delta", content: "Bonjour" });
  expect(events[2]).toEqual({ type: "delta", content: " !" });
  expect(events.at(-1)!.type).toBe("done");
});
