import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from 'effect/http-api';
import { LogLine } from '../logs.ts';
import { SeqParam } from './params.ts';

/** llama-server's log: the lines still held from `since` (0 when absent), the number of the next one, the boot id. */
export class LogsApi extends HttpApiGroup.make('logs')
  .add(
    HttpApiEndpoint.get('list', '/api/logs', {
      query: { since: Schema.optionalKey(SeqParam) },
      success: Schema.Struct({ lines: Schema.Array(LogLine), seq: Schema.Int, bootId: Schema.String }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Read buffered llama-server logs',
        description:
          'Returns lines from the 10,000-line in-memory ring buffer starting at sequence number `since` (default `0`), together with the next expected `seq` and the current `bootId`.',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Logs',
      description: 'In-memory log replay for the supervised `llama-server` process (live batches stream over `/ws`).',
    }),
  ) {}
