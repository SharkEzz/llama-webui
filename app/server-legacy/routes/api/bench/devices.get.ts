import { benchBinary } from 'llamacpp-js/node';
import { defineHandler } from 'nitro';
import { listDevices } from '../../../lib/bench/hardware.ts';
import { deps } from '../../../lib/context.ts';
import { reply } from '../../../lib/http.ts';
import { binaryPath } from '../../../lib/supervisor/args.ts';

export default defineHandler(async () => reply(await listDevices(benchBinary(binaryPath(deps().settings.get())))));
