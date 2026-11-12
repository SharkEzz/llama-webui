import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SseParser } from '../src/sse.ts';

test('an event split across chunks comes out once complete', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: {"a"'), []);
  assert.deepEqual(p.push(':1}\n'), []);
  assert.deepEqual(p.push('\n'), [{ event: 'message', data: '{"a":1}' }]);
});

test('CRLF, multi-line data, comments and named events', () => {
  const p = new SseParser();
  assert.deepEqual(p.push(': ping\r\n\r\nevent: done\r\ndata: a\r\ndata: b\r\n\r\ndata: [DONE]\n\n'), [
    { event: 'done', data: 'a\nb' },
    { event: 'message', data: '[DONE]' },
  ]);
});
