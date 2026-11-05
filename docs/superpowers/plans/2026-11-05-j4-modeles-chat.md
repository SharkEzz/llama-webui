# J4 — Modèles et chat : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un navigateur des GGUF de `models_dir` (métadonnées, sélecteur réutilisable dans Profils) et un chat persistant en streaming (Markdown + code, réflexion repliable, sampling par conversation, stats par réponse) qui continue côté serveur quand l'onglet se ferme.

**Architecture:** Modèles : lecture d'en-tête **copiée** de `../llama-tui/src/model/{gguf,sizes}.ts` (`@huggingface/gguf`), scan récursif groupant les shards, résumé mis en cache en sqlite par (chemin, mtime et taille de chaque partie). Chat : conversations et messages en sqlite ; un `ChatRuns` côté serveur ouvre `/v1/chat/completions` en stream vers llama-server, accumule réflexion + réponse, enregistre au fil de l'eau et à la fin (stats tirées de `timings`), et diffuse les événements en SSE à zéro, un ou plusieurs clients ; fermer l'onglet ne coupe pas la génération, rouvrir la conversation se rebranche sur le flux.

**Tech Stack:** existant J3 + `@huggingface/gguf` (server), `react-markdown`, `remark-gfm`, `shiki` (web), composants shadcn `popover collapsible` (Base UI).

**Spec:** `docs/superpowers/specs/2026-11-05-llama-webui-design.md` (sections Architecture/Transport, Modèle de données, J4). Plans précédents : `2026-11-05-j{1,2,3}-*.md`.

## Global Constraints

- **Tailwind/shadcn correctement** (consigne utilisateur) : classes sémantiques et tokens projet seulement, aucune couleur en dur dans `web/src` hors `index.css`, pas de `dark:` quand un token suffit ; primitives shadcn plutôt qu'éléments bruts ; API vérifiée avec `bunx shadcn@latest docs <composant>` (Base UI : `render`, `nativeButton`).
- Choix utilisateur (2026-11-05) : réflexion (`reasoning_content`) **affichée repliée et enregistrée**, avec un interrupteur **Réflexion** par conversation (`chat_template_kwargs.enable_thinking`) ; recharger ou fermer l'onglet **ne coupe pas** la génération (enregistrée côté serveur, rebranchement au retour) ; **pas** d'extras au-delà de la spec (ni édition de message, ni LaTeX, ni recherche, ni export).
- Un sampling absent = défaut du serveur (celui du profil) : seules les clés renseignées partent dans la requête, jamais `null`.
- Routes chat sous `/api/chat` ; réponses de génération en **SSE** (`text/event-stream`). Bun coupe une connexion inactive après 10 s : chaque réponse SSE appelle `server.timeout(req, 0)` et envoie un commentaire `: ping` toutes les 15 s.
- Toutes les nouvelles routes passent par `guarded()` (hôte, origine, JSON). Pas d'images dans le chat (v2).
- Migrations : **une instruction SQL par entrée** de `MIGRATIONS` (ne jamais modifier les entrées 1–2).
- `ChatRuns` n'est **pas** dans le runtime : un rechargement `bun --hot` du serveur arrête les générations en cours (marquées « interrompue ») ; au démarrage, tout message resté `streaming` passe `stopped`.
- Tests minimaux : copie des tests GGUF de llama-tui, scan, parseur SSE, stats/titre, requête construite, `ChatRuns` (fetch injecté). Le reste se vérifie à la main dans Chrome, **dans les deux thèmes**.
- UI en français. Vérifier depuis le Chrome distant : `LLAMA_WEBUI_HOST=0.0.0.0`, http://192.168.0.20:7860 ; un nouveau fichier `web/src/**` peut demander de relancer `bun run dev`. Données de test dans `LLAMA_WEBUI_DATA_DIR=/tmp/lw-j4`, jamais la vraie base.
- Commits en français, un par tâche, suffixe `Co-Authored-By:` du modèle qui exécute.

## Review Focus

