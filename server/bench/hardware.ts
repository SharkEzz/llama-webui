import type { BenchDevice, BenchHardware, GpuSample } from "@llama-webui/shared";
import { readCpuInfo } from "../hardware/cpu";
import { parseDeviceList } from "./parse";

const VERSION = /build (\d+), commit (\w+)/;
const builds = new Map<string, Promise<string | null>>();
const devices = new Map<string, Promise<BenchDevice[]>>();
let cpu: Promise<string> | null = null;

/** Sortie d'une commande courte (stdout + stderr), tuée après `timeoutMs`. */
async function output(argv: string[], timeoutMs = 5000): Promise<string> {
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return `${out}\n${err}`;
}

/** « b12119 (6f1e65437) » d'après `<binaire> --version`, mis en cache par binaire et date de modification (une recompilation est relue) ; null si illisible. */
export async function buildOf(binary: string): Promise<string | null> {
  const path = Bun.which(binary) ?? binary;
  const mtime = await Bun.file(path)
    .stat()
    .then(
      (s) => s.mtimeMs,
      () => 0,
    );
  const key = `${path}:${mtime}`;
  let p = builds.get(key);
  if (!p) {
    p = output([binary, "--version"]).then(
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

/** Le matériel au moment du run, figé dans `hardware_json`. */
export async function readHardware(binary: string, gpus: GpuSample[]): Promise<BenchHardware> {
  cpu ??= readCpuInfo().then(
    (c) => c.model,
    () => "",
  );
  return {
    cpu: await cpu,
    gpus: gpus.map((g) => ({ name: g.name, busId: g.busId, vramTotalBytes: g.vramTotalBytes })),
    build: await buildOf(binary),
  };
}

/** `llama-bench --list-devices`, mis en cache par binaire ; [] si l'outil manque ou échoue (pas mis en cache). */
export function listDevices(benchBinary: string): Promise<BenchDevice[]> {
  let p = devices.get(benchBinary);
  if (!p) {
    p = output([benchBinary, "--list-devices"], 15_000).then(parseDeviceList, () => []);
    devices.set(benchBinary, p);
    void p.then((d) => d.length === 0 && devices.delete(benchBinary));
  }
  return p;
}
