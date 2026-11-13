import { defineErrorHandler } from 'nitro';
import { errorResponse } from './lib/http.ts';

/** Every thrown error answers like today's API: h3 wraps the original error in `cause`. */
export default defineErrorHandler((error) => errorResponse(error.cause ?? error));
