import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { LogLine } from '../logs.ts';
import { SeqParam } from './params.ts';

/** llama-server's log: the lines still held from `since` (0 when absent), the number of the next one, the boot id. */
export class LogsApi extends HttpApiGroup.make('logs').add(
  HttpApiEndpoint.get('list', '/api/logs', {
    query: { since: Schema.optionalKey(SeqParam) },
    success: Schema.Struct({ lines: Schema.Array(LogLine), seq: Schema.Int, bootId: Schema.String }),
  }),
) {}
