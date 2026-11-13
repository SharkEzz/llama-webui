import type { ModelDetail } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { HttpError, notFound, type QueryOf, queryOf, reply } from '../../../lib/http.ts';
import { modelsDir } from '../../../lib/models/access.ts';
import { readModel } from '../../../lib/models/gguf.ts';
import { toSummary } from '../../../lib/models/scan.ts';
import { weightSizes } from '../../../lib/models/sizes.ts';
import { fileExists } from '../../../lib/proc.ts';

export type Query = QueryOf<'path'>;

export default defineHandler(async (event) => {
  const path = queryOf(event, 'path').path ?? '';
  if (!path.startsWith('/') || !path.endsWith('.gguf'))
    throw new HttpError(400, 'Absolute path to a .gguf file expected');
  if (!(await fileExists(path))) throw notFound('File');
  let info: Awaited<ReturnType<typeof readModel>>;
  try {
    info = await readModel(path);
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
  const { dir } = modelsDir(deps());
  const relPath = path.startsWith(`${dir.replace(/\/+$/, '')}/`)
    ? path.slice(dir.replace(/\/+$/, '').length + 1)
    : path;
  const w = weightSizes(info.tensors);
  const detail: ModelDetail = {
    ...toSummary(info, relPath),
    tensorCount: info.tensors.length,
    weights: {
      embedBytes: w.embedBytes,
      outputBytes: w.outputBytes,
      layersBytes: w.layers.reduce((a, l) => a + l.otherBytes, 0),
      expertsBytes: w.layers.reduce((a, l) => a + l.expertsBytes, 0),
      otherBytes: w.otherBytes,
      totalBytes: w.totalBytes,
    },
  };
  return reply(detail);
});
