import type { ProfileInputSchema } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import type { z } from 'zod';
import { deps } from '../../../lib/context.ts';
import { reply } from '../../../lib/http.ts';

/** The repo validates (one parse of the schema, as for an import): the body is only declared here. */
export type Body = z.input<typeof ProfileInputSchema>;

export default defineHandler(async (event) => reply(deps().profiles.create(await event.req.json()), 201));
