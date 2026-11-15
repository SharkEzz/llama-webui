import { Option, type PlatformError, Predicate, Result } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';

/** How a process ended: its code, or the signal that ended it. */
export interface Ending {
  readonly code: number | null;
  readonly signal: string | null;
}

const SIGNAL = /signal: '([A-Z0-9]+)'/;

/** The message of a platform error's cause (Node's own: `spawn setpriv ENOENT`), else its own. */
export const causeMessage = (error: { readonly message: string; readonly cause?: unknown }): string =>
  Predicate.isError(error.cause) ? error.cause.message : error.message;

/**
 * The code a process exited with, or the signal that ended it: `exitCode` fails when a signal did, with the signal's
 * name in its cause's message.
 */
export const endingOf = (ended: Result.Result<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>): Ending =>
  Result.match(ended, {
    onSuccess: (code): Ending => ({ code, signal: null }),
    onFailure: (error): Ending => ({
      code: null,
      signal: Option.fromNullishOr(SIGNAL.exec(causeMessage(error))?.[1]).pipe(Option.getOrNull),
    }),
  });
