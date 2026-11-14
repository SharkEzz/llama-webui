import { Option, Schema } from 'effect';
import { expect, test } from 'vitest';
import { WsMessage } from './ws.ts';

test('a message of an unknown type does not decode', () => {
  expect(Option.isNone(Schema.decodeUnknownOption(WsMessage)({ type: 'snapshot' }))).toBe(true);
  expect(Option.isSome(Schema.decodeOption(WsMessage)({ type: 'ping' }))).toBe(true);
});
