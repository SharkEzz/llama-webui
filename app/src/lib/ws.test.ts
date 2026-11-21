import { Option } from 'effect';
import { afterEach, expect, test, vi } from 'vitest';
import { decodeFrame } from './ws';

afterEach(() => {
  vi.restoreAllMocks();
});

test('a frame that is a message of the push channel is decoded, nothing logged', () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(decodeFrame('{"type":"ping"}')).toEqual(Option.some({ type: 'ping' }));
  expect(decodeFrame('{"type":"download-deleted","payload":{"ids":[7]}}')).toEqual(
    Option.some({ type: 'download-deleted', payload: { ids: [7] } }),
  );
  expect(logged).not.toHaveBeenCalled();
});

test('a frame that does not decode is none, and logged with why', () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Not JSON, a type this page does not know, a field of the wrong type.
  const frames = ['not json', '{"type":"from-a-newer-server"}', '{"type":"download-deleted","payload":{"ids":["7"]}}'];
  for (const frame of frames) expect(decodeFrame(frame), frame).toEqual(Option.none());
  expect(logged).toHaveBeenCalledTimes(frames.length);
  for (const [message, error] of logged.mock.calls) {
    expect(message).toBe('llama-webui: a message of the server does not decode');
    expect(error).toHaveProperty('_tag', 'SchemaError');
  }
});
