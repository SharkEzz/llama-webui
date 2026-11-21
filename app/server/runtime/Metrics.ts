import { Metric } from 'effect';

/**
 * The metrics of the server, read by the Effect DevTools in dev (their client sends a snapshot of the registry at each
 * request of the DevTools, and a last one when the app stops). Every update is a write to an in-memory map, so they are
 * recorded in production too, where nothing reads them.
 *
 * Each metric is declared here, named `llama_webui_<domain>_<what>`, with its description. Its attributes are closed
 * sets (a status, a kind, a tag, a class of HTTP status): never an id, a path or a model, which would make one series
 * per value.
 */

const counter = (name: string, description: string) =>
  Metric.counter(`llama_webui_${name}`, { description, incremental: true });

const gauge = (name: string, description: string) => Metric.gauge(`llama_webui_${name}`, { description });

const frequency = (name: string, description: string) => Metric.frequency(`llama_webui_${name}`, { description });

const timer = (name: string, description: string) => Metric.timer(`llama_webui_${name}`, { description });

/** The class of an HTTP status: `2xx`, `3xx`, `4xx`, `5xx` (`1xx` for a switch of protocols). */
export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

/** Every response of the HTTP server: the API, `/ws` and the UI. */
export const HttpMetrics = {
  /** Attributes `method` and `class`. */
  requests: counter('http_requests', 'Responses sent by the HTTP server, by method and class of status'),
  /** Attribute `class`. */
  duration: timer(
    'http_request_duration',
    'Time from the request to its response (an upgrade: the life of the socket)',
  ),
  defects: counter('http_defects', 'Requests whose handler died: answered 500 and logged'),
  /** Attributes `status` and `upgrade` (`true` for a WebSocket). */
  refused: counter('http_refused', 'Requests the guard refused (Host, Origin, content type)'),
  invalid: frequency('http_invalid', 'Requests that did not decode, by part: Params, Payload, Query, Headers'),
};

/** The clients of `/ws` and the messages they are sent. */
export const WsMetrics = {
  clients: gauge('ws_clients', 'WebSocket clients connected to /ws'),
  published: frequency('ws_published', 'Messages published to the /ws clients, by type'),
  sent: counter('ws_sent', 'Messages written to a /ws client (one per client per message)'),
  sentBytes: counter('ws_sent_bytes', 'Bytes of text written to the /ws clients'),
  heartbeatClosed: counter('ws_heartbeat_closed', 'Clients closed with 4000 after unanswered pings'),
};

/** The replies of the chat. */
export const ChatMetrics = {
  active: gauge('chat_active', 'Replies being written'),
  /** Attribute `status`: `done`, `error`, `stopped`. */
  replies: counter('chat_replies', 'Replies saved, by status'),
  failures: frequency('chat_failures', 'Replies that failed, by cause: the tag of the stream error, or Defect'),
  refused: frequency('chat_refused', 'Sends and regenerations refused, by error tag'),
  ttft: timer('chat_ttft', 'Time from the start of a reply to its first token (reasoning included)'),
  duration: timer('chat_reply_duration', 'Time from the start of a reply to its end, for the replies with timings'),
  tgTps: Metric.histogram('llama_webui_chat_tg_tps', {
    description: 'Generation speed of a reply, in tokens per second (llama-server timings)',
    boundaries: Metric.linearBoundaries({ start: 0, width: 10, count: 26 }),
  }),
  ppTps: Metric.histogram('llama_webui_chat_pp_tps', {
    description: 'Prompt processing speed of a reply, in tokens per second (llama-server timings)',
    boundaries: Metric.exponentialBoundaries({ start: 10, factor: 2, count: 14 }),
  }),
  promptTokens: counter('chat_prompt_tokens', 'Prompt tokens evaluated by llama-server for the replies'),
  cachedTokens: counter('chat_cached_tokens', 'Prompt tokens taken from the cache of llama-server for the replies'),
  genTokens: counter('chat_gen_tokens', 'Tokens generated for the replies'),
};

/** The llama-server the supervisor runs. */
export const LlamaMetrics = {
  transitions: frequency('llama_transitions', 'States entered by the supervised llama-server, by kind'),
  ready: gauge('llama_ready', '1 while the supervised llama-server is ready, else 0'),
  startup: timer('llama_startup_duration', 'Time from the spawn of llama-server to its first 200 on /health'),
  stop: timer('llama_stop_duration', 'Time a stop of llama-server took, from SIGTERM to its exit'),
  sigkill: counter('llama_sigkill', 'Stops of llama-server that needed SIGKILL'),
};

/** The download queue. */
export const DownloadMetrics = {
  bytes: counter('download_bytes', 'Bytes received from Hugging Face and written to the .part files'),
  bps: gauge('download_bps', 'Speed of the running download, smoothed, in bytes per second (0 when none runs)'),
  resumed: counter('download_resumed', 'Files resumed from their .part (a 206 answer to a Range request)'),
  retries: counter('download_retries', 'Attempts at a file retried after a transient failure'),
  /** Attribute `status`: `done`, `canceled`, `error`. */
  items: counter('download_items', 'Items that ended, by status'),
  errors: frequency('download_errors', 'Items that failed, by code'),
  duration: timer('download_item_duration', 'Time an item ran, from its pick to its end'),
};

/** The monitoring loop and its collectors. */
export const MonitorMetrics = {
  tick: timer('monitor_tick_duration', 'Time a monitoring tick took'),
  overrun: counter('monitor_tick_overrun', 'Ticks that took longer than the poll interval'),
  tickFailed: counter('monitor_tick_failed', 'Ticks that failed (logged): their snapshot is not published'),
  readerDefects: frequency('monitor_reader_defects', 'Reads of a tick that died and gave their fallback, by reader'),
  gpuSource: frequency('monitor_gpu_source', 'Sources the NVIDIA cards are read from, each time one is taken'),
  nvmlDeaths: counter('monitor_nvml_deaths', 'NVML samplers that stopped'),
  nvmlRestarts: counter('monitor_nvml_restarts', 'NVML samplers started again after one stopped'),
};
