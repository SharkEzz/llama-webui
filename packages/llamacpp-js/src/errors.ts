/** The `error` object llama-server sends, in an HTTP error body (`{ "error": … }`) or in a stream event. */
export interface LlamaError {
  code?: number;
  message?: string;
  type?: string;
  n_prompt_tokens?: number;
  n_ctx?: number;
}

/**
 * The prompt and context sizes of an `exceed_context_size_error`, from its fields or, for builds that only put them
 * in the message, from its text; null for another error. A size that cannot be read is null.
 */
export function contextOverflow(e: LlamaError): { promptTokens: number | null; contextTokens: number | null } | null {
  if (e.type !== 'exceed_context_size_error') return null;
  const m = /\((\d+) tokens\).*\((\d+)\s*tokens\)/.exec(e.message ?? '');
  return {
    promptTokens: e.n_prompt_tokens ?? (m ? Number(m[1]) : null),
    contextTokens: e.n_ctx ?? (m ? Number(m[2]) : null),
  };
}

/** `v` is llama-server's JSON error: an object whose fields, when present, have their type. */
export function isLlamaError(v: unknown): v is LlamaError {
  if (typeof v !== 'object' || v === null) return false;
  const is = (key: keyof LlamaError, type: 'number' | 'string') => {
    const field: unknown = Reflect.get(v, key);
    return field === undefined || typeof field === type;
  };
  return (
    is('code', 'number') &&
    is('message', 'string') &&
    is('type', 'string') &&
    is('n_prompt_tokens', 'number') &&
    is('n_ctx', 'number')
  );
}

/** The `error` of an HTTP error body, if the body is llama-server JSON. */
export function parseLlamaError(body: string): LlamaError | null {
  try {
    const json: unknown = JSON.parse(body);
    const e = typeof json === 'object' && json !== null && 'error' in json ? json.error : undefined;
    return isLlamaError(e) ? e : null;
  } catch {
    return null;
  }
}

/** llama-server answered with an HTTP error. `error` is its JSON error, when the body has one. */
export class LlamaHttpError extends Error {
  override readonly name = 'LlamaHttpError';
  readonly status: number;
  readonly body: string;
  readonly error: LlamaError | null;

  constructor(status: number, body: string) {
    const error = parseLlamaError(body);
    super(error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.error = error;
  }
}

/** llama-server answered 2xx with a body that is not what the endpoint returns (not JSON, no stream). */
export class LlamaReplyError extends Error {
  override readonly name = 'LlamaReplyError';
}

/** A streamed completion sent an `error` event. */
export class LlamaStreamError extends Error {
  override readonly name = 'LlamaStreamError';
  readonly error: LlamaError;

  constructor(error: LlamaError) {
    super(error.message ?? 'error');
    this.error = error;
  }
}

/** A streamed completion ended (or the connection broke) before its `[DONE]`. */
export class LlamaStreamCutError extends Error {
  override readonly name = 'LlamaStreamCutError';
}
