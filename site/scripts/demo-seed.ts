/**
 * Fills the llama-webui *demo* instance with curated content for the website screenshots (see screenshots.ts).
 * It drives the real API, so it runs real models on the GPUs: never point it at your everyday instance.
 *
 *   bun scripts/demo-seed.ts <step…> [--base http://192.168.0.20:7861]
 *
 * Steps, in the usual order:
 *   setup     settings (onboarding done, llama-server on :8091, iGPU hidden) and the demo profiles
 *   bench     llama-bench and server runs on the 27B profile (stops the server while running)
 *   sweep     a small sweep on the 27B model, then validates its 2 best candidates on a real server
 *   start     starts the chat profile and waits until it is ready
 *   chat      one conversation (reasoning + code), the server must be running
 *   generate  starts a long generation and returns at once (to capture live telemetry), server running
 *   stop      stops llama-server
 *
 * The demo instance itself runs with a neutral home so no personal path shows up:
 *   env -u HF_TOKEN HOME=/home/demo PATH="/home/demo/llama.cpp/build/bin:$PATH" pnpm start --host 0.0.0.0 --port 7861
 * with /home/demo/models -> the real models folder and /home/demo/llama.cpp/build/bin hard-linked from the build.
 */
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { base: { type: 'string', default: 'http://192.168.0.20:7861' } },
});
const base = values.base.replace(/\/$/, '');

const MODELS = '/home/demo/models';
const M27B = 'Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf';
const MOE =
  'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF/IQ3_XXS/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf';
const MOE_Q2 = 'Q2_0/Qwen3.8-Flash-Next-GSQ-RCO-Q2_0-00001-of-00002.gguf';
const IGPU_KEY = '0000:0d:00.0';

const PROFILES = [
  {
    name: 'Qwen3.8 27B · chat (MTP)',
    model: M27B,
    mmproj: 'mmproj-Qwen3.8-27B-BF16.gguf',
    cwd: '~/models',
    // -sm layer (not tensor): with tensor split the buffers are reported on a "Meta()" device, so the Topology page
    // could only show an estimated split per card.
    args: ['-c', '32768', '-ngl', '99', '-dev', 'CUDA0,CUDA1', '-ts', '51,58', '-sm', 'layer', '-fa', 'on'].concat([
      '--spec-type',
      'draft-mtp',
      '-np',
      '1',
    ]),
    env: {},
  },
  {
    name: 'Qwen3.8 Flash-Next · 70 GB MoE',
    model: MOE,
    cwd: '~/models',
    args: ['-c', '65536', '-dev', 'CUDA0,CUDA1,ROCm0', '-fa', 'on', '--lazy-mode', 'on', '--load-mode', 'none'].concat([
      '--spec-type',
      'draft-mtp',
      '--spec-draft-n-max',
      '5',
      '--temp',
      '1.0',
      '--top-p',
      '0.95',
      '--top-k',
      '20',
    ]),
    env: {
      LLAMA_ARG_SPEC_DRAFT_MODEL: `${MODELS}/unsloth/Qwen3.8-Flash-Next-GGUF/mtp-Qwen3.8-Flash-Next-Q8_0.gguf`,
      GGML_CUDA_P2P: '1',
    },
  },
  {
    name: 'Qwen3.8 Flash-Next Q2 · dual CUDA',
    model: MOE_Q2,
    cwd: '~/models',
    args: ['-c', '24000', '-fa', 'on', '--load-mode', 'mmap', '-dev', 'CUDA0,CUDA1', '-ctk', 'q8_0', '-ctv', 'q8_0'],
    env: { GGML_CUDA_P2P: '1' },
  },
];

