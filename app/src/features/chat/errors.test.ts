import { ConversationNotFound, RequestInvalid } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import { ApiUnreachable } from '@/lib/api';
import { fieldErrors } from './errors';

test('fieldErrors puts each issue on the field it names, the first one winning', () => {
  const error = RequestInvalid.make({
    message: 'Invalid data: Temperature: between 0 and 5 (sampling.temperature)',
    issues: [
      { path: ['sampling', 'temperature'], message: 'Temperature: between 0 and 5' },
      { path: ['sampling', 'temperature'], message: 'later' },
      { path: ['sampling', 'top_k'], message: 'Expected an integer' },
      { path: ['systemPrompt'], message: 'System prompt too long' },
    ],
  });
  expect(fieldErrors(error, 'top_p')).toEqual({
    temperature: 'Temperature: between 0 and 5',
    top_k: 'Expected an integer',
    systemPrompt: 'System prompt too long',
  });
});

test('an issue that names no field goes to the field being saved', () => {
  const error = RequestInvalid.make({
    message: 'Invalid data: unknown key (sampling.mirostat)',
    issues: [{ path: ['sampling', 'mirostat'], message: 'unknown key' }],
  });
  expect(fieldErrors(error, 'seed')).toEqual({ seed: 'unknown key (sampling.mirostat)' });
  expect(fieldErrors(RequestInvalid.make({ message: 'Invalid data', issues: [] }), 'seed')).toEqual({
    seed: 'Invalid data',
  });
});

test('any other error is an error of the field being saved', () => {
  expect(fieldErrors(ConversationNotFound.make({ message: 'Conversation not found' }), 'systemPrompt')).toEqual({
    systemPrompt: 'Conversation not found',
  });
  expect(fieldErrors(new ApiUnreachable(), 'min_p')).toEqual({ min_p: 'llama-webui server unreachable' });
  expect(fieldErrors('boom', 'min_p')).toEqual({ min_p: 'boom' });
});
