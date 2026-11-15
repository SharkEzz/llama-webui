import {
  LAUNCH_LOG_PREFIX,
  type LogLine,
  type ModelPlacement,
  P2P_LOG_LINE,
  type P2pStatus,
  type PlacementBuffer,
} from '@llama-webui/shared';
import { Array as Arr, Option, String as Str } from 'effect';

/*
 * How the loaded model is split across devices, read from llama-server's startup logs: “using device CUDA0
 * (…) (0000:01:00.0)”, “CUDA0 model buffer size = 12441.95 MiB”, “offloaded 49/49 layers to GPU”… llama-server
 * doesn't expose these figures through its API, and only logs the buffer sizes from -lv 4 on: `buildCommand()` adds
 * `-lv 4` to a profile that sets no verbosity.
 */

const MiB = 1024 ** 2;

/** The line llama-webui writes before each launch: the placement is read from the lines after the last one. */
export const LAUNCH_MARK = LAUNCH_LOG_PREFIX;

/** Optional llama.cpp prefix (“0.11.852.017 I”), kept in `LogLine.text`. */
const PREFIX = /^(?:\d+\.\d+(?:\.\d+)*\s+[IWEDT]\s+)?/;
const USING = /using device (\S+) \(.*\) \(([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])\)/i;
const LAYERS = /offloaded (\d+)\/(\d+) layers to GPU/;
/** `RS`: state of a hybrid model's recurrent layers (Mamba, DeltaNet…), the equivalent of their KV cache. */
const BUFFER = /(\S+) (model|KV|RS|compute) buffer size =\s*([\d.]+) MiB/;
/** A new context (the main one, then the draft's or the MTP's): it has its own compute buffers. */
const CONTEXT = /llama_context: constructing llama_context/;
/** New reservation of the current context: its compute buffers replace those of the previous one. */
const RESERVE = /sched_reserve: reserving/;
/** Multimodal projector buffers (mmproj, clip.cpp): not the model, and estimated before it is even loaded. */
const MMPROJ = /^(?:clip\w*|(?:reserve|alloc)_compute_meta):/;
/**
 * Start and end of fitting to memory (-fit, on by default), the end being written whatever the outcome. Its probes
 * load the model without allocating (layers, 0 MiB buffers, contexts, then the draft or the MTP): at -lv 5, their lines
 * come out in between and are not the real load.
 */
