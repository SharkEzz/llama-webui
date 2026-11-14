import { Effect, FileSystem, Layer, Path } from 'effect';
import { layerFrom } from '../http/Static.ts';

/** The files of a built UI, as `vite build` lays them out: the page, a file of the root, a hashed asset. */
export const PUBLIC = {
  'index.html': '<!doctype html><title>llama-webui</title><script type="module" src="/assets/a-1234.js"></script>',
  'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'assets/a-1234.js': 'console.log(1);',
};

/** `Static.layerFrom` on a temporary `public/` that holds `PUBLIC`, removed with the layer. */
export const PublicTest = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-public-' });
    yield* fs.makeDirectory(path.join(root, 'assets'));
    for (const [name, text] of Object.entries(PUBLIC)) yield* fs.writeFileString(path.join(root, name), text);
    return layerFrom(root);
  }),
);