interface Profile {
  id: number;
  name: string;
}
interface BenchRun {
  id: number;
  status: string;
  pp: { tps: number } | null;
  tg: { tps: number } | null;
  error: string | null;
}
interface Sweep {
  id: number;
  status: string;
  counts: { total: number; ok: number; queued: number; running: number };
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? (init?.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? null : res.json()) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function profileByName(name: string): Promise<Profile> {
  const found = (await api<Profile[]>('/api/profiles')).find((p) => p.name === name);
  if (!found) throw new Error(`profile “${name}” not found: run the setup step first`);
  return found;
}

async function setup() {
  await api('/api/settings', {
    method: 'PATCH',
    body: { onboardingDone: true, port: 8091, hiddenGpus: [IGPU_KEY] },
  });
  const existing = new Map((await api<Profile[]>('/api/profiles')).map((p) => [p.name, p.id]));
  for (const profile of PROFILES) {
    const id = existing.get(profile.name);
    if (id === undefined) await api('/api/profiles', { body: profile });
    else await api(`/api/profiles/${id}`, { method: 'PUT', body: profile });
    console.log(`profile: ${profile.name}`);
  }
  const chat = await profileByName(PROFILES[0]!.name);
  await api('/api/settings', { method: 'PATCH', body: { defaultProfileId: chat.id } });
}

async function waitBench(id: number): Promise<BenchRun> {
  for (;;) {
    const { runs } = await api<{ runs: BenchRun[] }>('/api/bench/runs?limit=100');
    const run = runs.find((r) => r.id === id);
    if (run && !['queued', 'running'].includes(run.status)) return run;
    await sleep(2000);
  }
}

async function bench() {
  const chat = await profileByName(PROFILES[0]!.name);
  const modelPath = `${MODELS}/${M27B}`;
  const dual = { ngl: 'all', dev: ['CUDA0', 'CUDA1'], ts: [51, 58], fa: 'on' } as const;
  const specs = [
    { kind: 'bench', modelPath, params: { ngl: 'all', dev: ['CUDA0'], fa: 'on' } },
    { kind: 'bench', modelPath, params: { ...dual, sm: 'layer' } },
    { kind: 'bench', modelPath, params: { ...dual, sm: 'tensor' } },
    { kind: 'bench', modelPath, params: { ...dual, sm: 'tensor', ctk: 'q8_0', ctv: 'q8_0' } },
    { ...(await api<object>(`/api/bench/from-profile/${chat.id}`)), kind: 'server', profileId: chat.id },
  ];
  for (const spec of specs) {
    const run = await api<BenchRun>('/api/bench/run', { body: { spec, stopServer: true } });
    const done = await waitBench(run.id);
    console.log(`bench #${done.id} ${done.status} pp=${done.pp?.tps.toFixed(0)} tg=${done.tg?.tps.toFixed(1)}`);
  }
}

async function waitSweep(id: number) {
  for (;;) {
    const { sweep } = await api<{ sweep: Sweep }>(`/api/sweeps/${id}`);
    if (sweep.status !== 'running') return sweep;
    await sleep(3000);
  }
}

async function sweep() {
  const spec = {
    name: '27B on two RTX cards',
    modelPath: `${MODELS}/${M27B}`,
    preset: 'chat',
    base: { ngl: 'all', fa: 'on' },
    space: { dev: [['CUDA0'], ['CUDA0', 'CUDA1']], sm: ['layer', 'tensor'], ctk: ['f16', 'q8_0'] },
    r: 2,
  };
  const { sweep } = await api<{ sweep: Sweep }>('/api/sweeps', { body: { spec, stopServer: true } });
  const explored = await waitSweep(sweep.id);
  console.log(`sweep #${sweep.id} explored: ${explored.counts.ok}/${explored.counts.total} ok`);
  await api(`/api/sweeps/${sweep.id}/validate`, { body: { n: 2, stopServer: true } });
  const validated = await waitSweep(sweep.id);
  console.log(`sweep #${sweep.id} ${validated.status}`);
}

async function start() {
  const chat = await profileByName(PROFILES[0]!.name);
  const current = await api<{ state: { kind: string }; profileId: number | null }>('/api/server/state');
  if (current.state.kind === 'ready' && current.profileId === chat.id) return console.log('llama-server already ready');
  await api(current.state.kind === 'idle' ? '/api/server/start' : '/api/server/switch', {
    body: { profileId: chat.id },
  });
  for (;;) {
    const { state } = await api<{ state: { kind: string } }>('/api/server/state');
    if (state.kind === 'ready') break;
    if (state.kind === 'crashed' || state.kind === 'idle') throw new Error(`llama-server ${state.kind}`);
    await sleep(1000);
  }
  console.log('llama-server ready');
}

/** Sends a message and consumes the SSE stream until the answer is done. */
async function send(conversationId: number, content: string, wait = true) {
  const res = await fetch(`${base}/api/chat/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok || !res.body) throw new Error(`send: ${res.status} ${await res.text()}`);
  if (!wait) {
    // The generation belongs to the server: dropping the stream does not stop it.
    await res.body.cancel();
    return;
  }
  await res.text();
}

async function chat() {
  const chatProfile = await profileByName(PROFILES[0]!.name);
  const title = 'Tensor split for two GPUs';
  for (const old of await api<{ id: number; title: string }[]>('/api/chat')) {
    if (old.title === title) await api(`/api/chat/${old.id}`, { method: 'DELETE' });
  }
  const conversation = await api<{ id: number }>('/api/chat', { body: { profileId: chatProfile.id } });
  await api(`/api/chat/${conversation.id}`, {
    method: 'PATCH',
    body: {
      systemPrompt: 'You are a concise assistant for llama.cpp users. Keep your reasoning brief.',
      sampling: { max_tokens: 16384 },
    },
  });
  await send(
    conversation.id,
    'I have two GPUs with 15.2 GiB and 13.8 GiB of free VRAM. Briefly explain how llama.cpp --tensor-split ' +
      'works, then write a small TypeScript function that turns free VRAM per GPU into a --tensor-split value.',
  );
  await api(`/api/chat/${conversation.id}`, { method: 'PATCH', body: { title } });
  console.log(`conversation #${conversation.id} done`);
}

async function generate() {
  const chatProfile = await profileByName(PROFILES[0]!.name);
  const title = 'Live telemetry (capture)';
  for (const old of await api<{ id: number; title: string }[]>('/api/chat')) {
    if (old.title === title) await api(`/api/chat/${old.id}`, { method: 'DELETE' });
  }
  const conversation = await api<{ id: number }>('/api/chat', { body: { profileId: chatProfile.id } });
  await api(`/api/chat/${conversation.id}`, {
    method: 'PATCH',
    body: { title, thinking: false, sampling: { max_tokens: 400 } },
  });
  // A few short answers first, so the dashboard's "Recent requests" table has rows.
  for (const topic of ['KV cache quantization', 'flash attention', 'speculative decoding']) {
    await send(conversation.id, `In three sentences, what does ${topic} change for local inference speed?`);
  }
  await api(`/api/chat/${conversation.id}`, { method: 'PATCH', body: { sampling: { max_tokens: 9000 } } });
  await send(
    conversation.id,
    'Write a detailed, well-structured technical guide (at least 3000 words) on running large language models ' +
      'locally on consumer GPUs: quantization formats, KV cache, multi-GPU splits, MoE offloading and benchmarking.',
    false,
  );
  console.log(`generation started in conversation #${conversation.id}`);
}

async function stop() {
  await api('/api/server/stop', { body: {} });
  console.log('llama-server stopping');
}

const STEPS: Record<string, () => Promise<void>> = { setup, bench, sweep, start, chat, generate, stop };
if (positionals.length === 0) throw new Error(`usage: demo-seed.ts <${Object.keys(STEPS).join('|')}>…`);
for (const step of positionals) {
  const run = STEPS[step];
  if (!run) throw new Error(`unknown step “${step}”`);
  console.log(`— ${step}`);
  await run();
}
