import { expect, test } from 'bun:test';
import { isIdleNoise } from './lines';

test('the idle loop line of -lv 4 is noise, the request lines are not (#16)', () => {
  expect(isIdleNoise('0.10.001.136 I srv  update_slots: all slots are idle')).toBe(true);
  expect(isIdleNoise('srv  update_slots: all slots are idle')).toBe(true);
  expect(isIdleNoise('0.09.989.944 I slot      release: id  0 | task 0 | stop processing: n_tokens = 364')).toBe(false);
  expect(isIdleNoise('0.00.718.579 I load_tensors:       Meta() model buffer size =  5931.79 MiB')).toBe(false);
});
