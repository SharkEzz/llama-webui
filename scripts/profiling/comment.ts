// The `/profiling` comment of a pull request, for `.github/workflows/profiling.yml`: the comment's words turned into
// the arguments of `pnpm profiling` (nothing a person wrote reaches a shell otherwise), and the answer posted back.
//
//   node scripts/profiling/comment.ts args    PROFILING_COMMENT → the arguments on stdout; exit 2 with the usage
//   node scripts/profiling/comment.ts reply   the answer in Markdown on stdout, from the PROFILING_* variables
import { existsSync, readFileSync } from 'node:fs';
import { isScenarioName, SCENARIO_NAMES } from './results.ts';
import { runDir } from './run-dir.ts';

export const COMMAND = '/profiling';

export const COMMENT_USAGE = `Usage: \`${COMMAND} [scenario…|all] [--profile <id>]\`, on the first line of the comment.

- Scenarios: ${SCENARIO_NAMES.map((s) => `\`${s}\``).join(', ')}, or \`all\` (the default).
- \`--profile <id>\`: the profile the scenarios with a model launch, instead of the default one.`;

export type ParsedComment = { ok: true; args: string[] } | { ok: false; error: string };

/**
 * The arguments a comment asks for: scenario names, `all`, `--profile <integer>`; no scenario means `all`. Only the
 * first line is read. Every word is checked against that list, so the result holds nothing but scenario names,
 * `--profile` and digits.
 */
export function parseComment(body: string): ParsedComment {
  const [command, ...words] = (body.split(/\r?\n/)[0] ?? '').trim().split(/\s+/);
  if (command !== COMMAND) return { ok: false, error: `the comment does not start with \`${COMMAND}\`` };
  const scenarios: string[] = [];
  let profile: string | null = null;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    if (word === 'all' || isScenarioName(word)) {
      if (!scenarios.includes(word)) scenarios.push(word);
      continue;
    }
    const inline = /^--profile=(.*)$/.exec(word)?.[1];
    if (word === '--profile' || inline !== undefined) {
      const id = inline ?? words[++i] ?? '';
      if (!/^\d{1,9}$/.test(id)) return { ok: false, error: '`--profile` takes a profile id, a positive integer' };
      profile = id;
      continue;
    }
    // The word itself is not echoed: it is whatever a person typed.
    return { ok: false, error: `word ${String(i + 1)} after \`${COMMAND}\` is neither a scenario nor \`--profile\`` };
  }
  return {
    ok: true,
    args: [...(scenarios.length === 0 ? ['all'] : scenarios), ...(profile === null ? [] : ['--profile', profile])],
  };
}

/** `text` with each path replaced by its placeholder, the longest path first: no path of the runner is published. */
export function withoutPaths(text: string, paths: Record<string, string | undefined>): string {
  const known = Object.entries(paths)
    .flatMap(([placeholder, path]) => (path === undefined || path.length < 2 ? [] : [{ placeholder, path }]))
    .toSorted((a, b) => b.path.length - a.path.length);
  return known.reduce((out, { placeholder, path }) => out.replaceAll(path, placeholder), text);
}

/** The lines of a log a person reads: no ANSI colour, the last `count`. */
export function lastLines(log: string, count: number): string {
  // oxlint-disable-next-line no-control-regex -- ESC opens every ANSI colour sequence a build writes to a log
  const plain = log.replaceAll(/\u001B\[[0-9;]*[A-Za-z]/g, '');
  return plain
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-count)
    .join('\n');
}

export interface ReplyInput {
  /** the run's summary.md, null when the pass wrote none */
  summary: string | null;
  /** the tool's exit code, null when it never started */
  exitCode: number | null;
  /** the tool's output */
  log: string;
  sha: string;
  base: string;
  runUrl: string;
  paths: Record<string, string | undefined>;
}

/** The comment posted back: the comparison when there is one, else why there is none. */
export function reply(input: ReplyInput): string {
  const foot = `Commit \`${input.sha.slice(0, 9)}\` against \`${input.base}\` · [workflow run](${input.runUrl})`;
  const tail = lastLines(input.log, 20);
  const output = tail === '' ? '' : `\n\n\`\`\`text\n${tail.replaceAll('```', "'''")}\n\`\`\``;
  let body: string;
  if (input.summary !== null) {
    const failed = input.exitCode !== null && input.exitCode !== 0;
    body = `${input.summary.trimEnd()}${failed ? `\n\nThe command ended with exit code ${String(input.exitCode)}.` : ''}`;
  } else if (input.exitCode === null)
    body = `## Profiling did not start\n\nThe job failed before the measure.${output}`;
  else if (input.exitCode === 2) body = `## Profiling refused to run${output}`;
  else
    body = `## Profiling failed\n\nThe command ended with exit code ${String(input.exitCode)}, without a comparison.${output}`;
  return `${withoutPaths(body, input.paths)}\n\n${foot}\n`;
}

function main(argv: string[], env: NodeJS.ProcessEnv): number {
  const [command] = argv;
  if (command === 'args') {
    const parsed = parseComment(env.PROFILING_COMMENT ?? '');
    if (!parsed.ok) {
      process.stderr.write(`\`${COMMAND}\` was not understood: ${parsed.error}.\n\n${COMMENT_USAGE}\n`);
      return 2;
    }
    process.stdout.write(`${parsed.args.join(' ')}\n`);
    return 0;
  }
  if (command === 'reply') {
    const name = env.PROFILING_RUN ?? '';
    const summaryFile = name === '' ? null : runDir(name).file('summary.md');
    const logFile = env.PROFILING_LOG ?? '';
    const code = env.PROFILING_EXIT ?? '';
    process.stdout.write(
      reply({
        summary: summaryFile !== null && existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : null,
        exitCode: /^\d+$/.test(code) ? Number(code) : null,
        log: logFile !== '' && existsSync(logFile) ? readFileSync(logFile, 'utf8') : '',
        sha: env.PROFILING_SHA ?? '',
        base: env.PROFILING_BASE ?? '',
        runUrl: env.PROFILING_RUN_URL ?? '',
        paths: {
          '<repo>': env.GITHUB_WORKSPACE,
          '<temp>': env.RUNNER_TEMP,
          '<data>': env.PROFILING_DATA_DIR,
          '<home>': env.HOME,
        },
      }),
    );
    return 0;
  }
  process.stderr.write('usage: node scripts/profiling/comment.ts args|reply\n');
  return 2;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
