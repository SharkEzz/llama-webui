import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { toInput } from '../../../lib/db/profiles.ts';
import { attachment } from '../../../lib/http.ts';

export default defineHandler(() =>
  attachment('llama-webui-profiles.json', { profiles: deps().profiles.list().map(toInput) }),
);
