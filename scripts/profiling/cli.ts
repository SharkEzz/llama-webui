// `pnpm profiling <scenario…>` measures the app and writes a report; `pnpm profiling:report <run>` rewrites one.
import { writeFileSync } from 'node:fs';
import { compare, VersionMismatch } from './compare.ts';
import { listScenarios, type Options, parseOptions, UsageError, USAGE } from './options.ts';
import { renderReport } from './report/render.ts';
import { runDir } from './run-dir.ts';

/** Rewrites a run's report from its results.json, against a reference run when asked. */
function report(options: Options): number {
  const dir = runDir(options.name);
  if (!dir.exists()) {
    process.stderr.write(`profiling: no run ${options.name}: ${dir.file('results.json')} does not exist\n`);
    return 1;
  }
  const results = dir.readResults();
  let comparison = null;
  if (options.compare !== null) {
    const ref = runDir(options.compare);
    if (!ref.exists()) {
      process.stderr.write(
        `profiling: no reference run ${options.compare}: ${ref.file('results.json')} does not exist\n`,
      );
      return 1;
    }
    try {
      comparison = compare(results, ref.readResults());
    } catch (error) {
      if (error instanceof VersionMismatch) {
        process.stderr.write(`profiling: ${error.message}\n`);
        return 1;
      }
      throw error;
    }
  }
  const out = dir.file('report.html');
  writeFileSync(out, renderReport(results, comparison));
  process.stdout.write(`${out}\n`);
  return 0;
}

function main(): number {
  let options;
  try {
    options = parseOptions(process.argv.slice(2), new Date());
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`profiling: ${error.message}\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
  if (options.command === 'list') {
    process.stdout.write(`${listScenarios()}\n`);
    return 0;
  }
  if (options.command === 'report') return report(options);
  process.stderr.write('profiling: not implemented yet\n');
  return 1;
}

process.exitCode = main();
