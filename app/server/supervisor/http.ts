import { Api, NoProfileToRestart, ServerNotReady, stateHost } from '@llama-webui/shared';
import { Effect, type Path } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { probeUrl } from 'llamacpp-js/client';
import { AppInfo } from '../config/AppInfo.ts';
import type { LlamaHttp } from '../llama/LlamaHttp.ts';
import { props } from '../llama/probes.ts';
import { LogRing } from '../logs/LogRing.ts';
import { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { type BuiltCommand, buildCommand } from './command.ts';
import { Supervisor } from './Supervisor.ts';

/** The endpoints of `/api/server` and the snapshot of `/api/state`, on the supervisor. */
export const ServerHandlers = HttpApiBuilder.group(
  Api,
  'server',
  Effect.fn(function* (handlers) {
    const supervisor = yield* Supervisor;
    const profiles = yield* ProfilesRepo;
    const settings = yield* SettingsRepo;
    const ring = yield* LogRing;
    const { bootId } = yield* AppInfo;
    // Taken when the routes are built: a handler then needs nothing from the request.
    const services = yield* Effect.context<Path.Path | LlamaHttp>();

    /** The command of the profile `id` as it is stored now, on the settings as they are now. */
    const commandFor = Effect.fn('ServerHandlers.commandFor')(function* (id: number) {
      const profile = yield* profiles.get(id);
      const current = yield* settings.get;
      return yield* buildCommand({ profile, settings: current }).pipe(Effect.provideContext(services));
    });

    /** The profile just launched becomes the default one (after a launch that ended `crashed` too). */
    const remember = Effect.fn('ServerHandlers.remember')(function* (cmd: BuiltCommand) {
      const current = yield* settings.get;
      if (current.defaultProfileId !== cmd.profileId) {
        yield* settings.patch({ defaultProfileId: cmd.profileId }).pipe(Effect.orDie);
      }
    });

    const start = Effect.fn('ServerHandlers.start')(function* (id: number) {
      const cmd = yield* commandFor(id);
      yield* supervisor.start(cmd);
      yield* remember(cmd);
      return yield* supervisor.view;
    });

    const switchTo = Effect.fn('ServerHandlers.switch')(function* (id: number) {
      const cmd = yield* commandFor(id);
      yield* supervisor.switchTo(cmd);
      yield* remember(cmd);
      return yield* supervisor.view;
    });

    /** The profile of the view relaunched, its command read again (its edits taken); the default profile kept. */
    const restart = Effect.gen(function* () {
      const { profileId } = yield* supervisor.view;
      if (profileId === null) return yield* NoProfileToRestart.make({ message: 'No profile to restart' });
      const cmd = yield* commandFor(profileId);
      yield* supervisor.switchTo(cmd);
      return yield* supervisor.view;
    }).pipe(Effect.withSpan('ServerHandlers.restart'));

    /** llama-server's own `/props`, from the server that answers (ours once ready, or one started by hand). */
    const serverProps = Effect.gen(function* () {
      const state = yield* supervisor.state;
      if (state.kind !== 'ready' && state.kind !== 'external') {
        return yield* ServerNotReady.make({ message: 'Server not ready' });
      }
      return yield* props(probeUrl(stateHost(state), state.port)).pipe(Effect.provideContext(services));
    }).pipe(Effect.withSpan('ServerHandlers.props'));

    return handlers
      .handle('state', () => supervisor.view)
      .handle('start', ({ payload }) => start(payload.profileId))
      .handle('switch', ({ payload }) => switchTo(payload.profileId))
      .handle('restart', () => restart)
      .handle('stop', () => Effect.andThen(supervisor.stop, supervisor.view))
      .handle('props', () => serverProps)
      .handle('snapshot', () =>
        Effect.all({ server: supervisor.view, logSeq: ring.seq, bootId: Effect.succeed(bootId) }),
      );
  }),
);
