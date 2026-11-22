// `pnpm profiling <scenario…>` measures the app and writes a report; `pnpm profiling:report <run>` rewrites one.
import { listScenarios, parseOptions, UsageError, USAGE } from './options.ts';

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
  process.stderr.write('profiling: not implemented yet\n');
  return 1;
}

process.exitCode = main();