const FIT_START = /fitting params to device memory \.\.\./;
const FIT_DONE = /common_fit_params: fitting params to free memory took/;
/** One device of the Meta device that -sm tensor creates: its buffers are logged as `Meta()`, at their largest. */
const META_MEMBER = /llama_prepare_model_devices: - device \d+: (\S+)/;
const META = /^Meta\(/;
/** -ts / --tensor-split on the launch line: “3,1”, “3/1”, “-ts=3,1”. */
const TENSOR_SPLIT = /(?:^|\s)(?:-ts|--tensor-split)(?:=|\s+)(\S+)/;

/** A line that can change the placement: avoids rereading the whole ring on every batch of request logs. */
export const RELEVANT =
  /\[llama-webui\] launch:|GGML_CUDA_P2P|using device|buffer size =|offloaded \d+\/\d+ layers|- device \d+:|NCCL INFO (?:Channel|P2P is disabled|.*ncclCommInitAll)/;

/** The buffers of a device while they are summed. */
interface Tally {
  readonly device: string;
  busId: string | null;
  modelBytes: number;
  kvBytes: number;
  computeBytes: number;
  estimated: boolean;
}

const tallyOf = (device: string, busId: string | null): Tally => ({
  device,
  busId,
  modelBytes: 0,
  kvBytes: 0,
  computeBytes: 0,
  estimated: false,
});

const bufferOf = (t: Tally): PlacementBuffer => ({
  device: t.device,
  busId: t.busId,
  modelBytes: t.modelBytes,
  kvBytes: t.kvBytes,
  computeBytes: t.computeBytes,
  ...(t.estimated ? { estimated: true } : {}),
});

/** The `i`-th group of a match, empty when it did not take part. */
const group = (match: RegExpExecArray, i: number): string => match[i] ?? '';

/**
 * Placement of the main model from the last launch found in `lines`; null without a launch line (ring cleared or
 * evicted). llama-server loads the main model (weights, KV cache, compute), then the optional draft (-md), then the
 * mmproj: the second “offloaded N/M layers” opens the draft and ends the parsing. Compute is counted per context
 * (an MTP's adds to the model's) and a context reserved again keeps only its last size.
 * The fitting probes (-fit, visible at -lv 5) come before the load: they are skipped.
 */
export const parsePlacement = (lines: ReadonlyArray<LogLine>): ModelPlacement | null =>
  Arr.findLastIndex(lines, (line) => Str.startsWith(LAUNCH_MARK)(line.text)).pipe(
    Option.flatMap((start) => Option.map(Arr.get(lines, start), (launch) => placementAt(lines, start, launch))),
    Option.getOrNull,
  );

const placementAt = (lines: ReadonlyArray<LogLine>, start: number, launch: LogLine): ModelPlacement => {
  const after = Arr.drop(lines, start + 1);
  const busIds = ncclBusIds(after);
  const buffers = new Map<string, Tally>();
  let layers: ModelPlacement['layers'] = null;
  // Compute per context then per device; an implicit first context for logs without “constructing”.
  let context = new Map<string, number>();
  const contexts = [context];
  let constructed = false;
  let fitting = false;
  const metaMembers: Array<string> = [];
  for (const line of after) {
    const body = Str.replace(PREFIX, '')(line.text);
    if (FIT_START.test(body)) fitting = true;
    else if (FIT_DONE.test(body)) fitting = false;
    if (fitting) continue;
    if (CONTEXT.test(body)) {
      if (constructed) {
        context = new Map();
        contexts.push(context);
      }
      constructed = true;
      continue;
    }
    if (RESERVE.test(body)) {
      context.clear();
      continue;
    }
    const member = META_MEMBER.exec(body);
    if (member !== null) {
      metaMembers.push(group(member, 1));
      continue;
    }
    const using = USING.exec(body);
    if (using !== null) {
      busIds.set(group(using, 1), Str.toLowerCase(group(using, 2)));
      continue;
    }
    const offloaded = LAYERS.exec(body);
    if (offloaded !== null) {
      if (layers !== null) break;
      const [done, total] = [Number(group(offloaded, 1)), Number(group(offloaded, 2))];
      // A count too long to be an integer is not one llama-server writes: the line is left out.
      if (Number.isSafeInteger(done) && Number.isSafeInteger(total)) layers = { offloaded: done, total };
      continue;
    }
    const buffer = BUFFER.exec(body);
    if (buffer === null || MMPROJ.test(body)) continue;
    const size = Number(group(buffer, 3));
    // `[\d.]+` also matches “1.2.3”: a size that is not a number is left out.
    if (!Number.isFinite(size)) continue;
    const device = group(buffer, 1);
    const tally = buffers.get(device) ?? tallyOf(device, null);
    buffers.set(device, tally);
    const bytes = size * MiB;
    const kind = group(buffer, 2);
    if (kind === 'model') tally.modelBytes += bytes;
    else if (kind === 'KV' || kind === 'RS') tally.kvBytes += bytes;
    else context.set(device, (context.get(device) ?? 0) + bytes);
  }
  for (const ctx of contexts) {
    for (const [device, bytes] of ctx) {
      const tally = buffers.get(device);
      if (tally !== undefined) tally.computeBytes += bytes;
    }
  }
  for (const tally of buffers.values()) tally.busId = busIds.get(tally.device) ?? null;
  const spread = spreadMeta(Arr.fromIterable(buffers.values()), metaMembers, launch.text, busIds);
  return {
    launchSeq: launch.seq,
    layers,
    buffers: Arr.map(spread, bufferOf),
    ...Option.match(parseP2p(after), { onNone: () => ({}), onSome: (p2p) => ({ p2p }) }),
  };
};

/** NCCL (with `NCCL_DEBUG=INFO`): a rank's CUDA device and its PCI address, as hex digits without separators. */
const NCCL_RANK = /NCCL INFO .*ncclCommInitAll .* cudaDev (\d+) nvmlDev \d+ busId ([0-9a-f]+) /;

/**
 * PCI address of the CUDA devices NCCL names. With -sm tensor, llama-server's own lines only know the `Meta()` device,
 * without an address: this is what ties `CUDA0` to a card. An address llama-server logs itself replaces it.
 */
const ncclBusIds = (lines: ReadonlyArray<LogLine>): Map<string, string> => {
  const out = new Map<string, string>();
  for (const line of lines) {
    const rank = NCCL_RANK.exec(line.text);
    if (rank === null) continue;
    // “3000” is 0000:03:00.0: domain (4 digits), bus (2), device (2), function (1).
    const id = Str.padStart(9, '0')(group(rank, 2));
    out.set(
      `CUDA${group(rank, 1)}`,
      `${Str.slice(0, 4)(id)}:${Str.slice(4, 6)(id)}:${Str.slice(6, 8)(id)}.${Str.slice(8)(id)}`,
    );
  }
  return out;
};

/** NCCL (with `NCCL_DEBUG=INFO`): transport of a channel between two GPUs, “P2P/CUMEM”, “SHM/direct”… */
const NCCL_CHANNEL = /NCCL INFO Channel \d+ : \d+\[\d+\] -> \d+\[\d+\] via (\S+)/;
const NCCL_NO_P2P = /NCCL INFO P2P is disabled between connected GPUs/;

/**
 * Peer-to-peer of the launch whose lines are `lines`. llama.cpp enables it where the driver allows as soon as
 * `GGML_CUDA_P2P` is set (llama-webui's own line says so) and logs nothing; NCCL, when it is built in and
 * `NCCL_DEBUG=INFO`, says how its channels reach the other GPU, which depends on the same driver capability. Read over
 * the whole launch: NCCL starts with the context, after the lines of a draft model.
 */
const parseP2p = (lines: ReadonlyArray<LogLine>): Option.Option<P2pStatus> => {
  let requested = false;
  let direct = false;
  let refused = false;
  for (const { text } of lines) {
    if (text === P2P_LOG_LINE) requested = true;
    else if (NCCL_NO_P2P.test(text)) refused = true;
    else {
      const via = Option.fromNullishOr(NCCL_CHANNEL.exec(text)?.[1]);
      if (Option.exists(via, Str.startsWith('P2P'))) direct = true;
      else if (Option.exists(via, Str.startsWith('SHM'))) refused = true;
    }
  }
  if (direct) return Option.some('active');
  if (!requested) return Option.none();
  return Option.some(refused ? 'unavailable' : 'requested');
};

/**
 * With -sm tensor, llama-server logs the buffers of the Meta device that groups the GPUs (`Meta()`), each at the size
 * of its largest per-device part. Each member gets its share: `size × ts[i] / max(ts)` for the model and the cache
 * (equal parts without -ts), the whole compute buffer (each device has its own). These figures are `estimated`.
 */
const spreadMeta = (
  buffers: ReadonlyArray<Tally>,
  members: ReadonlyArray<string>,
  launch: string,
  busIds: ReadonlyMap<string, string>,
): ReadonlyArray<Tally> => {
  const isMeta = (b: Tally) => META.test(b.device);
  const meta = Arr.filter(buffers, isMeta);
  if (!Arr.isReadonlyArrayNonEmpty(meta) || !Arr.isReadonlyArrayNonEmpty(members)) return buffers;
  const split = Option.fromNullishOr(TENSOR_SPLIT.exec(launch)?.[1]).pipe(
    Option.map((ts) => Arr.map(Str.split(ts, /[,/]/), Number)),
    Option.getOrElse((): ReadonlyArray<number> => []),
  );
  const weights = Arr.map(members, (_, i) =>
    Arr.isReadonlyArrayEmpty(split)
      ? 1
      : Option.getOrElse(
          Option.filter(Arr.get(split, i), (w) => Number.isFinite(w) && w >= 0),
          () => 0,
        ),
  );
  const max = Math.max(...weights);
  if (!(max > 0)) return buffers;
  const out = Arr.filter(buffers, (b) => !isMeta(b));
  Arr.forEach(members, (device, i) => {
    const share = (weights[i] ?? 0) / max;
    const tally = Option.getOrElse(
      Arr.findFirst(out, (x) => x.device === device),
      () => {
        const added = tallyOf(device, busIds.get(device) ?? null);
        out.push(added);
        return added;
      },
    );
    for (const m of meta) {
      tally.modelBytes += m.modelBytes * share;
      tally.kvBytes += m.kvBytes * share;
      tally.computeBytes += share > 0 ? m.computeBytes : 0;
    }
    tally.estimated = true;
  });
  return out;
};
