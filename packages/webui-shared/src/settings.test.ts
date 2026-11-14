import { Effect, Schema, SchemaIssue } from 'effect';
import { expect, test } from 'vitest';
import { DEFAULT_SETTINGS, Settings } from './settings.ts';

const format = SchemaIssue.makeFormatterStandardSchemaV1();

/** The message of each field `input` fails on, or `ok`. */
const messagesOf = (input: unknown) =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(Settings)(input, { errors: 'all' }).pipe(
      Effect.as<readonly { readonly path: readonly unknown[]; readonly message: string }[]>([]),
      Effect.catchTag('SchemaError', (e) =>
        Effect.succeed(format(e.issue).issues.map((i) => ({ path: (i.path ?? []).map(String), message: i.message }))),
      ),
    ),
  );

test('the defaults are those of the Nitro server', async () => {
  const defaults = {
    binary: 'llama-server',
    host: '127.0.0.1',
    port: 8080,
    modelsDir: '~/models',
    pollIntervalMs: 1000,
    historySeconds: 300,
    hiddenGpus: [],
    defaultProfileId: null,
    llamaTuiImportDismissed: false,
    onboardingDone: false,
    collectors: { nvml: true, system: true, disk: true },
    theme: 'system',
    env: {},
  };
  expect(DEFAULT_SETTINGS).toStrictEqual(defaults);
  // An empty object decodes to the same defaults: the literal and the schema cannot drift apart.
  expect(await Effect.runPromise(Schema.decodeEffect(Settings)({}))).toStrictEqual(defaults);
});

test('each bound keeps its message', async () => {
  const cases: [Record<string, unknown>, string, string][] = [
    [{ port: 0 }, 'port', 'Port between 1 and 65535'],
    [{ port: 1.5 }, 'port', 'Expected an integer'],
    [{ port: 'a' }, 'port', 'Expected a number'],
    [{ binary: '' }, 'binary', 'Required'],
    [{ pollIntervalMs: 10 }, 'pollIntervalMs', 'Between 250 and 60000 ms'],
    [{ historySeconds: 5 }, 'historySeconds', 'Between 30 and 1800 s'],
    [{ env: { '1A': 'x' } }, 'env', 'invalid variable name “1A”'],
  ];
  for (const [input, field, message] of cases) {
    const issues = await messagesOf(input);
    expect(issues.map((i) => [i.path[0], i.message])).toStrictEqual([[field, message]]);
  }
});

test('every other field refuses a value of the wrong kind', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ host: '' }, 'host'],
    [{ modelsDir: '' }, 'modelsDir'],
    [{ hiddenGpus: [1] }, 'hiddenGpus'],
    [{ defaultProfileId: 1.5 }, 'defaultProfileId'],
    [{ llamaTuiImportDismissed: 'yes' }, 'llamaTuiImportDismissed'],
    [{ onboardingDone: 1 }, 'onboardingDone'],
    [{ collectors: { nvml: 'on' } }, 'collectors'],
    [{ theme: 'blue' }, 'theme'],
  ];
  for (const [input, field] of cases) {
    const issues = await messagesOf(input);
    expect(issues.map((i) => i.path[0])).toStrictEqual([field]);
  }
  expect(await messagesOf({ defaultProfileId: 3, theme: 'dark', collectors: { disk: false } })).toStrictEqual([]);
});
