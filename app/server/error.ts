import { defineErrorHandler } from 'nitro';
import { appError } from './lib/http.ts';

/** Every thrown error answers with the API's JSON error body (`appError()`). */
export default defineErrorHandler((error) => appError(error));
