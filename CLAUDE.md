Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Install with `pnpm install` (not `bun install`): see « Installation (pnpm) » below
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## Installation (pnpm)

Migration vers Node en cours (branche `node`, plan `docs/superpowers/plans/2026-11-12-node-migration.md`) : pnpm installe, Bun exécute encore tout (scripts, tests, build) jusqu'à N8.

- `pnpm install` à la racine installe tout le dépôt, `site/` compris : un seul `pnpm-lock.yaml` (à commiter avec tout changement de dépendance ; la CI fait `pnpm install --frozen-lockfile`). Workspaces, catalogue et réglages pnpm dans `pnpm-workspace.yaml` (pas de champ `workspaces` dans `package.json`, pas de réglage dans `.npmrc`).
- Une version partagée par deux projets ou plus vient du `catalog:` de `pnpm-workspace.yaml` (`"react": "catalog:"`) ; la changer là, pas dans les `package.json`.
- `allowBuilds` liste les scripts d'installation autorisés ; un paquet non listé qui en a un fait échouer l'installation : décider `true` (une fonctionnalité en a besoin) ou `false`. `bun: true` est le pair de `bun-plugin-tailwind` : ce `node_modules/.bin/bun` passe avant le Bun du système dans les scripts, d'où `bun-version` de la CI égale à la version de `bun` dans `pnpm-lock.yaml`. Garder les entrées `minimumReleaseAgeExclude` que pnpm ajoute.
- Biome ne détecte pas React depuis une version `catalog:` : le domaine `react` est activé explicitement pour `web/**` et `site/**` dans `biome.json`.

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

**Dans ce projet :** le `tsconfig.json` racine est une solution (project references, options communes dans `tsconfig.base.json`) : `bun check --no-script -b` vérifie chaque projet avec ses propres options (`packages/llamacpp-js` en types Node seuls, ses tests dans `tsconfig.test.json`, `packages/webui-shared`, `server`, `scripts`, `web`). Un projet ne voit qu'un autre qu'il liste dans ses `references`. Nouveau dossier de code → un projet référencé, pas de `paths` vers des sources d'un autre package.

## Format et lint (Biome)

Biome (devDependency épinglée, config dans `biome.json`) gère le format, le lint et le tri des imports. Style : 2 espaces, guillemets simples (doubles en JSX), 120 colonnes, point-virgules partout (`server/`, `packages/` et `web/`). `web/src/components/ui/**` (shadcn généré) est ignoré par Biome (ni format, ni lint, ni tri des imports) pour rester comparable aux mises à jour shadcn.

