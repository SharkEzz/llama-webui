import { expect, test } from 'bun:test';
import { SseParser } from './sse.ts';

test('an event split across chunks comes out once complete', () => {
  const p = new SseParser();
  expect(p.push('data: {"a"')).toEqual([]);
  expect(p.push(':1}\n')).toEqual([]);
  expect(p.push('\n')).toEqual([{ event: 'message', data: '{"a":1}' }]);
});

test('CRLF, multi-line data, comments and named events', () => {
  const p = new SseParser();
  expect(p.push(': ping\r\n\r\nevent: done\r\ndata: a\r\ndata: b\r\n\r\ndata: [DONE]\n\n')).toEqual([
    { event: 'done', data: 'a\nb' },
    { event: 'message', data: '[DONE]' },
  ]);
});