1. **Onglet rechargé, fermé ou ouvert deux fois pendant une génération** : la réponse continue et finit enregistrée ; à la réouverture, le fil montre le texte déjà écrit puis la suite, sans doublon ni saut ; deux onglets sur la même conversation reçoivent le même flux. Test `ChatRuns` « late subscriber » (Task 4) + vérif Task 6.
2. **llama-server arrêté, planté ou basculé pendant une génération, ou Bun redémarré** : le message passe « erreur » ou « interrompue » avec le texte partiel, jamais bloqué en `streaming` ; le composer redevient utilisable. Vérif Task 6 (Arrêter depuis la page Serveur en pleine réponse ; Ctrl-C de Bun puis relance).
3. **GGUF problématiques dans `models_dir`** : shard manquant, fichier non-GGUF renommé `.gguf`, fichier illisible (droits), dossiers cachés (`.cache/huggingface` contient des `.gguf.lock`/`.incomplete`) : le scan continue, l'entrée apparaît « illisible » avec la raison, les dossiers cachés sont ignorés. Test `scanModels` (Task 1) + vérif Task 2 (`chmod 000` sur une copie).
4. **Contenu de réponse hostile ou volumineux** : HTML brut affiché comme texte (pas de `rehype-raw`), liens ouverts dans un nouvel onglet (`rel="noreferrer"`), bloc de code non fermé pendant le streaming rendu sans casser la page, réponse de plusieurs milliers de lignes sans gel (rendu regroupé par image). Vérif Task 5 avec le faux serveur.
5. **Sampling** : champ vidé = défaut du serveur (clé absente), valeur hors bornes refusée sous le champ, température modifiée visible dans `/slots` pendant la génération suivante ; Réflexion coupée = aucun bloc « Réflexion ». Test `buildChatRequest` (Task 4) + vérif Task 6.

---

### Task 1 : Lecture GGUF et scan des modèles (serveur)

**Files:**
- Create (copies adaptées de `../llama-tui`) : `server/models/gguf.ts`, `server/models/sizes.ts`, `server/models/gguf.test.ts` (de `test/gguf.test.ts`), `server/models/gguf.fixture.ts` (de `test/helpers/gguf.ts`)
- Create : `shared/src/models.ts`, `server/models/scan.ts`, `server/models/scan.test.ts`, `server/db/modelCache.ts`, `server/routes/models.ts`, `shared/src/models.test.ts`
- Modify : `server/package.json` (`@huggingface/gguf` à la version de llama-tui), `server/db/migrations.ts`, `server/app.ts`, `shared/src/index.ts`

**Interfaces:**
- `gguf.ts` copié tel quel (cache LRU en mémoire compris) ; `ModelInfo` gagne `kind: "model" | "mmproj"` (`mmproj` si `general.type === "mmproj"` ou `general.architecture === "clip"`) et `hasChatTemplate: boolean` (`tokenizer.chat_template` est une chaîne).
- `shared/models.ts` :
  - `type ModelKind = "model" | "mmproj"`.
  - `ModelSummary { path; relPath; files: string[]; fileBytes; kind: ModelKind; arch; name; quant; params; blockCount; contextLength; embeddingLength; headCount; headCountKv /* max des couches */; expertCount; expertUsedCount; nextnLayers; recurrent; slidingWindow: number | null; hasChatTemplate }` (`path` absolu = premier shard, `relPath` relatif à `models_dir`).
  - `ModelEntry = ({ ok: true } & ModelSummary) | { ok: false; path; relPath; files; fileBytes; error: string }`.
  - `ModelList { dir /* models_dir développé */; setting /* models_dir tel que saisi, `~` compris */; home; scannedAt; models: ModelEntry[] }`.
  - `ModelDetail = ModelSummary & { tensorCount; weights: { embedBytes; outputBytes; layersBytes; expertsBytes; otherBytes; totalBytes } }` (depuis `weightSizes`).
  - `profileModelPath(abs: string, o: { cwd?: string; modelsDir: string; home: string }): { cwd?: string; model: string }` : `cwd` vide → `cwd = modelsDir` (tel quel, `~` compris) et chemin relatif à `modelsDir` développé ; `abs` sous le `cwd` développé → relatif ; sinon absolu.
