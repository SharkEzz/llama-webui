import { stateHost } from '@llama-webui/shared';
import { fetchProps, probeUrl } from 'llamacpp-js/client';
import { LlamaHttpError, LlamaReplyError } from 'llamacpp-js/errors';
import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { HttpError } from '../../../lib/http.ts';

/** llama-server's own JSON, passed through untyped (`src/lib/props.ts` narrows it). */
export default defineHandler(async (): Promise<Response> => {
  const s = deps().runtime.supervisor.state;
  if (s.kind !== 'ready' && s.kind !== 'external') throw new HttpError(409, 'Server not ready');
  let props: unknown;
  try {
    props = await fetchProps(probeUrl(stateHost(s), s.port));
  } catch (e) {
    if (e instanceof LlamaHttpError) throw new HttpError(502, `llama-server /props: HTTP ${e.status}`);
    // Its reply, not the client's request: a body that is not JSON is a 502, not a 400 "Invalid JSON".
    if (e instanceof LlamaReplyError) throw new HttpError(502, 'llama-server /props: the reply is not JSON');
    throw new HttpError(502, 'llama-server is not responding on /props');
  }
  return Response.json(props);
});
