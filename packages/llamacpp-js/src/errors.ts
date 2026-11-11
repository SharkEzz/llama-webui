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

/** The `error` of an HTTP error body, if the body is llama-server JSON. */
export function parseLlamaError(body: string): LlamaError | null {
  try {
    const e = (JSON.parse(body) as { error?: unknown } | null)?.error;
    return typeof e === 'object' && e !== null ? (e as LlamaError) : null;
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
