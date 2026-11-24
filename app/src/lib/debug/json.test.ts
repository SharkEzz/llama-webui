import { ChatEvent, ConversationDetail, ConversationPatch, ConversationSummary } from '@llama-webui/shared';
import { SchemaAST } from 'effect';
import { expect, test } from 'vitest';
import { redact, TEXT_KEYS, toPlain } from './json';

test('a store state becomes plain JSON: maps, sets, no functions, no cycles', () => {
  const state: Record<string, unknown> = {
    byId: new Map([[1, { name: 'a' }]]),
    seen: new Set(['x']),
    refresh: () => {},
    missing: undefined,
    list: [1, undefined, () => {}],
    bytes: new Uint8Array(3),
  };
  state.self = state;
  expect(toPlain(state)).toEqual({
    byId: { '1': { name: 'a' } },
    seen: ['x'],
    list: [1, null, null],
    bytes: '<3 bytes>',
    self: '<cycle>',
  });
});

test('a value seen twice, not in a cycle, is kept both times', () => {
  const shared = { n: 1 };
  expect(toPlain({ a: shared, b: shared })).toEqual({ a: { n: 1 }, b: { n: 1 } });
});

test('the redacted export hides the home folder, environment values, secret options and conversation text', () => {
  const value = {
    settings: { modelsDir: '/home/alice/Models', env: { HF_TOKEN: 'hf_secret', CUDA_VISIBLE_DEVICES: '0' } },
    profile: { args: ['-m', '/Users/bob/m.gguf', '--api-key', 'k123', '--hf-token=hf_x'], env: { A: 'b' } },
    command: 'llama-server -m /root/m.gguf --api-key k123 --port 8080',
    message: { role: 'user', content: 'Hello there', reasoning: '', title: 'My chat' },
    count: 3,
    log: 'loaded /home/alice/Models/m.gguf: ok',
  };
  expect(redact(value)).toEqual({
    settings: { modelsDir: '<home>/Models', env: { HF_TOKEN: '<hidden>', CUDA_VISIBLE_DEVICES: '<hidden>' } },
    profile: { args: ['-m', '<home>/m.gguf', '--api-key', '<hidden>', '--hf-token=<hidden>'], env: { A: '<hidden>' } },
    command: 'llama-server -m <home>/m.gguf --api-key <hidden> --port 8080',
    message: { role: 'user', content: '<11 chars>', reasoning: '<0 chars>', title: '<7 chars>' },
    count: 3,
    log: 'loaded <home>/Models/m.gguf: ok',
  });
});

/** String fields of the chat's schemas that hold no text a person wrote or a model replied. */
const NOT_TEXT = new Set([
  // A model's file path: the home folder in it is redacted as a path.
  'model',
  'modelPath',
  // An error message of the server or of llama-server, not a message of the conversation.
  'error',
]);

/** The names of the string fields of a schema, at any depth. */
function stringFields(ast: SchemaAST.AST, seen = new Set<SchemaAST.AST>()): Set<string> {
  const names = new Set<string>();
  const walk = (node: SchemaAST.AST, name: string | undefined): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (SchemaAST.isString(node) && name !== undefined) names.add(name);
    else if (SchemaAST.isObjects(node)) for (const p of node.propertySignatures) walk(p.type, String(p.name));
    else if (SchemaAST.isUnion(node)) for (const t of node.types) walk(t, name);
    else if (SchemaAST.isArrays(node)) for (const t of [...node.elements, ...node.rest]) walk(t, name);
    else if (SchemaAST.isSuspend(node)) walk(node.thunk(), name);
    seen.delete(node);
  };
  walk(ast, undefined);
  return names;
}

test('every text field of the chat is redacted: a new one fails here until TEXT_KEYS has it', () => {
  const fields = new Set<string>();
  for (const schema of [ChatEvent, ConversationDetail, ConversationSummary, ConversationPatch])
    for (const name of stringFields(schema.ast)) fields.add(name);
  expect(fields.size).toBeGreaterThan(0);
  const unhandled = [...fields].filter((name) => !TEXT_KEYS.has(name) && !NOT_TEXT.has(name));
  expect(unhandled).toEqual([]);
  // And the list knows no field that is not text.
  expect([...NOT_TEXT].filter((name) => TEXT_KEYS.has(name))).toEqual([]);
});
