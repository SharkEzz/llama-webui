import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from 'effect/http-api';
import { DownloadItem, DownloadList, DownloadRequest } from '../hf.ts';
import { HfInvalidPath, HubErrors } from './HfApi.ts';
import { IdParam } from './params.ts';

/** A request that names one variant twice: `<name> is listed twice`. */
export class ListedTwice extends Schema.TaggedError<ListedTwice, { readonly ListedTwice: unique symbol }>()(
  'ListedTwice',
  { message: Schema.String },
  { httpApiStatus: 400, description: 'ListedTwice: The same variant key was listed more than once in `keys`.' },
) {}

/** A variant already queued or downloading: `<name> is already in the download queue`. */
export class AlreadyQueued extends Schema.TaggedError<AlreadyQueued, { readonly AlreadyQueued: unique symbol }>()(
  'AlreadyQueued',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'AlreadyQueued: One of the requested variants is already queued or downloading.' },
) {}

/** Not enough room: `Not enough disk space: <need> to download (plus 1.0 GiB margin), <free> free`. */
export class DiskFull extends Schema.TaggedError<DiskFull, { readonly DiskFull: unique symbol }>()(
  'DiskFull',
  { message: Schema.String },
  {
    httpApiStatus: 507,
    description: 'DiskFull: Free disk space is below the remaining download size plus 1.0 GiB margin.',
  },
) {}

/** No download has this id: `Download not found`. */
export class DownloadNotFound extends Schema.TaggedError<
  DownloadNotFound,
  { readonly DownloadNotFound: unique symbol }
>()(
  'DownloadNotFound',
  { message: Schema.String },
  { httpApiStatus: 404, description: 'DownloadNotFound: No download queue item exists with the given id.' },
) {}

/** A retry of a download that is queued, running or done: `Only a failed or canceled download can be retried`. */
export class NotFinished extends Schema.TaggedError<NotFinished, { readonly NotFinished: unique symbol }>()(
  'NotFinished',
  { message: Schema.String },
  { httpApiStatus: 409, description: 'NotFinished: Only downloads with status `error` or `canceled` can be retried.' },
) {}

const params = { id: IdParam };

/** The download queue: its items and live progress, a request, the clearing of finished items, a cancel, a retry. */
export class DownloadsApi extends HttpApiGroup.make('downloads')
  .add(
    HttpApiEndpoint.get('list', '/api/downloads', { success: DownloadList }).annotateMerge(
      OpenApi.annotations({
        summary: 'List download queue',
        description: 'Returns all queued, active and finished download items together with live transfer metrics.',
      }),
    ),
    HttpApiEndpoint.post('create', '/api/downloads', {
      payload: DownloadRequest,
      success: Schema.Struct({ items: Schema.Array(DownloadItem) }).pipe(HttpApiSchema.status(202)),
      error: [...HubErrors, HfInvalidPath, ListedTwice, AlreadyQueued, DiskFull],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Queue Hugging Face downloads',
        description:
          'Resolves 1–16 variants at the pinned commit `revision`, checks disk space (+1 GiB margin), enqueues them (`202 Accepted`), and downloads files sequentially into `<modelsDir>/<org>/<name>/` with `.part` resume and SHA-256 verification.',
      }),
    ),
    // The finished items (done, error, canceled) leave the list, their files stay; the ids removed are counted.
    HttpApiEndpoint.post('clear', '/api/downloads/clear', {
      success: Schema.Struct({ deleted: Schema.Int }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Clear finished downloads',
        description: 'Removes all `done`, `error` and `canceled` rows from the queue without touching files on disk.',
      }),
    ),
    // Cancels a queued or running download (its partial and finished files deleted), removes a finished one from the list.
    HttpApiEndpoint.delete('remove', '/api/downloads/:id', { params, error: DownloadNotFound }).annotateMerge(
      OpenApi.annotations({
        summary: 'Cancel or remove a download',
        description:
          'Cancels a queued or active download (deleting its `.part` and partial files) or removes a finished item from the queue (`204 No Content`).',
      }),
    ),
    HttpApiEndpoint.post('retry', '/api/downloads/:id/retry', {
      params,
      success: DownloadItem.pipe(HttpApiSchema.status(202)),
      error: [DownloadNotFound, NotFinished, AlreadyQueued, DiskFull],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Retry a failed or canceled download',
        description:
          'Re-queues a `failed` or `canceled` item (`202 Accepted`), resuming from any surviving `.part` file.',
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: 'Downloads',
      description:
        'Resumable sequential download queue from Hugging Face into `modelsDir`. Progress and state changes broadcast over `/ws` (`download`, `download-progress`, `download-deleted`).',
    }),
  ) {}
