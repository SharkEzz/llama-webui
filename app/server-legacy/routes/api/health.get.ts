import { defineHandler } from 'nitro';
import { reply } from '../../lib/http.ts';
import { APP_VERSION } from '../../lib/version.ts';

const startedAt = Date.now();

export default defineHandler(() => reply({ ok: true, version: APP_VERSION, uptimeMs: Date.now() - startedAt }));
