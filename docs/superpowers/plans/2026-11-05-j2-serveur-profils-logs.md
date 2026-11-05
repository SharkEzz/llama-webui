# J2 — Serveur, profils, logs : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Piloter un `llama-server` local depuis l'UI : profils persistés en sqlite (CRUD, import/export JSON compatible llama-tui), start/stop/restart/switch supervisés, logs en direct.

**Architecture:** La logique métier est **copiée et adaptée** de `../llama-tui/src` (version TS ; ignorer `cmd/`, `internal/`, Go). Les fonctions pures partagées par serveur et web (schéma de profil, découpage shell, catalogue de flags) vont dans `shared/` ; le superviseur, la découverte `/proc` et le ring de logs dans `server/`. Le serveur pousse `server-state` et `log` sur le WS existant ; le web les range dans deux stores zustand.

**Tech Stack:** existant J1 (Bun 1.4.4, bun:sqlite, zod 4, React 19, react-router 8, zustand 5, shadcn Base UI) + `@tanstack/react-virtual` (liste de logs).

**Spec:** `docs/superpowers/specs/2026-11-05-llama-webui-design.md` (section J2). Socle : `docs/superpowers/plans/2026-11-05-j1-socle.md`.

## Global Constraints

- UI en français, thème sombre uniquement ; design J1 (`GlassCard`, `StatTile`, `.glass`, `.num`, tons violet/cyan/ambre/rose).
- Une seule instance llama-server à la fois. Usage localhost, pas d'auth.
- États serveur : `idle / starting / ready / stopping / crashed / external` ; pdeathsig via `setpriv --pdeathsig KILL` ; SIGTERM puis SIGKILL après **5 s** ; détection d'un serveur externe par `/proc`.
- Flags réservés (refusés dans `args`) : `--host --port --metrics --slots --props -m --model -mm --mmproj`.
- Ring de logs : **10 000 lignes**, pas de persistance.
- Tests minimaux : seulement args / validation de profil / parse des flags, avec la fixture `llama-server-help.txt` de llama-tui. Le reste se vérifie à la main.
- Fixtures copiées dans `testdata/` du dépôt (pas de chemin vers `../llama-tui` dans les tests).
- Commits en français, un par tâche, suffixe `Co-Authored-By:` du modèle qui exécute.
- Sécurité (revue J1) : toute nouvelle route `/api/*` est enveloppée par `guarded()` de `server/app.ts` (contrôle Host/Origin, corps JSON obligatoire en écriture) ; les clients web envoient `content-type: application/json` (déjà fait par `api()`).
- Un seul process Bun sur 7860 (UI par HTML import, pas de Vite) ; `LLAMA_WEBUI_HOST=0.0.0.0` pour vérifier depuis le navigateur distant (http://192.168.0.20:7860).

## Review Focus

1. **Rechargement à chaud (`bun --hot`) pendant qu'un llama-server tourne** : modifier un fichier serveur ne doit ni tuer ni orpheliner le llama-server ; le superviseur et le ring de logs survivent au rechargement. Vérif manuelle Task 4.
2. **Arrêt de Bun (Ctrl-C / SIGTERM / crash)** : aucun llama-server orphelin ne reste (handler SIGINT/SIGTERM + pdeathsig). Vérif manuelle Task 4 : `pgrep llama-server` vide après Ctrl-C.
3. **Port déjà pris par un llama-server lancé à la main** : l'UI affiche « Externe (PID n) », Démarrer est refusé avec un message clair (409), l'état repasse à « Arrêté » quand l'externe s'arrête. Vérif manuelle Task 4.
4. **Double clic / actions concurrentes** (Démarrer deux fois, Basculer pendant un démarrage) : jamais deux serveurs ; la 2ᵉ action reçoit 409 « opération en cours ». Couvert par le verrou `exclusive` copié ; vérif manuelle Task 4.
5. **Import d'un JSON llama-tui partiel ou invalide** (profil sans `model`, flag réservé dans `args`, nom en double) : les profils valides sont importés, les autres listés avec la raison ; rien n'est écrasé. Test en Task 1.

---

### Task 1 : `shared/` — profils, shell, flags, types serveur/logs

**Files:**
- Create : `shared/src/profile.ts`, `shared/src/shell.ts`, `shared/src/flags.ts`, `shared/src/server.ts`, `shared/src/logs.ts`
- Modify : `shared/src/ws.ts`, `shared/src/settings.ts`, `shared/src/index.ts`
- Copy : `../llama-tui/testdata/llama-server-help.txt` → `testdata/llama-server-help.txt` ; `../llama-tui/testdata/config/ts-current.json` → `testdata/llama-tui-config.json`
- Test : `shared/src/flags.test.ts`, `shared/src/profile.test.ts`

**Interfaces (Produces) :**
- `profile.ts` (copie adaptée de `llama-tui/src/config/schema.ts`) :
  - `RESERVED_FLAGS`, `reservedFlag(arg): string | undefined`, `reservedFlagMessage(flag)` → « `${flag} est géré par llama-webui (utilisez les champs du profil)` ».
  - `ProfileInputSchema` = `ProfileSchema` de llama-tui (`strictObject` name, model, mmproj?, cwd?, host?, port?, args default `[]`, env default `{}`) **+** `superRefine` qui refuse les flags réservés dans `args` (path `["args", j]`).
  - `type ProfileInput = z.infer<…>` ; `type Profile = ProfileInput & { id: number; source: "ui" | "import" | "llama-tui"; createdAt: number; updatedAt: number }`.
  - `parseProfileImport(raw: unknown): { profiles: ProfileInput[]; rejected: { name: string; reason: string }[] }` — accepte une config llama-tui entière (`{ profiles: [...] }`, autres clés ignorées), un tableau de profils, ou un profil seul ; valide chaque profil isolément avec `ProfileInputSchema` ; `reason` = premier message zod + chemin ; nom absent → `name: "(sans nom)"` ; doublon de nom **dans le fichier** → le second est rejeté (« nom en double dans le fichier »).
- `shell.ts` : `shellQuote(args: string[]): string`, `shellSplit(text: string): string[] | { error: string }` — copie de `llama-tui/src/server/args.ts`.
- `flags.ts` : copie de `llama-tui/src/server/flags.ts` **sans** `loadFlags` (qui spawn, reste serveur) : `Flag`, `FlagCatalog`, `parseHelp`, `catalogFrom(flags: Flag[]): FlagCatalog` (nouveau : reconstruit `byName` côté web), `flagOf`, `complete`, `unknownFlags`, `describeFlag`.
- `server.ts` : `ServerState` (copie exacte du type llama-tui, avec en plus `profileId: number` sur `starting | ready | stopping | crashed`) ; `interface ServerView { state: ServerState; command: string | null /* display shell-quoté de la dernière commande */; profileId: number | null }`.
- `logs.ts` : `LogLevel`, `LogKind`, `LogLine`, `LEVEL_ORDER`, `classifyLine`, `filterLogs` — copies de `llama-tui/src/logs/buffer.ts` (sans la classe `LogBuffer`).
- `ws.ts` : `log` → `{ type: "log"; payload: LogLine[] }` (lot) ; `server-state` → `{ type: "server-state"; payload: ServerView }`.
- `settings.ts` : ajouter `defaultProfileId: z.number().int().nullable().default(null)` et `llamaTuiImportDismissed: z.boolean().default(false)`.

- [ ] **Step 1 : Copier les fixtures** dans `testdata/` (noms ci-dessus).
- [ ] **Step 2 : Tests** — `shared/src/flags.test.ts` : copier `../llama-tui/test/flags.test.ts` sans le bloc `loadFlags`, fixture `testdata/llama-server-help.txt` (attendus inchangés : 47 flags, `-c`/`--ctx-size` même objet, etc.) + `catalogFrom(catalog.flags).byName.get("-ngl") === …byName.get("--n-gpu-layers")`. `shared/src/profile.test.ts` :
  ```ts
  test("import llama-tui : config entière", async () => {
    const raw = await Bun.file("testdata/llama-tui-config.json").json();
    const r = parseProfileImport(raw);
    expect(r.profiles.map((p) => p.name)).toEqual(["qwen3.8-27b-mtp", "qwen3.8-27b-mtp (optimisé) (optimisé)"]);
    expect(r.rejected).toEqual([]);
  });
  test("import : valides gardés, invalides expliqués", () => {
    const r = parseProfileImport({ profiles: [
      { name: "ok", model: "m.gguf" },
      { name: "sans-modele" },
      { name: "reserve", model: "m.gguf", args: ["--port", "9000"] },
      { name: "ok", model: "autre.gguf" },
    ] });
    expect(r.profiles.map((p) => p.name)).toEqual(["ok"]);
    expect(r.rejected.map((x) => x.name)).toEqual(["sans-modele", "reserve", "ok"]);
    expect(r.rejected[1]!.reason).toContain("--port est géré par llama-webui");
  });
  test("import : profil seul et tableau", () => {
    expect(parseProfileImport({ name: "a", model: "m" }).profiles).toHaveLength(1);
    expect(parseProfileImport([{ name: "a", model: "m" }, { name: "b", model: "m" }]).profiles).toHaveLength(2);
  });
  ```
- [ ] **Step 3 : Vérifier l'échec** — `bun test shared` : FAIL (modules absents).
- [ ] **Step 4 : Implémenter** les fichiers selon Interfaces ; `index.ts` ré-exporte tout ; script racine `test` devient `bun test server shared` (inchangé) — vérifier que `shared/src/*.test.ts` est trouvé.
- [ ] **Step 5 : Vérifier** — `bun test` : PASS ; `bun run check` : vert (adapter `server/db/settings.test.ts` si `DEFAULT_SETTINGS` change — il compare à `DEFAULT_SETTINGS`, donc reste vert).
- [ ] **Step 6 : Commit** — `J2: types partagés profils, shell, flags, logs, état serveur`.

---

### Task 2 : `server/` — superviseur, args, découverte, flags, ring de logs

**Files:**
- Create : `server/supervisor/supervisor.ts`, `server/supervisor/args.ts`, `server/supervisor/health.ts`, `server/supervisor/discovery.ts`, `server/supervisor/flags.ts`, `server/logs/buffer.ts`, `server/logs/lines.ts`
- Copy : `../llama-tui/test/fixtures/fake-llama-server.ts` + `fake-llama-server` (sh) + `props.json`, `slots-busy.json`, `metrics-after.txt` → `testdata/fake/`
- Test : `server/supervisor/args.test.ts`

**Interfaces:**
- Consumes : `shared` (Task 1) — `ProfileInput`, `Profile`, `Settings`, `ServerState`, `shellQuote`, `parseHelp`, `classifyLine`, `LogLine`.
- Produces :
  - `args.ts` : `BuiltCommand` (llama-tui + `profileId: number`), `expandHome(p, home?)`, `profilePaths(profile: ProfileInput, home?)`, `buildCommand(profile: Profile, settings: Pick<Settings, "binary" | "host" | "port">, home?): BuiltCommand` — copie de llama-tui où `config.server.*` devient `settings.*`.
  - `health.ts`, `discovery.ts` : copies exactes (`probeHealth`, `parseCmdline`, `portFromArgv`, `findLlamaServerPid`).
  - `flags.ts` : `loadFlags(binary, timeoutMs = 5000): Promise<FlagCatalog | null>` (copie) + `getFlags(binary): Promise<Flag[] | null>` mis en cache par binaire.
  - `logs/lines.ts` : `LineSplitter` (copie). `logs/buffer.ts` : `class LogBuffer { constructor(capacity = 10_000); push(text: string): void; since(seq: number): LogLine[]; get seq(): number; onLines(fn: (lines: LogLine[]) => void): () => void }` — `onLines` reçoit les nouvelles lignes regroupées par microtâche (un message WS par lot).
  - `supervisor.ts` : copie de `Supervisor` ; messages `[llama-tui]` → `[llama-webui]` ; `ServerState` importé de `shared` avec `profileId` propagé depuis `BuiltCommand`.
- [ ] **Step 1 : Test** — `server/supervisor/args.test.ts` : copier `../llama-tui/test/args.test.ts` en entier (les tests `shellQuote/shellSplit` importent depuis `@llama-webui/shared`) ; remplacer la `Config` par `settings = { binary: "llama-server", host: "0.0.0.0", port: 8080 }` et les profils par des `Profile` (`id: 1, source: "ui", createdAt: 0, updatedAt: 0`) ; ajouter `expect(cmd.profileId).toBe(1)`.
- [ ] **Step 2 : Vérifier l'échec** — `bun test server` : FAIL.
- [ ] **Step 3 : Implémenter** les fichiers selon Interfaces.
- [ ] **Step 4 : Vérifier** — `bun test` : PASS ; `bun run check` vert.
- [ ] **Step 5 : Vérifier à la main le superviseur** — script jetable (non commité) : `Supervisor` + `buildCommand` sur `testdata/fake/fake-llama-server` comme binaire, port libre → états `starting → ready`, `stop()` → `idle`, logs reçus via `onLines`.
- [ ] **Step 6 : Commit** — `J2: superviseur, args, découverte, flags et ring de logs (copiés de llama-tui)`.

---

### Task 3 : Profils — sqlite et API REST

**Files:**
- Modify : `server/db/migrations.ts`, `server/app.ts`, `server/index.ts`
- Create : `server/db/profiles.ts`, `server/routes/profiles.ts`, `server/llamatui.ts`

**Interfaces:**
- Consumes : Task 1 (`ProfileInputSchema`, `parseProfileImport`, `Profile`), `SettingsRepo` (J1).
- Produces :
  - Migration 2 : `CREATE TABLE profiles(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, model_path TEXT NOT NULL, mmproj_path TEXT, cwd TEXT, host TEXT, port INTEGER, args_json TEXT NOT NULL, env_json TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`.
  - `class ProfilesRepo { list(): Profile[]; get(id): Profile | null; create(input: ProfileInput, source?: Profile["source"]): Profile; update(id, input: ProfileInput): Profile; remove(id): void; duplicate(id): Profile; importMany(inputs: ProfileInput[], source): { imported: Profile[]; skipped: { name: string; reason: string }[] } }` — `create/update` valident avec `ProfileInputSchema` ; nom pris → `ProfileConflictError` ; `duplicate` nomme « `<nom> (copie)` », puis « (copie 2) »… ; `importMany` ne remplace jamais : nom déjà en base → `skipped` « existe déjà ».
  - `llamatui.ts` : `llamaTuiConfigPath(env = process.env)` (copie de `defaultConfigPath`), `readLlamaTuiProfiles(): Promise<{ path: string; exists: boolean; profiles: ProfileInput[]; rejected: … }>`.
  - Routes (JSON, erreurs `{ error: string, issues?: ZodIssue[] }`) :
    | Méthode | Chemin | Réponse |
    |---|---|---|
    | GET | `/api/profiles` | `Profile[]` (tri par nom) |
    | POST | `/api/profiles` | `Profile` 201 ; 400 invalide ; 409 nom pris |
    | GET/PUT/DELETE | `/api/profiles/:id` | `Profile` / `Profile` / 204 ; 404 inconnu ; DELETE 409 si c'est le profil du serveur en cours |
    | POST | `/api/profiles/:id/duplicate` | `Profile` 201 |
    | GET | `/api/profiles/:id/export` | `ProfileInput` (sans id ni dates), `content-disposition: attachment; filename="<nom>.json"` |
    | GET | `/api/profiles/export` | `{ profiles: ProfileInput[] }` (format importable par llama-tui) |
    | POST | `/api/profiles/import` | body = JSON brut ; `{ imported: Profile[]; skipped: {name, reason}[] }` (rejets de `parseProfileImport` + doublons en base) |
    | GET | `/api/profiles/import/llama-tui` | `{ path, exists, names: string[], dismissed: boolean, profileCount: number }` |
    | POST | `/api/profiles/import/llama-tui` | comme `/import`, source `"llama-tui"` ; si la config llama-tui a `defaultProfile`, régler `defaultProfileId` s'il est encore `null` |
- [ ] **Step 1 : Implémenter** migration, repo, `llamatui.ts`, routes ; brancher dans `createApp` via `guarded()` (passer `profiles: ProfilesRepo` dans `AppDeps`).
- [ ] **Step 2 : Vérifier à la main** (`bun run start`, `LLAMA_WEBUI_DATA_DIR` temporaire) : `GET /api/profiles/import/llama-tui` → `exists: true`, 2 noms ; `POST` → 2 importés ; 2ᵉ `POST` → 0 importé, 2 `skipped` « existe déjà » ; `POST /api/profiles` avec `args: ["--port","1"]` → 400 avec le message réservé ; duplicate → « (copie) » ; export puis réimport du fichier exporté après suppression → identique.
- [ ] **Step 3 : Commit** — `J2: profils en sqlite, API CRUD, import/export llama-tui`.

---

### Task 4 : Serveur géré — API, WS, cycle de vie Bun

**Files:**
- Create : `server/routes/server.ts`, `server/runtime.ts`
- Modify : `server/app.ts`, `server/index.ts`, `server/ws/hub.ts`

**Interfaces:**
- Consumes : Tasks 2-3.
- Produces :
  - `runtime.ts` : `getRuntime(): { supervisor: Supervisor; logs: LogBuffer }` — singleton stocké sur `globalThis.__llamaWebuiRuntime`, **créé une seule fois et conservé à travers `bun --hot`** (le dispose J1 ne libère que hub et db). Installe une seule fois `process.on("SIGINT" | "SIGTERM")` → `await supervisor.stop()` puis `process.exit(0)`, et `process.on("exit")` → `supervisor.killNow()`.
  - `serverView(): ServerView` ; diffusion : `supervisor.subscribe` → `hub.broadcast({ type: "server-state", payload })` ; `logs.onLines` → `hub.broadcast({ type: "log", payload: lines })`. Les abonnements sont refaits à chaque rechargement (désabonner les anciens dans le dispose).
  - Détection externe : au démarrage `detectExternal(settings.port)` ; toutes les 2 s, si `external` → `recheckExternal()`, si `idle` → `detectExternal(settings.port)`.
  - Routes :
    | Méthode | Chemin | Corps | Réponse |
    |---|---|---|---|
    | GET | `/api/state` | — | `{ server: ServerView; logSeq: number }` (rejeu après reconnexion WS) |
    | GET | `/api/server/state` | — | `ServerView` |
    | POST | `/api/server/start` | `{ profileId }` | `ServerView` 202 ; 404 profil ; 409 `SupervisorError` |
    | POST | `/api/server/stop` | — | `ServerView` après arrêt |
    | POST | `/api/server/restart` | — | relit le profil courant en base, `switchTo(buildCommand(...))` |
    | POST | `/api/server/switch` | `{ profileId }` | `switchTo` |
    | GET | `/api/server/props` | — | proxy `GET http://127.0.0.1:<port>/props` si `ready` ou `external` ; sinon 409 « serveur non prêt » |
    | GET | `/api/flags` | — | `{ flags: Flag[] }` ou 503 `{ error: "llama-server --help a échoué (<binaire>)" }` |
    | GET | `/api/logs?since=<seq>` | — | `{ lines: LogLine[]; seq: number }` |
  - `start`/`switch` mémorisent `defaultProfileId = profileId`.
- [ ] **Step 1 : Implémenter** `runtime.ts`, routes, branchements.
- [ ] **Step 2 : Vérifier à la main avec le faux serveur** — `PATCH /api/settings {"binary": "<repo>/testdata/fake/fake-llama-server"}`, profil factice, `start` → WS `server-state` starting puis ready, lignes `log` ; deux `start` rapprochés → le 2ᵉ en 409 ; `stop` → idle.
- [ ] **Step 3 : Vérifier les points 1-3 du Review Focus** — (1) `bun --hot` : toucher `server/app.ts` pendant `ready` → toujours `ready`, même PID ; (2) Ctrl-C sur `bun run dev` → `pgrep -f fake-llama-server` vide ; (3) lancer le faux serveur à la main sur le port → état `external` avec PID, `start` → 409 explicite, tuer l'externe → `idle` sous 2 s.
- [ ] **Step 4 : Commit** — `J2: API serveur (start/stop/restart/switch, props, flags, logs) et diffusion WS`.

---

### Task 5 : Web — stores, page Serveur, pastille globale

**Files:**
- Modify : `web/src/lib/ws.ts`, `web/src/lib/api.ts`, `web/src/app/StatusBar.tsx`, `web/src/app/router.tsx`
- Create : `web/src/lib/server.ts`, `web/src/lib/logs.ts`, `web/src/features/server/ServerPage.tsx`, `web/src/features/server/ServerStateBadge.tsx`, `web/src/components/ConfirmDialog.tsx`
- shadcn : `bunx shadcn@latest add alert-dialog select input label textarea switch dropdown-menu`

**Interfaces:**
- `ws.ts` : ajouter `onWs<T extends WsMessage["type"]>(type: T, fn: (msg: Extract<WsMessage, { type: T }>) => void): () => void`.
- `lib/server.ts` : store `useServer { view: ServerView | null; set(view) }`, alimenté par `onWs("server-state")` et par `GET /api/state` à chaque passage du WS à `open`. Actions `startProfile(id)`, `stopServer()`, `restartServer()`, `switchProfile(id)` → toast d'erreur avec `ApiError.message`.
- `lib/logs.ts` : store `useLogs { lines: LogLine[]; seq: number }` (≤ 10 000, les plus anciennes jetées), alimenté par `onWs("log")` ; à la reconnexion `GET /api/logs?since=<seq>`.
- `ServerStateBadge({ state })` : libellés **Arrêté** (idle), **Démarrage…** (starting, ambre pulsé), **Prêt** (ready, vert), **Arrêt…** (stopping), **Planté** (crashed, rouge, code/signal en infobulle), **Externe** (external, cyan, « PID n » ).
- `ConfirmDialog({ title, description, confirmLabel, onConfirm, children /* trigger */ })` sur `alert-dialog`.
- `ServerPage` : carte état (badge, profil, PID, port, depuis), sélecteur de profil + boutons **Démarrer** / **Arrêter** / **Redémarrer** / **Basculer** (activés selon l'état ; Arrêter, Redémarrer, Basculer passent par `ConfirmDialog`), carte **Commande effective** (`command` en mono, bouton Copier), carte **Infos du serveur** (`/props` quand `ready|external` : modèle, `n_ctx`, slots, build, modalités ; rafraîchie au passage à `ready`), carte **Derniers logs** (20 dernières lignes + lien « Tous les logs » vers `/logs`).
- `StatusBar` : ajoute `ServerStateBadge` + nom du profil à gauche de la pastille WS.
- [ ] **Step 1 : Implémenter** ; `router.tsx` : `/server` → `ServerPage`.
- [ ] **Step 2 : Vérifier à la main** (faux serveur) — Démarrer → Démarrage… puis Prêt sans recharger ; Arrêter demande confirmation ; badge de la barre d'état synchronisé sur toutes les pages ; serveur Bun relancé → état et logs rejoués.
- [ ] **Step 3 : Commit** — `J2: page Serveur, stores serveur et logs`.

---

### Task 6 : Web — page Profils

**Files:**
- Create : `web/src/features/profiles/ProfilesPage.tsx`, `ProfileForm.tsx`, `ArgsEditor.tsx`, `EnvEditor.tsx`, `ImportBanner.tsx`, `web/src/lib/flags.ts`, `web/src/lib/profiles.ts`
- Modify : `web/src/app/router.tsx`

**Interfaces:**
- `lib/flags.ts` : `useFlags(): { catalog: FlagCatalog | null; error?: string }` — `GET /api/flags` une fois, `catalogFrom`.
- `lib/profiles.ts` : `useProfiles` (liste + `reload()`), wrappers API Task 3.
- `ArgsEditor({ value: string[]; onChange(args: string[]): void })` : `textarea` mono en syntaxe shell (`shellQuote` à l'affichage, `shellSplit` à la saisie ; erreur de `shellSplit` affichée sous le champ) ; autocomplétion : quand le mot sous le curseur commence par `-`, liste `complete(catalog, mot).candidates` (8 max, ↑/↓/Tab/Entrée) ; aide inline `describeFlag` du flag sous le curseur ; avertissements ambre pour `unknownFlags` (« inconnu de ce llama-server »), erreur rouge pour un flag réservé (`reservedFlagMessage`).
- `EnvEditor` : une ligne `CLÉ=valeur` par variable.
- `ProfileForm` : nom, modèle (chemin texte ; le sélecteur arrive en J4), mmproj, cwd, host/port (placeholder = valeurs des réglages), args, env ; erreurs zod affichées sous chaque champ (`issues[].path`) ; boutons **Enregistrer**, **Dupliquer**, **Exporter**, **Supprimer** (confirmation), **Démarrer ce profil**.
- `ProfilesPage` : liste à gauche (nom, modèle, badge « en cours » si c'est le profil du serveur), formulaire à droite ; **Nouveau profil** ; **Importer** (fichier `.json` → `POST /api/profiles/import` → toast « n importés, m ignorés » + détail des ignorés) ; **Tout exporter**.
- `ImportBanner` : visible si `profileCount === 0 && exists && !dismissed` : « 2 profils trouvés dans ~/.config/llama-tui/config.json » + **Importer** / **Ignorer** (`PATCH /api/settings { llamaTuiImportDismissed: true }`).
- [ ] **Step 1 : Implémenter** ; `router.tsx` : `/profiles` → `ProfilesPage`.
- [ ] **Step 2 : Vérifier à la main** — base vide → bannière → Importer → 2 profils ; taper `--ctx` → suggestions ; `--port 1` → erreur réservée, Enregistrer refusé ; `--n-gpu-layrs` → avertissement ; dupliquer, exporter, réimporter le fichier exporté → « 0 importé, 1 ignoré (existe déjà) ».
- [ ] **Step 3 : Commit** — `J2: page Profils (formulaire, autocomplétion des flags, import/export)`.

---

### Task 7 : Web — page Logs, puis vérification J2 sur le vrai modèle

**Files:**
- Create : `web/src/features/logs/LogsPage.tsx`, `web/src/features/logs/LogRow.tsx`
- Modify : `web/src/app/router.tsx`, `web/package.json` (`@tanstack/react-virtual`)

**Interfaces:**
- `LogsPage` : liste virtualisée (`useVirtualizer`, hauteur de ligne fixe, mono `text-xs`) sur `filterLogs(useLogs().lines, { minLevel, query })` ; barre d'outils : niveau minimal (Debug / Info / Avert. / Erreur), recherche (surligne la correspondance), bascule **Suivi auto** (désactivée dès que l'utilisateur remonte, réactivée en revenant en bas), **Copier** (lignes filtrées), **Vider l'affichage** (côté client seulement) ; compteur « n lignes ».
- `LogRow` : couleur par niveau (erreur rose, avert. ambre, debug atténué), étiquette `srv`/`slot` discrète, lignes `[llama-webui]` en violet.
- [ ] **Step 1 : Implémenter** ; `router.tsx` : `/logs` → `LogsPage`.
- [ ] **Step 2 : Vérification J2 (spec)** — `PATCH /api/settings` remis sur le vrai binaire (`llama-server`, présent dans le PATH : `/home/tristan/BUILD/llama.cpp/build/bin/llama-server`) ; importer les 2 profils llama-tui ; démarrer `qwen3.8-27b-mtp` depuis l'UI → **Prêt**, infos `/props` affichées, logs qui défilent ; **Basculer** vers le profil optimisé → Prêt ; **Arrêter** → Arrêté ; Ctrl-C sur Bun pendant `ready` → `pgrep llama-server` vide.
- [ ] **Step 3 : Vérifier** — `bun run check` vert, `bun test` vert.
- [ ] **Step 4 : Commit** — `J2: page Logs et vérification du jalon`.

---

## Self-review (fait)

- Couverture spec J2 : copie supervisor/args/health/discovery/flags (T2), états + pdeathsig + SIGTERM/SIGKILL 5 s + externe `/proc` (T2, T4), API profils + import/export (T3), API serveur + props + flags (T4), ring 10 000 + WS + `GET /api/logs?since=` (T2, T4), pages Serveur/Profils/Logs (T5-T7), vérif Qwen3.8-27B + import des 2 profils (T7), tests args/validation/flags avec la fixture `--help` (T1, T2). Import au premier lancement (spec « Modèle de données ») : T3 + bannière T6.
- Types : `ServerState` avec `profileId` (T1) utilisé par `Supervisor` (T2) et le web (T5) ; `BuiltCommand.profileId` (T2) alimente l'état ; `Profile`/`ProfileInput` identiques de T1 à T6 ; `LogLine` partagé (T1) produit par `LogBuffer` (T2) et consommé par `useLogs` (T5/T7).
- Review Focus : 1-4 vérifiés à la main en T4 (fichier propriétaire `runtime.ts`), 5 testé en T1.
