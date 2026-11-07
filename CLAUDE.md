Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Type checking

Use `bun check` to type check the project. It reads `tsconfig.json` and reports the same errors as `tsc`.

- `bun check src/index.ts` checks one file and what it imports
- `bun --check src/index.ts`, `bun test --check` and `bun build --check` type check first, and do nothing else if there is an error

## Format et lint (Biome)

Biome (global, config dans `biome.json`) gère le format, le lint et le tri des imports. Style conservé : 2 espaces, guillemets doubles, 120 colonnes, point-virgules dans `server/` et `shared/`, **sans** point-virgule dans `web/` (style shadcn). `web/src/components/ui/**` (shadcn généré) n'est pas linté.

- `bun run lint` : vérifie format + lint + imports (lecture seule) ; `bun run lint:fix` applique les corrections sûres.
- **Avant de clore un jalon / milestone / lot de travail** (et avant de commiter ou d'ouvrir une PR), tout doit être vert : `bun run lint`, `bun run check`, `bun test`. Zéro erreur et zéro warning Biome.
- Ne pas désactiver une règle ni la baisser en `warn` pour faire passer le lint. Si une règle est un faux positif, `// biome-ignore lint/<groupe>/<règle>: <raison>` ciblé et motivé (voir `useExhaustiveDependencies` : les dépendances « déclencheur » sont volontaires).
- `git config blame.ignoreRevsFile .git-blame-ignore-revs` pour que `git blame` saute le commit de formatage initial.

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

**Dans ce projet :** `server/index.ts` importe `web/index.html` ; un seul process Bun sur le port 7860 sert l'API, le WebSocket et l'UI (Tailwind via `bun-plugin-tailwind` dans `bunfig.toml`). `bun run dev` = `bun --hot`, `bun run start` = `NODE_ENV=production` (bundle en mémoire, pas d'étape de build).

**Piège `bun --hot` :** le superviseur llama-server, le ring de logs et la garde des benchmarks (`server/runtime.ts`, `server/bench/gate.ts`) vivent sur `globalThis` pour survivre aux rechargements (sinon chaque sauvegarde tuerait llama-server). Une modification de `server/supervisor/supervisor.ts`, `server/logs/buffer.ts`, `server/bench/gate.ts` ou `server/runtime.ts` n'est donc **pas** prise en compte à chaud : arrêter Bun (Ctrl-C) et relancer `bun run dev`. Pour la même raison, ne pas tester les erreurs du superviseur avec `instanceof` (classe de l'ancien module) mais par `name`. À l'inverse, `ChatRuns` (`server/chat/runs.ts`), `BenchRunner` et `RunExecutor` (`server/bench/`) sont recréés à chaque rechargement : une génération ou un run ponctuel en cours est interrompu (le serveur arrêté pour lui est relancé) ; un sweep, lui, continue dans le nouveau module (l'élément en cours est rejoué, la garde reste tenue, le serveur n'est relancé qu'à la fin).

**Nouveau fichier web :** le bundler de `bun run dev` peut ne pas voir un fichier `web/src/**` créé après le démarrage (« Could not resolve », alors que `bun check` passe) : relancer `bun run dev`.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