- Migration 3 : `CREATE TABLE model_cache(path TEXT PRIMARY KEY, stamp TEXT NOT NULL, summary_json TEXT NOT NULL, read_at INTEGER NOT NULL)`.
- `ModelCacheRepo { get(path): { stamp; summary: ModelSummary } | null; put(path, stamp, summary); prune(keep: Set<string>) }`. Les erreurs ne sont pas mises en cache.
- `scan.ts` :
  - `groupGgufFiles(relPaths: string[]): { main: string; files: string[]; missing: string[] }[]` (pur ; `-0000k-of-0000N.gguf` regroupés sous le premier shard, triés par `main`).
  - `scanModels(dir: string, o: { cache: ModelCacheRepo; read?: (path: string) => Promise<ModelInfo>; now?: () => number }): Promise<ModelEntry[]>` : parcours récursif, noms commençant par `.` ignorés, liens de dossiers non suivis, seulement `*.gguf` ; stamp = `mtimeMs:size` de chaque partie ; shard manquant → `ok: false, error: "shard manquant : <nom>"` ; lecture en échec → `ok: false` avec le message de `ModelReadError` ; cache élagué des chemins absents.
- Routes : `GET /api/models` → `ModelList` (scan à chaque appel ; le cache évite les relectures) ; `GET /api/models/info?path=` → `ModelDetail` (400 si pas `.gguf`, 404 si absent, 422 si illisible).

- [ ] **Step 1 : Copier** `gguf.ts`, `sizes.ts`, le test et son écrivain de fixtures ; ajouter la dépendance (`bun install`).
- [ ] **Step 2 : Tests qui échouent** — `server/models/gguf.test.ts` copié (attendus inchangés) + un cas « mmproj : `general.type` = mmproj → `kind: "mmproj"` » ; `scan.test.ts` :
  ```ts
  test("groupGgufFiles groups shards under the first and reports missing ones", () => {
    expect(groupGgufFiles(["a/Big-00002-of-00003.gguf", "small.gguf", "a/Big-00001-of-00003.gguf"])).toEqual([
      { main: "a/Big-00001-of-00003.gguf", files: ["a/Big-00001-of-00003.gguf", "a/Big-00002-of-00003.gguf"], missing: ["a/Big-00003-of-00003.gguf"] },
      { main: "small.gguf", files: ["small.gguf"], missing: [] },
    ]);
  });
  test("scanModels skips hidden dirs, classifies mmproj, reports unreadable files and reuses the cache", async () => {
    // dossier temporaire : model.gguf (llama), mm.gguf (clip, general.type mmproj), .cache/x.gguf, bad.gguf ("pas un gguf")
    // read = readModel compté ; base openDb(":memory:")
    // 1er scan : 3 lectures ; entrées triées [bad (ok:false), mm (kind mmproj), model (kind model)] ; .cache absent
    // 2e scan : 1 lecture (bad seulement, les erreurs ne sont pas en cache)
  });
  ```
  `shared/src/models.test.ts` : `profileModelPath("/h/Modèles/q/a.gguf", { modelsDir: "~/Modèles", home: "/h" })` → `{ cwd: "~/Modèles", model: "q/a.gguf" }` ; avec `cwd: "~/Modèles/q"` → `{ cwd: "~/Modèles/q", model: "a.gguf" }` ; avec `cwd: "/autre"` → `{ cwd: "/autre", model: "/h/Modèles/q/a.gguf" }`.
  Run : `bun test server/models shared/src/models.test.ts` — Expected : FAIL (modules absents ; les tests GGUF copiés passent dès la copie, sauf le cas mmproj).
- [ ] **Step 3 : Implémenter** `shared/models.ts`, la migration, `ModelCacheRepo`, `scan.ts`, les routes.
- [ ] **Step 4 : Vérifier** — `bun test` et `bun run check` verts ; `curl -s localhost:7860/api/models` sur la vraie `~/Modèles` (lecture seule) liste Qwen3.8-27B (`qwen35`, `IQ3_S`, ctx 262 144, `hasChatTemplate: true`) et le mmproj (`kind: "mmproj"`) ; 2e appel en < 50 ms ; `/api/models/info?path=…` donne `weights.totalBytes` proche de la taille du fichier.
- [ ] **Step 5 : Commit** — `J4: lecture GGUF et scan des modèles`.

