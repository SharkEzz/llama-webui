import { expect, test } from 'vitest';
import { errorResponse, HttpError } from './http';

test('an HttpError from an older module (bun --hot) keeps its status and code (#34)', async () => {
  // What the bench gate throws after a reload: same name and fields, another class.
  class StaleHttpError extends Error {
    override name = 'HttpError';
    constructor(
      readonly status: number,
      message: string,
      readonly code?: string,
    ) {
      super(message);
    }
  }
  const r = errorResponse(new StaleHttpError(409, 'A server is running', 'server-running'));
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: 'A server is running', code: 'server-running' });
  expect(errorResponse(new HttpError(404, 'Profile not found')).status).toBe(404);
  expect(errorResponse(new Error('boom')).status).toBe(500);
});
