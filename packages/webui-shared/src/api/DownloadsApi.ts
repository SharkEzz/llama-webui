import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api';
import { DownloadItem, DownloadList, DownloadRequest } from '../hf.ts';
import { HfInvalidPath, HubErrors } from './HfApi.ts';
import { IdParam } from './params.ts';

/** A request that names one variant twice: `<name> is listed twice`. */
export class ListedTwice extends Schema.TaggedError<ListedTwice, { readonly ListedTwice: unique symbol }>()(
  'ListedTwice',
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** A variant already queued or downloading: `<name> is already in the download queue`. */
export class AlreadyQueued extends Schema.TaggedError<AlreadyQueued, { readonly AlreadyQueued: unique symbol }>()(
  'AlreadyQueued',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Not enough room: `Not enough disk space: <need> to download (plus 1.0 GiB margin), <free> free`. */
export class DiskFull extends Schema.TaggedError<DiskFull, { readonly DiskFull: unique symbol }>()(
  'DiskFull',
  { message: Schema.String },
  { httpApiStatus: 507 },
) {}

/** No download has this id: `Download not found`. */
export class DownloadNotFound extends Schema.TaggedError<
  DownloadNotFound,
  { readonly DownloadNotFound: unique symbol }
>()('DownloadNotFound', { message: Schema.String }, { httpApiStatus: 404 }) {}

/** A retry of a download that is queued, running or done: `Only a failed or canceled download can be retried`. */
export class NotFinished extends Schema.TaggedError<NotFinished, { readonly NotFinished: unique symbol }>()(
  'NotFinished',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

const params = { id: IdParam };

/** The download queue: its items and live progress, a request, the clearing of finished items, a cancel, a retry. */
export class DownloadsApi extends HttpApiGroup.make('downloads').add(
  HttpApiEndpoint.get('list', '/api/downloads', { success: DownloadList }),
  HttpApiEndpoint.post('create', '/api/downloads', {
    payload: DownloadRequest,
    success: Schema.Struct({ items: Schema.Array(DownloadItem) }).pipe(HttpApiSchema.status(202)),
    error: [...HubErrors, HfInvalidPath, ListedTwice, AlreadyQueued, DiskFull],
  }),
  // The finished items (done, error, canceled) leave the list, their files stay; the ids removed are counted.
  HttpApiEndpoint.post('clear', '/api/downloads/clear', { success: Schema.Struct({ deleted: Schema.Int }) }),
  // Cancels a queued or running download (its partial and finished files deleted), removes a finished one from the list.
  HttpApiEndpoint.delete('remove', '/api/downloads/:id', { params, error: DownloadNotFound }),
  HttpApiEndpoint.post('retry', '/api/downloads/:id/retry', {
    params,
    success: DownloadItem.pipe(HttpApiSchema.status(202)),
    error: [DownloadNotFound, NotFinished, AlreadyQueued, DiskFull],
  }),
) {}
