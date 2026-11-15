import { ProfileNameTaken, RequestInvalid } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import { ApiUnreachable } from '@/lib/api';
import { fieldErrors } from './errors';

test('fieldErrors puts each issue on its field, the first one winning', () => {
  const error = RequestInvalid.make({
    message: 'Invalid data: cannot be empty (name)',
    issues: [
      { path: ['name'], message: 'cannot be empty' },
      { path: ['args', '2'], message: '--port is managed by llama-webui (use the profile fields)' },
      { path: ['args', '4'], message: 'later' },
      { path: ['id'], message: 'unknown key' },
    ],
  });
  expect(fieldErrors(error)).toEqual({
    name: 'cannot be empty',
    args: '--port is managed by llama-webui (use the profile fields)',
    form: 'unknown key (id)',
  });
});

test('a taken name is an error of the name field', () => {
  const error = ProfileNameTaken.make({ message: 'A profile named “A” already exists' });
  expect(fieldErrors(error)).toEqual({ name: 'A profile named “A” already exists' });
});

test('anything else is an error of the form', () => {
  expect(fieldErrors(new ApiUnreachable())).toEqual({ form: 'llama-webui server unreachable' });
  expect(fieldErrors('boom')).toEqual({ form: 'boom' });
});