---

### Task 2 : Page Modèles et sélecteur de modèle

**Files:**
- Create : `web/src/lib/models.ts`, `web/src/features/models/{ModelsPage,ModelDetailDialog,ModelPicker}.tsx`
- Modify : `web/src/app/{router.tsx,routes.ts}`, `web/src/lib/format.ts`, `web/src/features/profiles/{ProfileForm,ProfilesPage}.tsx`
- shadcn : `popover` (`bunx shadcn@latest docs popover` d'abord)

**Interfaces:**
- `lib/models.ts` : store zustand `useModels { list: ModelList | null; error: string | null; loading: boolean; refresh(): Promise<void> }`, chargé au premier usage.
- `format.ts` : `formatParams(n)` → `27.3e9` = « 27,3 B », `600e6` = « 600 M », `0` = « — ».
- `ModelsPage` : titre + dossier scanné + bouton « Rescanner » ; filtre texte (fichier, nom, archi, quant) et `Tabs` « Modèles · Projecteurs · Tous » ; `Table` : Fichier (`relPath`, `name` en dessous en `text-muted-foreground`), Archi, Quant (`Badge`), Taille, Paramètres, Couches, Contexte, Experts (« 128 / 8 » ou « — ») ; entrée illisible = ligne avec `Badge variant="destructive"` « illisible » et la raison ; aucun GGUF → `Alert` « Aucun fichier GGUF dans <dir> » avec lien vers Réglages ; chargement en `Skeleton`. Clic sur une ligne lisible → `ModelDetailDialog`.
- `ModelDetailDialog` : `GET /api/models/info` ; faits (archi, quant, paramètres, couches, contexte, têtes, têtes KV, experts, couches MTP `nextnLayers`, récurrent, fenêtre glissante), répartition des poids (embeddings, couches, experts, sortie, autres), fichiers ; boutons « Créer un profil » (`/profiles?new=1&model=<path>`) et « Copier le chemin ».
- `ModelPicker({ kind: ModelKind; onSelect(path: string): void })` : `Popover` + `Command` filtrable (relPath, quant, taille) ; déclencheur `Button variant="outline" size="icon"` (icône dossier) ; rafraîchit `useModels` à l'ouverture.
- `ProfileForm` : champs Modèle et Projecteur en `InputGroup` (saisie libre conservée) + `ModelPicker` ; la sélection applique `profileModelPath(path, { cwd, modelsDir: list.setting, home: list.home })` (remplit `cwd` s'il est vide). `ProfilesPage` : `?new=1&model=` ouvre le formulaire de création prérempli (nom = nom du fichier sans `.gguf`, projecteur prérempli si le dossier du modèle contient exactement un mmproj).
- `routes.ts` : `/models` retiré de `MILESTONE_BY_PATH`.

- [ ] **Step 1 : Implémenter** store, page, dialogue, sélecteur, intégration Profils.
- [ ] **Step 2 : Vérifier** — Chrome, **les deux thèmes** : la page liste les 2 fichiers réels ; filtre et onglets ; dialogue de détail ; « Créer un profil » prérempli (cwd `~/Modèles`, modèle et mmproj relatifs) puis enregistré dans `/tmp/lw-j4` ; sélecteur dans un profil existant ; Review Focus 3 avec `LLAMA_WEBUI_DATA_DIR=/tmp/lw-j4` et `modelsDir` pointé sur `/tmp/lw-models` (copie d'un faux GGUF, `bad.gguf`, un shard `-00001-of-00002` seul, un fichier en `chmod 000`, un `.cache/x.gguf`) ; `bun run check` vert.
- [ ] **Step 3 : Commit** — `J4: page Modèles et sélecteur de modèle`.

---

### Task 3 : Conversations — données, SSE, API

**Files:**
- Create : `shared/src/chat.ts`, `shared/src/chat.test.ts`, `shared/src/sse.ts`, `shared/src/sse.test.ts`, `server/db/conversations.ts`, `server/routes/chat.ts`
- Modify : `server/db/migrations.ts`, `server/app.ts`, `server/index.ts`, `shared/src/index.ts`

**Interfaces:**
- `shared/chat.ts` :
  - `SamplingSchema = z.strictObject({ temperature: 0–5, top_p: 0–1, top_k: entier 0–1000, min_p: 0–1, presence_penalty: −2–2, repeat_penalty: 0–5, max_tokens: entier 1–1 000 000, seed: entier })`, toutes optionnelles, messages d'erreur en français ; `type Sampling`.
  - `ConversationPatchSchema = z.strictObject({ title?: string 1–200 (trim), systemPrompt?: string ≤ 100 000, sampling?: Sampling, thinking?: boolean })` ; `type ConversationPatch`.
  - `MessageStatus = "streaming" | "done" | "stopped" | "error"` ; `MessageStats { ttftMs: number | null; promptTokens; cachedTokens; genTokens; ppTps; tgTps; draftN: number | null; draftAccepted: number | null; durationMs }`.
  - `ChatMessage { id; conversationId; role: "user" | "assistant"; content; reasoning; status; error: string | null; stats: MessageStats | null; model: string | null; createdAt }`.
  - `Conversation { id; title; profileId: number | null; modelPath: string | null; systemPrompt; sampling; thinking; createdAt; updatedAt }` ; `ConversationSummary { id; title; updatedAt; messageCount; modelPath; live: boolean }` ; `ConversationDetail = Conversation & { messages: ChatMessage[]; live: boolean }`.
  - `ChatEvent = { type: "start"; user: ChatMessage | null; assistant: ChatMessage } | { type: "delta"; content?: string; reasoning?: string } | { type: "done"; message: ChatMessage }`.
  - `statsFromTimings(t: LlamaTimings, ttftMs: number | null, durationMs: number): MessageStats` (`LlamaTimings` = `prompt_n prompt_per_second predicted_n predicted_per_second cache_n? draft_n? draft_n_accepted?` de llama-server) ; `autoTitle(text): string` (6 premiers mots, espaces normalisés, ≤ 48 caractères puis « … », vide → « Nouvelle conversation »).
- `shared/sse.ts` : `class SseParser { push(chunk: string): SseEvent[] }` avec `SseEvent { event: string /* "message" par défaut */; data: string }` ; `formatSse(event: string, data: unknown): string`.
- Migrations 4–6 (une instruction chacune) :
  - `conversations(id INTEGER PRIMARY KEY, title TEXT NOT NULL, profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL, model_path TEXT, sampling_json TEXT NOT NULL, system_prompt TEXT NOT NULL, thinking INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`
  - `messages(id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, reasoning TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error TEXT, stats_json TEXT, model_path TEXT, created_at INTEGER NOT NULL)`
  - `CREATE INDEX messages_by_conversation ON messages(conversation_id, id)`
- `ConversationsRepo` : `list(): Omit<ConversationSummary, "live">[]` (par `updated_at` décroissant) ; `get(id): (Conversation & { messages }) | null` ; `create({ profileId, modelPath }): Conversation` (titre « Nouvelle conversation », sampling `{}`, thinking `true`) ; `patch(id, ConversationPatch): Conversation` ; `delete(id)` ; `addMessage(…): ChatMessage` ; `updateMessage(id, { content?, reasoning?, status?, error?, stats? })` ; `deleteFrom(conversationId, messageId)` (ce message et les suivants) ; `stopOrphans(): number` (`streaming` → `stopped`) ; chaque écriture de message met à jour `updated_at`.
- Routes : `GET /api/chat` (liste), `POST /api/chat { profileId? }` (défaut : profil du serveur actif, `modelPath` via `profilePaths`), `GET|PATCH|DELETE /api/chat/:id`. `live` vaut `false` jusqu'à Task 4. `index.ts` appelle `stopOrphans()` au démarrage.

- [ ] **Step 1 : Tests qui échouent** — `sse.test.ts` : un événement coupé au milieu d'une ligne sur deux `push` ; fin de ligne `\r\n` ; deux lignes `data:` jointes par `\n` ; commentaire `: ping` ignoré ; `event: done` nommé ; `data: [DONE]` rendu tel quel. `chat.test.ts` : `statsFromTimings({ prompt_n: 183, prompt_per_second: 183.21, predicted_n: 412, predicted_per_second: 51.23, cache_n: 12, draft_n: 40, draft_n_accepted: 20 }, 1234, 9000)` → `{ ttftMs: 1234, promptTokens: 183, cachedTokens: 12, genTokens: 412, ppTps: 183.21, tgTps: 51.23, draftN: 40, draftAccepted: 20, durationMs: 9000 }` ; sans `draft_n` → `draftN: null` ; `autoTitle("  Explique-moi   les shards GGUF de llama.cpp en détail stp ")` → « Explique-moi les shards GGUF de llama.cpp en… » coupé à 48 ; `autoTitle("")` → « Nouvelle conversation ». Run : `bun test shared` — Expected : FAIL (modules absents).
- [ ] **Step 2 : Implémenter** `shared/chat.ts`, `shared/sse.ts`, migrations, repo, routes.
- [ ] **Step 3 : Vérifier** — `bun test` et `bun run check` verts ; `curl` : créer, renommer (`PATCH title`), sampling invalide (`temperature: 9`) → 400 avec le message sous `issues`, supprimer.
- [ ] **Step 4 : Commit** — `J4: conversations, parseur SSE et API`.

---

### Task 4 : Génération — relais en streaming, arrêt, régénération, rebranchement

**Files:**
- Create : `server/chat/request.ts`, `server/chat/request.test.ts`, `server/chat/runs.ts`, `server/chat/runs.test.ts`
- Modify : `server/routes/chat.ts`, `server/app.ts`, `server/index.ts`, `testdata/fake/fake-llama-server.ts`

**Interfaces:**
- `buildChatRequest(conv: Conversation, history: ChatMessage[]): Record<string, unknown>` : `messages` = système (si non vide) + historique (statuts `done`/`stopped`, contenu non vide ; `role` et `content` seulement, réflexion exclue) ; `stream: true` ; clés de `sampling` présentes seulement ; `chat_template_kwargs: { enable_thinking: conv.thinking }`.
- `ChatRuns` :
  ```ts
  interface ChatTarget { port: number; profileId: number | null; modelPath: string | null }
  interface ChatRunsDeps { repo: ConversationsRepo; target(): ChatTarget | null /* null si non prêt */; fetch?: typeof fetch; now?: () => number; flushMs?: number /* 1000 */ }
  interface ChatRun { subscribe(listener: (e: ChatEvent) => void): () => void; done: Promise<void> }
  class ChatRuns {
    send(conversationId: number, content: string): ChatRun   // 409 si une génération tourne déjà, 409 « llama-server n'est pas prêt »
    regenerate(conversationId: number): ChatRun              // supprime la dernière réponse (deleteFrom), relance sur l'historique restant
    stop(conversationId: number): boolean
    live(conversationId: number): ChatRun | undefined
    liveIds(): number[]
    dispose(): void                                           // abort de tout, messages → stopped
  }
  ```
  `send` : enregistre le message utilisateur (titre auto si c'est le premier), crée la réponse `streaming` (`model` = cible), POST `http://127.0.0.1:<port>/v1/chat/completions`, lit le flux avec `SseParser` (`choices[0].delta.content` / `.reasoning_content`, `timings` du dernier morceau, `[DONE]`), mesure le TTFT au premier delta, écrit en base toutes les `flushMs` et à la fin (`done` + stats ; abort → `stopped` ; HTTP non 2xx → `error` avec le message de llama-server ; coupure réseau → `error`, texte partiel gardé). `subscribe` rejoue `start` puis un `delta` cumulé, puis le direct ; se désabonner ne coupe **jamais** la génération.
- Routes : `POST /api/chat/:id/messages { content }` et `POST /api/chat/:id/regenerate` → SSE des `ChatEvent` (`event: <type>`) ; `POST /api/chat/:id/stop` → 204, 409 si rien ne tourne ; `GET /api/chat/:id/stream` → SSE si une génération tourne, sinon 204 ; `live` renseigné dans la liste et le détail ; `DELETE` arrête d'abord la génération. `index.ts` crée `ChatRuns` (cible = état `ready`/`external` du superviseur) et l'arrête dans le dispose.
- Faux serveur : `POST /v1/chat/completions` en stream — 5 deltas `reasoning_content` puis une réponse Markdown (titre, liste, tableau, bloc `ts`, `<b>html</b>`, lien), un delta toutes les `FAKE_CHAT_DELAY_MS` (défaut 60 ms), dernier morceau avec `timings` ; respecte l'abort ; `enable_thinking: false` → pas de réflexion.

- [ ] **Step 1 : Tests qui échouent** — `request.test.ts` : « empty sampling sends no sampling key, reasoning and failed messages stay out » (conversation `sampling: { temperature: 0.2 }`, `thinking: false`, historique user/assistant done avec `reasoning`, assistant `error`) → `messages` = système + 2 messages sans `reasoning`, `temperature: 0.2` seule clé de sampling, pas de `top_p`, `chat_template_kwargs.enable_thinking === false`. `runs.test.ts` (base `:memory:`, `fetch` injecté renvoyant un `ReadableStream` piloté par le test, `flushMs: 0`) :
  - « a run keeps going and is saved when its listener leaves » : se désabonner après le 1er delta, envoyer la suite + `timings` + `[DONE]` → message `done`, `content` et `reasoning` complets, `stats.tgTps` = valeur des timings.
  - « stop saves the partial answer as stopped » : 1 delta, `stop()` → statut `stopped`, contenu partiel, signal du fetch `aborted`.
  - « a late subscriber gets what was already written » : s'abonner après 2 deltas → `start`, puis un `delta` égal au cumul, puis les suivants.
  Run : `bun test server/chat` — Expected : FAIL (modules absents).
- [ ] **Step 2 : Implémenter** `request.ts`, `runs.ts`, routes, câblage, faux serveur.
- [ ] **Step 3 : Vérifier** — `bun test` et `bun run check` verts ; avec le faux serveur prêt : `curl -N -X POST …/messages` montre `start`, des `delta`, `done` ; un `curl` coupé (Ctrl-C) au milieu → `GET /api/chat/:id` finit `done` ; `GET …/stream` pendant une génération rejoue le cumul ; `stop` → `stopped`.
- [ ] **Step 4 : Commit** — `J4: génération en streaming, arrêt, régénération et rebranchement`.

---

### Task 5 : Page Chat

**Files:**
- Create : `web/src/lib/chat.ts`, `web/src/lib/highlight.ts`, `web/src/features/chat/{ChatPage,ConversationList,Thread,Message,Markdown,CodeBlock,Reasoning,MessageStats,Composer,SamplingPanel}.tsx`
- Modify : `web/package.json` (`react-markdown`, `remark-gfm`, `shiki`), `web/src/app/{router.tsx,routes.ts}`, `web/src/index.css`
- shadcn : `collapsible` (`bunx shadcn@latest docs collapsible` d'abord)

**Interfaces:**
- `lib/chat.ts` : store zustand `useChat { list; current: ConversationDetail | null; streaming: { conversationId; assistantId; content; reasoning } | null; load(); open(id); create(); patch(p: ConversationPatch); remove(id); send(text); regenerate(); stop() }` ; `readSse(res: Response, onEvent: (e: ChatEvent) => void)` sur `SseParser` ; `open(id)` appelle `GET /api/chat/:id/stream` si `live` ; mises à jour du texte regroupées par `requestAnimationFrame`.
- `lib/highlight.ts` : `highlight(code, lang): Promise<string>` — `createHighlighterCore` + moteur JS (pas de wasm), thèmes `github-light`/`github-dark` en double (`defaultColor: false`), langues `ts tsx js jsx json bash sh python rust go c cpp html css sql yaml toml markdown diff` (inconnue → texte) ; `index.css` : `.shiki span { color: var(--shiki-light) }` et `.dark .shiki span { color: var(--shiki-dark) }`, fond = `bg-well`.
- Routes `chat` et `chat/:id` ; `/chat` retiré de `MILESTONE_BY_PATH`.
- `ChatPage` : 3 colonnes — `ConversationList` (bouton « Nouvelle conversation », éléments `Button variant="ghost"`, point animé si `live`, `DropdownMenu` Renommer / Supprimer avec `ConfirmDialog`) ; fil + composer ; `SamplingPanel` repliable. En-tête : titre, modèle de la conversation, `ServerStateBadge` ; si le serveur sert un autre modèle que celui de la conversation, une ligne `text-muted-foreground` le dit.
- `Message` : utilisateur en bulle `bg-muted` ; assistant en `Markdown`, `Reasoning` (`Collapsible` replié « Réflexion », ouvert pendant qu'elle s'écrit), `MessageStats` (« 1,2 s avant le 1er jeton · 183 t/s prompt · 51,2 t/s · 412 jetons · MTP 50 % »), badge « interrompue » / « erreur » + message ; actions Copier, Régénérer (dernière réponse).
- `Markdown` : `react-markdown` + `remark-gfm`, sans HTML brut ; `a` → `target="_blank" rel="noreferrer"` ; `table` → `Table` shadcn ; `code` en bloc → `CodeBlock` (langue, Copier, texte brut tant que la coloration n'est pas prête).
- `Composer` : `Textarea` qui grandit, Entrée envoie, Maj+Entrée saute une ligne, bouton Arrêter pendant la génération ; serveur non prêt → désactivé + `Alert` avec lien vers Serveur.
- `SamplingPanel` : prompt système (`Textarea`), `Switch` « Réflexion », champs température, top-p, top-k, min-p, pénalité de présence, pénalité de répétition, jetons max, graine ; placeholder = défaut du serveur (`GET /api/server/props` → `default_generation_settings.params`) ; vider un champ = défaut ; enregistrement au blur (`PATCH`), erreur zod sous le champ.

- [ ] **Step 1 : Dépendances et composants shadcn**, puis implémenter store, coloration, composants, routes.
- [ ] **Step 2 : Vérifier** — Chrome, **les deux thèmes**, faux serveur (`FAKE_CHAT_DELAY_MS=200`) : réflexion repliée puis réponse ; titre auto ; Markdown, tableau, code coloré et copiable, `<b>html</b>` affiché en texte ; Arrêter ; Régénérer ; recharger pendant la réponse → reprise sans doublon ; deux onglets ; Réflexion coupée ; sampling invalide ; serveur arrêté → composer désactivé ; réponse longue (`FAKE_CHAT_DELAY_MS=1`, ~5 000 lignes) sans gel ; `bun run check` vert.
- [ ] **Step 3 : Commit** — `J4: page Chat`.

---

### Task 6 : Vérification du jalon avec le vrai modèle

**Files:** aucun nouveau (corrections éventuelles dans les fichiers des tâches 1–5).

- [ ] **Step 1 : Conversation réelle** — base `/tmp/lw-j4`, profil Qwen3.8-27B créé depuis la page Modèles, serveur PRÊT : conversation de 3 échanges en streaming ; stats sous chaque réponse cohérentes avec le Dashboard (t/s gen et prompt, MTP) ; recharger la page → tout relu.
- [ ] **Step 2 : Sampling** — température 0,2 dans le panneau ; pendant la réponse suivante, `curl -s 127.0.0.1:8080/slots` montre `params.temperature` ≈ 0,2 ; champ vidé → la valeur du profil (1,0) revient ; Réflexion coupée → pas de bloc « Réflexion ».
- [ ] **Step 3 : Review Focus 1–2** — fermer l'onglet en pleine réponse, rouvrir : réponse finie ou en cours, sans doublon ; Arrêter le serveur depuis la page Serveur en pleine réponse → « erreur » avec le texte partiel, composer désactivé ; Ctrl-C de Bun en pleine réponse puis relance → « interrompue ».
- [ ] **Step 4 : Suite complète** — `bun test` et `bun run check` verts ; chaque page touchée relue dans les deux thèmes ; serveur arrêté et Bun coupé à la fin.
- [ ] **Step 5 : Commit** — `J4: vérification du jalon` (seulement s'il y a des corrections).
