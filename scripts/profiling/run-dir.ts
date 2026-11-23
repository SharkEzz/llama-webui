// A run on disk: `.cache/profiling/<run>/` with its results, its undo state, its data and its report.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arr, isRecord, parseJson } from './json.ts';
import type { Results } from './results.ts';

export const PROFILING_ROOT = resolve(import.meta.dirname, '../../.cache/profiling');

/** What the undo must clean up: written before each thing is started or created. */
export interface State {
  /** The tool's own process, while it runs: a run whose tool is alive is not left behind. */
  toolPid: number | null;
  toolStart: number | null;
  /** Each pid with its start time (`/proc/<pid>/stat` field 22): a pid reused by another process is not ours. */
  serverPid: number | null;
  serverStart: number | null;
  chromePid: number | null;
  chromeStart: number | null;
  conversations: number[];
  /** the default profile to put back, when the tool changed it */
  restoreDefaultProfile: { id: number | null } | null;
  profileStarted: boolean;
  /** the git worktree of a base ref (`--base`), with what was installed and built in it */
  worktree: string | null;
  /** the run's copy of the data directory (`--base`), in its `datadir` folder */
  dataCopy: boolean;
}

export const EMPTY_STATE: State = {
  toolPid: null,
  toolStart: null,
  serverPid: null,
  serverStart: null,
  chromePid: null,
  chromeStart: null,
  conversations: [],
  restoreDefaultProfile: null,
  profileStarted: false,
  worktree: null,
  dataCopy: false,
};

export interface RunDir {
  path: string;
  exists: () => boolean;
  file: (...parts: string[]) => string;
  /** the run's results, of whatever version it was written in (`compare` refuses another one) */
  readResults: () => Results;
  writeResults: (r: Results) => void;
  readState: () => State;
  writeState: (s: State) => void;
}

/** The top-level shape only: the version decides whether the rest can be read. */
function isResults(value: unknown): value is Results {
  return (
    isRecord(value) &&
    typeof value.version === 'number' &&
    isRecord(value.run) &&
    typeof value.run.name === 'string' &&
    Array.isArray(value.run.scenarios) &&
    isRecord(value.scenarios) &&
    Array.isArray(value.failed)
  );
}

const pid = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

function toState(value: unknown): State {
  if (!isRecord(value)) return { ...EMPTY_STATE };
  const restore = value.restoreDefaultProfile;
  return {
    toolPid: pid(value.toolPid),
    toolStart: pid(value.toolStart),
    serverPid: pid(value.serverPid),
    serverStart: pid(value.serverStart),
    chromePid: pid(value.chromePid),
    chromeStart: pid(value.chromeStart),
    conversations: arr(value.conversations).filter((c): c is number => typeof c === 'number'),
    restoreDefaultProfile: isRecord(restore) ? { id: typeof restore.id === 'number' ? restore.id : null } : null,
    profileStarted: value.profileStarted === true,
    worktree: typeof value.worktree === 'string' && value.worktree !== '' ? value.worktree : null,
    dataCopy: value.dataCopy === true,
  };
}

const writeJson = (path: string, data: unknown) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

export function runDir(name: string): RunDir {
  const path = join(PROFILING_ROOT, name);
  const file = (...parts: string[]) => join(path, ...parts);
  return {
    path,
    exists: () => existsSync(file('results.json')),
    file,
    readResults: () => {
      const value = parseJson(readFileSync(file('results.json'), 'utf8'));
      if (!isResults(value)) throw new Error(`${file('results.json')}: not the results of a profiling run`);
      return value;
    },
    writeResults: (r) => {
      mkdirSync(path, { recursive: true });
      writeJson(file('results.json'), r);
    },
    readState: () =>
      existsSync(file('state.json'))
        ? toState(parseJson(readFileSync(file('state.json'), 'utf8')))
        : { ...EMPTY_STATE },
    writeState: (s) => {
      mkdirSync(path, { recursive: true });
      writeJson(file('state.json'), s);
    },
  };
}
