import { defineHandler } from 'nitro';
import { HttpError } from '../../error.ts';

export default defineHandler(() => {
  throw new HttpError(409, 'Model in use', 'model-in-use');
});
