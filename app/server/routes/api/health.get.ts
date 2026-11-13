import { defineHandler } from 'nitro';
import { APP_VERSION } from '../../lib/version.ts';

const startedAt = Date.now();

export default defineHandler(() => Response.json({ ok: true, version: APP_VERSION, uptimeMs: Date.now() - startedAt }));