- `bun run lint` : vérifie format + lint + imports (lecture seule) ; `bun run lint:fix` applique les corrections sûres.
- **Avant de clore un jalon / milestone / lot de travail** (et avant de commiter ou d'ouvrir une PR), tout doit être vert : `bun run lint`, `bun run check`, `bun test`. Zéro erreur et zéro warning Biome.
- Ne pas désactiver une règle ni la baisser en `warn` pour faire passer le lint. Si une règle est un faux positif, `// biome-ignore lint/<groupe>/<règle>: <raison>` ciblé et motivé (voir `useExhaustiveDependencies` : les dépendances « déclencheur » sont volontaires). Pour lire la dernière valeur dans un effet sans le relancer, préférer `useEffectEvent` (React 19) à un ignore ; pour réinitialiser un état au changement d'identité, un `key` sur le composant plutôt qu'un effet.

## Langue

L'UI, les messages du serveur (erreurs, validations zod, logs, `--help`), les commentaires, les noms de tests, les messages de commit et les PR sont **en anglais**. Nombres, dates et unités passent par `web/src/lib/format.ts` (`LOCALE = 'en-US'` de `packages/webui-shared/src/format.ts`, `num`, `fmt`, `plural`, `formatBytes` en KiB/MiB/GiB…), côté serveur par `fmtInt` (`packages/webui-shared/src/format.ts`) : pas de locale codée en dur. Le web ne compare jamais un texte de message du serveur : utiliser un `code` (`HttpError`) ou un helper partagé (`isOomError`, `isDefaultTitle`).

## Packages (`packages/`)

`packages/webui-shared/` (`@llama-webui/shared`) : types, schémas zod et logique pure partagés par le serveur et le web. `packages/llamacpp-js/` : tout ce qui parle à llama.cpp (API HTTP de `llama-server`, métriques, `--help`, sortie de `llama-bench`, `/proc`), destiné à être publié sur npm. Règles de `llamacpp-js` (vérifiées par `tests/package.test.ts`, son projet TS et ses tests rejoués sous Node en CI) :

- **Exception à « préférer Bun » :** cible Node ≥ 24 **et** Bun, donc uniquement des API web et `node:*` dans `src/` (`fetch`, `node:child_process`, `node:fs/promises`), jamais `Bun.*`. Ses tests sont dans `tests/` (hors de `src/`) et utilisent `node:test` + `node:assert/strict` : ils tournent sous `bun test` et sous Node (`bun run --cwd packages/llamacpp-js test:node`, en CI sous Node 26 et, dans un job à part sans installation, sous Node 24, la version minimale). Bun n'implémente qu'une partie de `node:test` (ni snapshots, ni `mock.module()`, `test.only` ne filtre pas) : s'en tenir à ce que les deux supportent ; ce qui demande `Bun.build` passe `{ skip }` sans `Bun`.
- Aucune dépendance ni import de `@llama-webui/*` ; ce qui est un choix de llama-webui (superviseur, `buildCommand`, formulation des erreurs pour l'utilisateur, caches) reste dans l'app.
- TS exécutable tel quel par Node : imports relatifs avec extension `.ts`, `import type`, syntaxe effaçable (`erasableSyntaxOnly` : pas d'`enum`, de `namespace` ni de propriétés de paramètre).
- Tree-shakeable : ESM, `"sideEffects": false`, aucun état ni effet au chargement d'un module, un export par module dans `package.json` ; seul `llamacpp-js/node` utilise des API Node, le reste tourne aussi dans le navigateur.
- Erreurs : classes `Llama*Error` avec un `name` fixe ; l'app les traduit en messages.

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

**Dans ce projet :** `server/index.ts` importe `web/index.html` ; un seul process Bun sur le port 7860 sert l'API, le WebSocket et l'UI (Tailwind via `bun-plugin-tailwind` dans `bunfig.toml`). `bun run dev` = `bun --hot` (import HTML de `Bun.serve`, HMR, un seul bundle), `bun run start` = `NODE_ENV=production` : le front est construit au démarrage par `Bun.build` (`server/routes/web.ts`), en mémoire et découpé par page (`Bun.serve` ignore le découpage et inline les `import()` du routeur) ; pas d'étape de build. Le plugin Tailwind y est passé explicitement : un plugin ajouté à `bunfig.toml` doit l'être aussi dans `webPlugins()` (même fichier). `bun run compile` (`scripts/compile.ts`) produit l'exécutable autonome `dist/llama-webui` : mêmes options (`WEB_BUILD_OPTIONS`, `webPlugins()`), l'import HTML est bundlé et découpé à la compilation puis embarqué (`Bun.isStandaloneExecutable` → `{ '/*': index }`), toujours en production ; rien ne doit lire l'arborescence source à l'exécution (`import.meta.dir` vaut `/$bunfs/root` ; un `new Worker` doit être un entrypoint de compilation, cf. `workerUrl()` du worker NVML). Version (`server/version.ts`, barre d'état, `/api/health`) : `dev` depuis les sources, `git describe --tags --always --dirty` dans l'exécutable. `bun scripts/smoke-binary.ts` le vérifie (CI) ; `release.yml` publie les binaires x64/arm64 à chaque tag `v*`, qui doit égaler la version de tous les `package.json` : `bun run release <version>` les aligne (PR, `master` est protégée), puis tag `v<version>` sur `master` après le merge ; `scripts/release.test.ts` échoue s'ils divergent.

**Piège `bun --hot` :** le superviseur llama-server, le ring de logs, le monitoring et la garde des benchmarks (`server/runtime.ts`, `server/bench/gate.ts`) vivent sur `globalThis` pour survivre aux rechargements (sinon chaque sauvegarde tuerait llama-server). Une modification de `server/supervisor/supervisor.ts` (et de ce qu'il importe : `llamacpp-js/client`, `llamacpp-js/node`, `server/logs/lines.ts`), `server/logs/buffer.ts`, `server/bench/gate.ts`, `server/monitor/**` (sauf `placement.ts`, recréé à chaque rechargement), `server/collectors/**`, `packages/llamacpp-js/src/**` (importé par le superviseur et le monitoring) ou `server/runtime.ts` n'est donc **pas** prise en compte à chaud : arrêter Bun (Ctrl-C) et relancer `bun run dev`. Pour la même raison, ne pas tester les erreurs du superviseur avec `instanceof` (classe de l'ancien module) mais par `name`. À l'inverse, `ChatRuns` (`server/chat/runs.ts`), `BenchRunner` et `RunExecutor` (`server/bench/`) sont recréés à chaque rechargement : une génération ou un run ponctuel en cours est interrompu (le serveur arrêté pour lui est relancé) ; un sweep, lui, continue dans le nouveau module (l'élément en cours est rejoué, la garde reste tenue, le serveur n'est relancé qu'à la fin).

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

## Site web et documentation (`site/`)

Le site public (page d'accueil, doc utilisateur, doc développeur) vit dans `site/` et est publié sur GitHub Pages (`https://sharkezz.github.io/llama-webui/`, base `/llama-webui/`). Plan et jalons : `docs/superpowers/plans/2026-11-08-website.md`.

- **Exception à « pas de Vite » :** `site/` utilise Vite + React Router (mode framework, `ssr: false` + prérendu statique) + Tailwind 4 + shadcn + MDX. C'est un projet du workspace pnpm (installé par le `pnpm install` racine, sans lockfile propre), exécuté avec Bun (`bun run`, `bun test`). Il n'importe aucun code de `web/` : les composants repris (tokens, verre, jauges…) sont copiés et adaptés.
- Mêmes règles qualité que l'app (Biome sans warning, type check, tests verts) ; le contenu est en anglais, URLs avec slash final. Les scripts racine couvrent le site : `bun run check` lance aussi `site` → `typecheck` (`react-router typegen` puis `bun check`), `bun test` inclut `site/`, et la CI (`.github/workflows/ci.yml`) construit le site. Biome ignore les `.mdx` (non supportés) et `site/src/components/ui/**` (shadcn).
- **Commandes :** après le `pnpm install` racine, depuis la racine `bun run site:dev` (Vite + HMR sur `0.0.0.0:5173`, ouvrir `http://192.168.0.20:5173/llama-webui/`), `bun run site:build` (prérendu + `scripts/postbuild.ts` → `site/dist/`) et `bun run site:preview` (`scripts/serve.ts` sert `dist/` comme GitHub Pages sur le port 4173 : sous `/llama-webui/`, redirection vers le slash final, `404.html`).
- **Pages :** chaque `.mdx` de `site/content/{docs,developers}/` devient une route prérendue (`src/routes.ts`, `src/lib/content.ts`). Les liens internes s'écrivent sans basename (`/docs/…/`) : React Router ajoute `/llama-webui`. Le prérendu écrit sous `build/client/llama-webui/` ; `postbuild` remonte ces pages à la racine de `dist/` et transforme le fallback SPA en `404.html` (route `*`). Le déploiement (`.github/workflows/site-deploy.yml`) part à chaque push sur `master` qui touche `site/` (ou à la main, `workflow_dispatch`) : une PR fusionnée publie aussitôt sa doc.
- **Écrire une page :** front matter YAML `title` + `description` obligatoires (le build échoue sinon ; le titre `h1` vient de là, ne pas en écrire dans le corps), entrée dans `site/content/nav.ts` (`site/src/docs/nav.test.ts` échoue si une page n'y est pas ou si une entrée n'a pas de fichier), sections en `##` / `###` (sommaire). Composants MDX disponibles sans import (`site/src/docs/mdx-components.tsx`) : `Callout` (`note`, `tip`, `warning`, `important`), `Steps` / `Step`, `Tabs` / `Tab`, `Screenshot`, `Kbd`, et pour la doc développeur `Endpoint` (méthode + chemin d'une route, sous le titre qui la nomme), `FileTree` (liste Markdown, nom entre backticks, `/` final pour un dossier) et `ArchitectureDiagram` ; `title="…"` après le langage d'un bloc de code (`bash title="Terminal"`) lui donne un titre. Après `bun run site:build`, `bun run --cwd site check-links` vérifie chaque lien interne et ancre (bloquant en CI). La recherche (Pagefind, index écrit par `postbuild`) n'existe qu'après un build : `site:preview` pour la tester.
- **Captures d'écran (`site/public/screenshots/<nom>-<dark|light>[-800].webp`) :** elles viennent d'une **instance démo** (jamais l'instance de tous les jours), lancée avec un home neutre pour qu'aucun chemin personnel n'apparaisse : `env -u HF_TOKEN HOME=/home/demo PATH="/home/demo/llama.cpp/build/bin:$PATH" bun run start --host 0.0.0.0 --port 7861` (`/home/demo/models` → dossier des modèles, `/home/demo/llama.cpp/build/bin` en liens physiques : l'app fait un `realpath` du binaire). `bun run --cwd site demo-seed setup bench sweep start chat` remplit l'instance (vrais modèles sur les GPU : demander à l'utilisateur de les libérer), puis `bun run --cwd site screenshots [nom…]` capture en Chromium headless (sombre et clair) ; `demo-seed generate` puis `screenshots --live` pour Dashboard/System/Topology. Liste et mise en scène des écrans : `site/scripts/shots.ts`. Une modification d'UI qui change un écran capturé → refaire sa capture (et `bun run --cwd site og` si c'est le Dashboard : image Open Graph). La page d'accueil reproduit aussi en React des écrans de l'app, avec leurs vraies valeurs (Dashboard animé du hero, éditeur d'arguments, recommandation Tuning, etc. dans `site/src/landing/`) : les mettre à jour avec eux.
- **Synchroniser la doc avec le code (obligatoire) :** toute modification d'une fonctionnalité, de l'UI, d'une route API, d'un message WebSocket, d'un flag CLI, d'un réglage ou de l'architecture met à jour, **dans la même PR**, la ou les pages correspondantes de `site/content/` (la référence API est écrite à la main : elle dérive si on l'oublie). Correspondance code → pages (chemins sous `site/content/`) :

| Code modifié                                                                                         | Pages à mettre à jour                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `server/routes/<domaine>.ts`, `server/app.ts` (→ `app`), schémas zod de `packages/webui-shared/src/` | `developers/api/<domaine>.mdx` + la page utilisateur de la fonctionnalité                               |
| `packages/webui-shared/src/ws.ts`, `server/ws/`                                                      | `developers/api/websocket.mdx`                                                                          |
| `server/cli.ts`, `server/paths.ts`, variables d'environnement                                        | `docs/configuration.mdx`, `developers/architecture.mdx`                                                 |
| `server/security.ts`, `server/http.ts`                                                               | `docs/security.mdx`, `developers/server/security.mdx`, `developers/api/overview.mdx`                    |
| `server/supervisor/**`                                                                               | `developers/server/supervisor.mdx`, `docs/server.mdx`                                                   |
| `server/logs/**`                                                                                     | `developers/server/supervisor.mdx`, `developers/api/server.mdx`, `docs/logs.mdx`                        |
| `server/monitor/**`, `server/collectors/**`                                                          | `developers/server/monitor.mdx`, `docs/dashboard.mdx`, `docs/system.mdx`, `docs/topology.mdx`           |
| `server/hardware/**` (PCI, CPU)                                                                      | `developers/api/topology.mdx`, `developers/api/monitor.mdx`, `docs/topology.mdx`, `docs/system.mdx`     |
| `server/chat/**`                                                                                     | `developers/server/chat.mdx`, `docs/chat.mdx`                                                           |
| `server/bench/**`                                                                                    | `developers/server/bench.mdx`, `docs/benchmark.mdx`, `docs/sweeps.mdx`                                  |
| `packages/webui-shared/src/tuning.ts`, `server/tuning/**`                                            | `developers/server/tuning.mdx`, `docs/tuning.mdx`, `docs/sweeps.mdx`, guides concernés                  |
| `server/hf/**`                                                                                       | `developers/server/hugging-face.mdx`, `docs/hugging-face.mdx`                                           |
| `server/models/**` (scan, GGUF)                                                                      | `developers/api/models.mdx`, `docs/models.mdx`                                                          |
| `server/setup.ts`                                                                                    | `developers/api/setup.mdx`, `docs/getting-started/first-run.mdx`                                        |
| `server/llamatui.ts`                                                                                 | `developers/api/profiles.mdx`, `docs/profiles.mdx`                                                      |
| `server/db/**` (migrations, tables)                                                                  | `developers/server/database.mdx`                                                                        |
| `web/src/features/home/setup/**`                                                                     | `docs/getting-started/first-run.mdx`                                                                    |
| `web/src/features/<page>/**`                                                                         | `docs/<page>.mdx` (`bench` → `benchmark`, HF de `models` → `hugging-face`), captures                    |
| `web/src/app/**`, `web/src/lib/**`, `web/src/components/**`                                          | `developers/frontend.mdx`                                                                               |
| `packages/llamacpp-js/**` (module, export, erreur, règle du package)                                 | `developers/llamacpp-js.mdx` + la page serveur qui l'utilise (`supervisor`, `monitor`, `chat`, `bench`) |
| `packages/webui-shared/src/**` (nouveau module, rôle d'un module)                                    | `developers/shared.mdx`                                                                                 |
| `packages/webui-shared/src/settings.ts`, page Settings                                               | `docs/settings.mdx`, `developers/api/app.mdx`                                                           |
| `server/index.ts`, `server/runtime.ts`, `server/routes/web.ts`, piège `bun --hot`                    | `developers/architecture.mdx`                                                                           |
| scripts `package.json`, arborescence du dépôt                                                        | `developers/getting-started.mdx`                                                                        |
| `server/testing/**`, `testdata/**` (fakes, fixtures)                                                 | `developers/contributing/testing.mdx`                                                                   |
| prérequis / installation (README)                                                                    | `docs/getting-started/requirements.mdx`, `docs/getting-started/installation.mdx`                        |
| conventions de ce fichier (Biome, langue, tests, doc)                                                | `developers/contributing/*.mdx`                                                                         |
