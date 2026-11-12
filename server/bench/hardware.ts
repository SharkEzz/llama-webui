import { stat } from 'node:fs/promises';
import type { BenchDevice, BenchHardware, GpuSample } from '@llama-webui/shared';
import { parseDeviceList } from 'llamacpp-js/bench';
import { readCpuInfo } from '../hardware/cpu';
import { spawnProc, which } from '../proc';

const VERSION = /build (\d+), commit (\w+)/;
const builds = new Map<string, Promise<string | null>>();
const devices = new Map<string, Promise<DeviceList>>();
/** Last complete list per binary: what a failed listing falls back to. */
const lastGood = new Map<string, BenchDevice[]>();
let cpu: Promise<string> | null = null;

/** Output of a short command (stdout + stderr), killed after `timeoutMs`; rejects when it fails or crashes. */
async function output(argv: string[], timeoutMs = 5000): Promise<string> {
  const proc = spawnProc(argv, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (proc.signalCode) throw new OutputError(`killed by ${proc.signalCode}`, `${out}\n${err}`);
  if (proc.exitCode !== 0) throw new OutputError(`exited with code ${proc.exitCode}`, `${out}\n${err}`);
  return `${out}\n${err}`;
}

class OutputError extends Error {
  override name = 'OutputError';
  constructor(
    message: string,
    readonly text: string,
  ) {
    super(message);
  }
}

/** Modification time of a binary (looked up in the PATH), 0 if unreadable: part of the cache keys. */
const mtimeOf = (binary: string): Promise<number> =>
  stat(which(binary) ?? binary).then(
    (s) => s.mtimeMs,
    () => 0,
  );

/** “b12119 (6f1e65437)” from `<binary> --version`, cached per binary and modification time (a rebuild is read again); null if unreadable. */
export async function buildOf(binary: string): Promise<string | null> {
  const key = `${which(binary) ?? binary}:${await mtimeOf(binary)}`;
  let p = builds.get(key);
  if (!p) {
    p = output([binary, '--version']).then(
      (text) => {
        const m = VERSION.exec(text);
        return m ? `b${m[1]} (${m[2]})` : null;
      },
      () => null,
    );
    builds.set(key, p);
  }
  return p;
}

/** The hardware at the time of the run, frozen in `hardware_json`. */
export async function readHardware(binary: string, gpus: GpuSample[]): Promise<BenchHardware> {
  cpu ??= readCpuInfo().then(
    (c) => c.model,
    () => '',
  );
  return {
    cpu: await cpu,
    gpus: gpus.map((g) => ({ name: g.name, busId: g.busId, vramTotalBytes: g.vramTotalBytes })),
    build: await buildOf(binary),
  };
}

export interface DeviceList {
  devices: BenchDevice[];
  /** Why the listing is not trusted (the tool crashed, a GPU without memory); the devices are then the last good list. */
  error: string | null;
}

/** Backends whose devices own memory: one listed with 0 MiB means the listing went wrong (BLAS, CPU… have none). */
const GPU_BACKEND = /^(CUDA|ROCm|HIP|Vulkan|MUSA|SYCL|Metal|OpenCL|CANN)$/;

async function readDeviceList(benchBinary: string): Promise<DeviceList> {
  let text: string;
  try {
    text = await output([benchBinary, '--list-devices'], 15_000);
  } catch (e) {
    // A crash while llama-server runs prints a truncated list (#15): never trust it.
    const why = e instanceof OutputError ? `llama-bench --list-devices ${e.message}` : (e as Error).message;
    return { devices: lastGood.get(benchBinary) ?? [], error: why };
  }
  const list = parseDeviceList(text);
  const empty = list.find((d) => GPU_BACKEND.test(d.backend) && d.totalMib <= 0);
  if (empty) return { devices: lastGood.get(benchBinary) ?? list, error: `${empty.id} listed without memory` };
  if (list.length > 0) lastGood.set(benchBinary, list);
  return { devices: list, error: null };
}

/**
 * `llama-bench --list-devices`, cached per binary and modification time. A failed listing (missing tool, crash,
 * GPU without memory) is not cached and falls back to the last good list ([] if none). The free memory in the list
 * is a snapshot from the first read: the live one comes from the monitor (`readTuningHardware`).
 */
export async function listDevicesResult(benchBinary: string): Promise<DeviceList> {
  const key = `${benchBinary}:${await mtimeOf(benchBinary)}`;
  let p = devices.get(key);
  if (!p) {
    p = readDeviceList(benchBinary);
    devices.set(key, p);
    void p.then((r) => (r.error || r.devices.length === 0) && devices.delete(key));
  }
  return p;
}

/** The devices of `listDevicesResult`. */
export const listDevices = (benchBinary: string): Promise<BenchDevice[]> =>
  listDevicesResult(benchBinary).then((r) => r.devices);
