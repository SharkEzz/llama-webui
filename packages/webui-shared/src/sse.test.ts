import { expect, test } from 'bun:test';
import { SseParser } from 'llamacpp-js/sse';
import { formatSse } from './sse';

test('formatSse writes one event the parser reads back', () => {
  expect(new SseParser().push(formatSse('delta', { content: 'x\ny' }))).toEqual([
    { event: 'delta', data: '{"content":"x\\ny"}' },
  ]);
});
