/**
 * The script's own arguments. pnpm passes a `--` through (`pnpm screenshots -- --live` gives `-- --live`): without
 * this, `parseArgs` would read every flag after it as a positional.
 */
export function cliArgs(argv = process.argv.slice(2)): string[] {
  return argv[0] === '--' ? argv.slice(1) : argv;
}
