// `node fails.ts`: an app that fails at once with a tagged error that has a message.
import { Effect, Schema } from 'effect';
import { runApp } from '../../runtime/runApp.ts';

class Broken extends Schema.TaggedError<Broken, { readonly Broken: unique symbol }>()('Broken', {
  message: Schema.String,
}) {}

runApp(Effect.fail(Broken.make({ message: 'the fixture is broken on purpose' })));
