import { NodeSocketServer } from '@effect/platform-node';
import { assert, it } from '@effect/vitest';
import { Effect } from 'effect';
import { AppConfig } from '../config/AppConfig.ts';
import { AddressInUse, assertFree } from './Address.ts';

const config = (port: number) => AppConfig.of({ host: '127.0.0.1', port, dataDir: '/nonexistent', dev: false });

it.effect('a taken port fails with a message that names the address', () =>
  Effect.gen(function* () {
    const taken = yield* NodeSocketServer.make({ host: '127.0.0.1', port: 0 });
    const port = taken.address._tag === 'InetAddressV4' ? taken.address.port : 0;
    const error = yield* assertFree.pipe(Effect.provideService(AppConfig, config(port)), Effect.flip);
    assert.instanceOf(error, AddressInUse);
    assert.strictEqual(error.message, `cannot listen on 127.0.0.1:${port}: the port is already in use`);
  }).pipe(Effect.scoped),
);

it.effect('a free port passes and is left free', () =>
  Effect.gen(function* () {
    const probe = yield* NodeSocketServer.make({ host: '127.0.0.1', port: 0 }).pipe(Effect.scoped);
    const port = probe.address._tag === 'InetAddressV4' ? probe.address.port : 0;
    yield* assertFree.pipe(Effect.provideService(AppConfig, config(port)));
    // Nothing kept it: it can be taken again.
    yield* assertFree.pipe(Effect.provideService(AppConfig, config(port)));
  }),
);
