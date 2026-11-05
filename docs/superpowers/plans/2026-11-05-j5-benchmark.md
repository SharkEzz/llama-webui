# J5 — Benchmark : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une page Benchmark qui mesure un modèle avec **llama-bench** ou un vrai **llama-server** (flags saisis ou repris d'un profil), suit le run en direct, garde un historique filtrable en sqlite (matériel figé), compare des runs côte à côte et crée un profil depuis un run.

**Architecture:** Les flags vivent sous une forme structurée (`BenchParams`) traduite vers chaque outil : `-dev A/B` et `-ot a;b` pour llama-bench, `-dev A,B` et `-ot a,b` pour llama-server. Un profil se décompose en `BenchParams` et en « autres flags serveur ». Un `BenchRunner` côté serveur exécute un run à la fois, en dehors du superviseur, en deux étapes :
- avant le run, il arrête le serveur géré s'il y en a un, après confirmation ;
- après le run, il le relance avec la même commande, quelle que soit l'issue.

Pendant le run, il relève la VRAM au-dessus de la base sur les collecteurs du Monitor, enregistre dans `bench_runs` et diffuse la progression en WS (`bench-progress`, `bench-run`). Le runner serveur reprend `../llama-tui/src/bench/runner.ts` : santé, échauffement, puis `r` mesures `/completion`.

**Tech Stack:** existant J4. Aucune nouvelle dépendance. shadcn `checkbox` (Base UI) seulement.

**Spec:** `docs/superpowers/specs/2026-11-05-llama-webui-design.md` (Transport, Modèle de données `bench_runs`, J5, et J6 pour l'usage futur du runner). Plans précédents : `2026-11-05-j{1,2,3,4}-*.md`.

## Global Constraints

- **Choix utilisateur (2026-11-05)**
  - Serveur géré en marche au lancement : confirmation, puis arrêt pendant le run et **relance avec la même commande à la fin**, même si le run échoue, est annulé ou interrompu.
  - Serveur externe : refus (409).
  - Formulaire : **un champ par flag de la spec**, plus -p/-n/-r et une zone « Autres flags serveur ». Traduction automatique vers chaque outil ; un profil préremplit le formulaire.
  - Ajouts à l'historique : **supprimer** des runs, **graphique pp/tg** dans la comparaison, **relancer** un run.
- **Comparabilité** (note transmise par l'utilisateur) : llama-bench ne fait pas de décodage spéculatif (MTP, modèle draft) et ne réserve pas le contexte du profil (`-c`).
  - Le type du run est toujours visible.
  - Le formulaire signale les flags ignorés par llama-bench.
  - La comparaison avertit quand elle mélange les deux types.
  - Le run serveur enregistre le taux d'acceptation des drafts.
- Un run à la fois ; pendant un run, `POST /api/server/{start,switch,restart}` répond 409 « Un benchmark est en cours ». Le runner relance lui-même le serveur via le superviseur.
- Tout enfant (llama-bench, llama-server de bench) est lancé via `setpriv --pdeathsig KILL --` : jamais d'orphelin si Bun meurt.
- `BenchRunner` n'est **pas** dans le runtime, comme `ChatRuns`.
  - Un rechargement `bun --hot` tue l'enfant, marque le run `interrupted` et relance le serveur arrêté une fois l'enfant sorti.
  - Un SIGINT/SIGTERM de Bun marque `interrupted` sans relancer.
  - Au démarrage, tout run resté `running` passe `interrupted`.
- Binaire llama-bench : le binaire serveur des réglages avec `llama-server` remplacé par `llama-bench` dans le nom de fichier, dans le même dossier (nom nu → nom nu, cherché dans le PATH).
- Migrations : une instruction SQL par entrée, à la suite de la 6 ; ne jamais modifier les entrées existantes.
- Nouvelles routes sous `/api/bench`, toutes via `guarded()`.
- **Tailwind/shadcn correctement** : tokens sémantiques seulement, aucune couleur en dur hors `index.css`, primitives shadcn sur Base UI (`render`, `nativeButton`), API vérifiée avec `bunx shadcn@latest docs <composant>`. Graphique : skill `dataviz`, tons `--tone-*`.
- Tests minimaux : traduction des flags, parseurs (JSON, progression, devices, erreurs) sur fixtures réelles, et un test du runner (relance après échec). Le reste se vérifie dans Chrome, **dans les deux thèmes**.
- UI et commits en français. Vérification depuis le Chrome distant : `LLAMA_WEBUI_HOST=0.0.0.0`, http://192.168.0.20:7860. Données de test dans `LLAMA_WEBUI_DATA_DIR=/tmp/lw-j5`, jamais la vraie base. Un nouveau fichier `web/src/**` peut demander de relancer `bun run dev`.

## Review Focus

1. **Le serveur que le bench a arrêté doit toujours revenir** : run réussi, OOM, annulation à chaque phase, rechargement `bun --hot`. Il revient avec le même profil, et un échec de relance se voit dans les logs et dans la carte « en cours ». Test runner « restarts the server it stopped even when llama-bench fails » (Task 2), puis vérif Task 5.
2. **Sorties anormales de llama-bench** : JSON tronqué (`[` seul après un OOM), code de sortie ≠ 0, processus tué. Le statut devient `failed` avec la ligne d'erreur de llama-bench (préfixe « Mémoire insuffisante » si OOM), jamais une exception de parse. Tests `parseBenchJson` / `benchFailure` sur les fixtures (Task 1) et test runner (Task 2).
3. **Flags de profil réels** :
   - formes longues, forme `--flag=valeur`, `-ot` répété ;
   - `-fa` sans valeur, `-ngl auto|all`, `-dev Vulkan3` ;
   - flags gérés par un champ ou réservés, saisis dans « Autres flags serveur » : refusés sous le champ.
   
   Tests `paramsFromServerArgs` / `BenchSpecSchema` (Task 1).
4. **Comparer des choses non comparables** : profil MTP mesuré par llama-bench → avertissement dans le formulaire ; comparaison llama-bench + serveur → avertissement ; le run serveur affiche « MTP x % ». Test `ignoredByBench` (Task 1), puis vérif Tasks 4 et 5.
5. **Annulation et processus orphelins** : annuler pendant l'arrêt du serveur, le chargement, la mesure. Ensuite, `pgrep -f "llama-bench|llama-server"` ne montre que le serveur relancé, et le statut est `cancelled`. Vérif Task 5.

---

### Task 1 : Traduction des flags et parseurs (purs)

**Files:**
- Create : `shared/src/bench.ts`, `shared/src/bench.test.ts`, `server/bench/parse.ts`, `server/bench/parse.test.ts`
- Create (fixtures réelles, capturées le 2026-11-05 sur b12119, actuellement dans `/tmp/j5fix/`) :
  - `testdata/llama-bench/ok.json` (Qwen3-0.6B, `-r 2 -p 64 -n 16`, contient `model_filename` mal encodé, à ne pas lire) ;
  - `ok-stderr.txt` ;
  - `oom-stdout.json` (`[` seul) ;
  - `oom-stderr.txt` (30B-A3B, `-ngl 99 -dev CUDA1`, code de sortie 1) ;
  - `list-devices.txt` (sortie de `llama-bench --list-devices`).
- Modify : `shared/src/index.ts`

**Interfaces:**
- `shared/bench.ts` :
  - `BenchParams` (toutes clés optionnelles ; absente = défaut de l'outil) :
    - `ngl: number | "all" | "auto"` ;
    - `ot: string[]` (`motif=buffer`) ;
    - `ncmoe: number` ;
    - `dev: string[]` ;
    - `ts: number[]` ;
    - `sm: "none" | "layer" | "row" | "tensor"` ;
    - `fa: "on" | "off" | "auto"` ;
    - `ctk`, `ctv` : `"f32"|"f16"|"bf16"|"q8_0"|"q4_0"|"q4_1"|"iq4_nl"|"q5_0"|"q5_1"` ;
    - `t`, `b`, `ub` : entiers ≥ 1.
    
    Schéma zod `BenchParamsSchema` (messages en français).
  - `BenchKind = "bench" | "server"` ; `BenchStatus = "running" | "ok" | "failed" | "cancelled" | "interrupted"`.
  - `BenchSpecSchema = z.strictObject` avec les champs suivants :
    - `kind` ;
    - `modelPath` : absolu, `.gguf` ;
    - `mmprojPath` : string | null ;
    - `profileId` : number | null ;
    - `params` ;
    - `serverArgs: string[]` ;
    - `p` : 1–32 768, défaut 512 ;
    - `n` : 1–4 096, défaut 128 ;
    - `r` : 1–20, défaut 3.
    
    Un `serverArgs` qui passe un flag réservé (`reservedFlag`) ou un flag couvert par un champ est refusé à l'index fautif (« -ngl : utilisez le champ -ngl »). `type BenchSpec`.
  - `Measure { tps: number; stddev: number; tokens: number }`.
  - `BenchHardware { cpu: string; gpus: { name; busId; vramTotalBytes }[]; build: string | null }`.
  - `BenchRun { id; kind; status; spec: BenchSpec; command: string; hardware: BenchHardware; pp: Measure | null; tg: Measure | null; draftAcceptPct: number | null; vramPeak: { key: string; name: string; mib: number }[]; error: string | null; logExcerpt: string; durationMs: number | null; createdAt: number }`.
  - `BenchPhase = "stopping-server" | "loading" | "warmup" | "prompt" | "generation" | "measure" | "restarting-server"`.
  - `BenchLive { runId; kind; phase: BenchPhase; step: { index: number; total: number } | null; startedAt; lines: string[] /* 20 dernières */ }`.
  - `BenchDevice { id: string /* "CUDA0" */; name: string; totalMib: number }`.
  - `paramsFromServerArgs(args: string[]): { params: BenchParams; rest: string[] }` :
    - reconnaît `-ngl/--gpu-layers/--n-gpu-layers`, `-ot/--override-tensor` (cumulés, valeurs séparées par `,`), `-ncmoe/--n-cpu-moe`, `-dev/--device`, `-ts/--tensor-split`, `-sm/--split-mode`, `-fa/--flash-attn`, `-ctk/--cache-type-k`, `-ctv/--cache-type-v`, `-t/--threads`, `-b/--batch-size`, `-ub/--ubatch-size` ;
    - formes `--flag=v` acceptées ;
    - `-fa` non suivi de `on|off|auto` → `"on"` ;
    - une valeur illisible laisse le flag et sa valeur dans `rest` ;
    - `rest` garde l'ordre d'origine.
  - `serverArgs(p: BenchParams): string[]` (forme courte, `,`, `-ngl auto` omis) et `benchArgs(p: BenchParams): string[]` (forme courte, `/` pour `-dev` et `-ts`, `;` pour `-ot`, `ngl "all"` → `999`, `"auto"` omis), dans l'ordre fixe des champs.
  - `ignoredByBench(rest: string[]): { flag: string; why: string }[]` : flags de `rest` qui changent vitesse ou mémoire et que llama-bench ne reproduit pas.
    - `-c/--ctx-size` → « contexte non réservé » ;
    - `--spec-type`, `-md/--model-draft`, `--draft*`, `-ngld`, `-devd` → « décodage spéculatif non mesuré » ;
    - `-cmoe/--cpu-moe` → « utilisez -ncmoe » ;
    - `-np/--parallel` → « slots parallèles ».
- `server/bench/parse.ts` :
  - `parseBenchJson(stdout: string): { pp: Measure | null; tg: Measure | null; build: string | null } | null` :
    - renvoie `null` si le JSON est invalide ou tronqué ;
    - pp = entrée `n_prompt > 0 && n_gen === 0`, tg = l'inverse ;
    - `tps` = `avg_ts`, `stddev` = `stddev_ts`, `tokens` = `n_prompt` ou `n_gen` ;
    - `build` = `"b<build_number> (<build_commit>)"` ;
    - ne lit jamais `model_filename`.
  - `parseBenchProgress(line: string): { phase: "warmup" | "prompt" | "generation"; test: number; tests: number; run: number | null; runs: number | null } | null`, sur `llama-bench: benchmark 1/2: prompt run 2/2` (`starting` → `null`).
  - `parseDeviceList(text: string): BenchDevice[]` (lignes `  ID: nom (N MiB, M MiB free)`, nom avec parenthèses compris).
  - `benchFailure(lines: string[], exit: number | string): { message: string; oom: boolean }` :
    - la dernière ligne qui correspond à l'`ERROR_LINE` de llama-tui, plus `unable to allocate` ;
    - si OOM, le message commence par « Mémoire insuffisante : » ;
    - sinon « llama-bench terminé (code N) ».
  - `benchBinary(serverBinary: string): string`.

- [ ] **Step 1 : Fixtures.** Copier les fichiers de `/tmp/j5fix/`. S'ils ont disparu, les recapturer avec les commandes ci-dessus et `2>`/`>` séparés.
- [ ] **Step 2 : Tests qui échouent.** Dans `shared/src/bench.test.ts` :
  ```ts
  test("paramsFromServerArgs splits a real profile into fields and the rest", () => {
    expect(paramsFromServerArgs(["--jinja", "-fa", "on", "-np", "1", "-c", "40000", "--spec-type", "draft-mtp", "-ngl", "all",
      "--device=CUDA0,Vulkan3", "-ot", "exps=CPU", "--override-tensor", "a=CUDA0,b=CPU", "-ts", "3,1", "--cache-type-k", "q8_0", "-fa"]))
      .toEqual({ params: { fa: "on", ngl: "all", dev: ["CUDA0", "Vulkan3"], ot: ["exps=CPU", "a=CUDA0", "b=CPU"], ts: [3, 1], ctk: "q8_0" },
                 rest: ["--jinja", "-np", "1", "-c", "40000", "--spec-type", "draft-mtp"] });
  });
  test("each tool gets its own separators", () => {
    const p = { ngl: "all", dev: ["CUDA0", "CUDA1"], ts: [3, 1], ot: ["exps=CPU", "a=CUDA0"], fa: "on" } as const;
    expect(benchArgs(p)).toEqual(["-ngl", "999", "-ot", "exps=CPU;a=CUDA0", "-dev", "CUDA0/CUDA1", "-ts", "3/1", "-fa", "on"]);
    expect(serverArgs(p)).toEqual(["-ngl", "all", "-ot", "exps=CPU,a=CUDA0", "-dev", "CUDA0,CUDA1", "-ts", "3,1", "-fa", "on"]);
    expect(paramsFromServerArgs(serverArgs(p)).params).toEqual(p);
  });
  test("ignoredByBench names context and speculative decoding", () => {
    expect(ignoredByBench(["-c", "40000", "--spec-type", "draft-mtp", "--jinja"]).map((i) => i.flag)).toEqual(["-c", "--spec-type"]);
  });
  test("BenchSpecSchema refuses managed flags in serverArgs at their index", () => {
    // serverArgs ["--jinja", "-ngl", "20", "--port", "9"] → issues aux chemins ["serverArgs", 1] et ["serverArgs", 3]
  });
  ```
  Dans `server/bench/parse.test.ts` :
  - `ok.json` → `pp.tps` ≈ 9817.38, `pp.tokens` 64, `tg.tps` ≈ 410.81, `tg.tokens` 16, `build` `"b12119 (6f1e65437)"` ;
  - `oom-stdout.json` → `null` ;
  - `benchFailure(lignes de oom-stderr.txt, 1)` → `oom: true`, message qui commence par « Mémoire insuffisante : » et contient `unable to allocate CUDA1 buffer` ou `failed to load model` ;
  - `parseBenchProgress("llama-bench: benchmark 2/2: generation run 1/2")` → `{ phase: "generation", test: 2, tests: 2, run: 1, runs: 2 }` ;
  - `parseDeviceList(list-devices.txt)` : 7 entrées, `Vulkan3` = « AMD Radeon RX 9070 XT (RADV GFX1201) », 16 304 MiB ;
  - `benchBinary("/x/bin/llama-server")` → `/x/bin/llama-bench`, `benchBinary("llama-server")` → `llama-bench`, `benchBinary("testdata/fake/fake-llama-server")` → `testdata/fake/fake-llama-bench`.
  
  Run : `bun test shared/src/bench.test.ts server/bench`. Expected : FAIL (modules absents).
- [ ] **Step 3 : Implémenter** `shared/bench.ts` et `server/bench/parse.ts`.
- [ ] **Step 4 : Vérifier** : `bun test` et `bun run check` verts.
- [ ] **Step 5 : Commit** : `J5: traduction des flags et parseurs llama-bench`.

---

### Task 2 : Runs persistés, runner llama-bench, exclusion avec le serveur, API

**Files:**
- Create : `server/db/benchRuns.ts`, `server/bench/runner.ts`, `server/bench/runner.test.ts`, `server/routes/bench.ts`, `testdata/fake/fake-llama-bench` (exécutable, sur le modèle de `fake-llama-server`) et `testdata/fake/fake-llama-bench.ts`
- Modify : `server/db/migrations.ts`, `server/http.ts`, `server/app.ts`, `server/index.ts`, `server/routes/server.ts`, `shared/src/ws.ts`, `web/src/lib/api.ts` (`ApiError.code`), `CLAUDE.md` (piège `bun --hot` : `BenchRunner` est rechargé, comme `ChatRuns`)

**Interfaces:**
- **Migrations** (une instruction chacune) :
  - 7 : `CREATE TABLE bench_runs(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, model_path TEXT NOT NULL, profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL, args_json TEXT NOT NULL /* BenchSpec */, command TEXT NOT NULL, hardware_json TEXT NOT NULL, pp_tps REAL, tg_tps REAL, stats_json TEXT /* { pp, tg, draftAcceptPct } */, vram_mib_json TEXT NOT NULL, error TEXT, log_excerpt TEXT NOT NULL DEFAULT '', duration_ms INTEGER, sweep_id INTEGER, created_at INTEGER NOT NULL)`.
  - 8 : `CREATE INDEX bench_runs_by_date ON bench_runs(created_at DESC)`.
- **`BenchRunsRepo`** :
  - `create(spec, command, hardware): BenchRun` (statut `running`) ;
  - `finish(id, patch: Partial<Pick<BenchRun, "status"|"pp"|"tg"|"draftAcceptPct"|"vramPeak"|"error"|"logExcerpt"|"durationMs">>): BenchRun` ;
  - `list(f: { kind?: BenchKind; modelPath?: string; status?: BenchStatus }): BenchRun[]` (récents d'abord) ;
  - `get(id)` ; `delete(id)` ;
  - `deleteFailed(): number` (statuts `failed | cancelled | interrupted`) ;
  - `stopOrphans(): number` (`running` → `interrupted`).
- **`HttpError(status, message, code?: string)`** : `code` sérialisé dans le corps JSON. Côté client : `ApiError.code: string | null`.
- **WS** : `{ type: "bench-progress"; payload: BenchLive | null }` et `{ type: "bench-run"; payload: BenchRun }` (envoyé à la création et à la fin d'un run).
- **`BenchRunner`** :
  ```ts
  interface ServerControl { readonly state: ServerState; readonly lastCommand: BuiltCommand | null; stop(): Promise<void>; start(cmd: BuiltCommand): Promise<void> }
  interface BenchRunnerDeps {
    repo: BenchRunsRepo; settings(): Settings; server: ServerControl; logs: LogBuffer;
    gpus(): GpuSample[];                 // monitor.latest()?.allGpus ?? []
    hardware(): Promise<BenchHardware>;  // cpu (readCpuInfo), gpus, build (`<binaire> --version`, mis en cache)
    onLive(l: BenchLive | null): void; onRun(r: BenchRun): void;
    fetch?: typeof fetch; now?: () => number;
  }
  class BenchRunner {
    get busy(): boolean; get live(): BenchLive | null;
    start(spec: BenchSpec, o: { stopServer: boolean }): Promise<BenchRun>  // renvoie le run créé, s'exécute en arrière-plan
    cancel(id: number): boolean
    dispose(o: { restart: boolean }): void
  }
  ```
  - **Refus avant le run :**
    - déjà occupé → `HttpError(409, "Un benchmark est en cours")` ;
    - serveur `external` → 409 « Un llama-server externe tourne sur le port N : arrêtez-le d'abord » ;
    - serveur géré `starting | ready` et `!stopServer` → `HttpError(409, "llama-server tourne (profil X) : il sera arrêté pendant le benchmark puis relancé", "server-running")`.
  - **Déroulé :**
    1. Mémoriser `lastCommand` du serveur arrêté, puis phase `stopping-server` → `server.stop()`.
    2. Exécuter le run.
    3. Dans tous les cas (`finally`) : phase `restarting-server` → `server.start(cmd)`. Un échec est consigné dans les logs `[bench]` et dans `BenchLive.lines`, sans changer le statut du run.
  - **llama-bench :** argv `setpriv --pdeathsig KILL -- <benchBinary> -m <modelPath> -o json --progress -r r -p p -n n ...benchArgs(params)`. stdout est accumulé. Chaque ligne de stderr va dans les logs (`[bench] …`), dans un tail de 50 lignes et dans `parseBenchProgress` (phase, `step` = test × runs). Fin du run :
    - code 0 et `parseBenchJson` non nul → `ok` ;
    - sinon `failed` avec `benchFailure` ;
    - annulation (SIGTERM, puis SIGKILL après 5 s) → `cancelled`.
    
    `logExcerpt` = tail.
  - **VRAM** (pour les deux types) : base relevée avant le lancement de l'enfant. Échantillon toutes les 500 ms, pic au-dessus de la base par GPU, en MiB arrondis. Les GPU sans hausse sont omis.
  - `command` = `shellQuote` de l'argv sans `setpriv`.
  - `dispose({ restart })` : SIGKILL de l'enfant, run → `interrupted`. Si `restart` et un serveur a été arrêté : `server.start(cmd)` une fois l'enfant sorti.
  - Le type `server` lève 501 « run serveur : Task 3 » jusqu'à la tâche suivante.
- **Routes** :
  - `GET /api/bench/runs?kind=&model=&status=` → `{ runs: BenchRun[]; live: BenchLive | null }` ;
  - `POST /api/bench/run { spec, stopServer? }` → 202 `BenchRun` (400 zod sous `issues`, 409 avec `code`) ;
  - `POST /api/bench/:id/cancel` → 204, ou 409 si ce run ne tourne pas ;
  - `DELETE /api/bench/:id` → 204 (409 s'il tourne) ;
  - `DELETE /api/bench/runs?failed=1` → `{ deleted }` ;
  - `GET /api/bench/devices` → `BenchDevice[]` (`<benchBinary> --list-devices`, mis en cache par binaire ; échec → `[]`).
- `serverRoutes` reçoit `benchBusy(): boolean` : start, switch et restart répondent 409 « Un benchmark est en cours » quand il vaut vrai.
- **`index.ts`** :
  - appelle `benchRuns.stopOrphans()` au démarrage ;
  - crée le runner avec `server` = `runtime.supervisor` ;
  - `prependListener` SIGINT/SIGTERM → `dispose({ restart: false })` ;
  - dans le dispose du rechargement → `dispose({ restart: true })`.
- **Faux llama-bench** :
  - écrit sur stderr les lignes de progression pour `-r` runs, en attendant `FAKE_BENCH_STEP_MS` (défaut 100) entre chaque ;
  - puis écrit `ok.json` sur stdout ;
  - avec `FAKE_BENCH_OOM=1` : écrit les lignes de `oom-stderr.txt` et `[`, puis sort avec le code 1 ;
  - respecte SIGTERM ; `--list-devices` → `list-devices.txt`.

- [ ] **Step 1 : Tests qui échouent.** `server/bench/runner.test.ts` (base `:memory:`, `settings.binary = "testdata/fake/fake-llama-server"`, `ServerControl` factice qui enregistre `stop`/`start` et part de l'état `ready` avec une commande `cmdA`) :
  - « restarts the server it stopped even when llama-bench fails » : `FAKE_BENCH_OOM=1`, `start(spec, { stopServer: true })`, attendre la fin (`onRun` final). Attendus :
    - statut `failed` ;
    - `error` commence par « Mémoire insuffisante » ;
    - appels `["stop", "start:cmdA"]` dans cet ordre ;
    - `onLive` a fini sur `null`.
  - « a successful run stores pp/tg and refuses a second run meanwhile » : pendant le run, un second `start` lève 409. À la fin :
    - `pp.tps` ≈ 9817.38 et `tg.tps` ≈ 410.81 ;
    - au moins un `BenchLive` en phase `prompt` avec `step` ;
    - `start(spec, { stopServer: false })` sur un serveur `ready` lève un `HttpError` de `code` `server-running`.
  
  Run : `bun test server/bench/runner.test.ts`. Expected : FAIL (module absent).
- [ ] **Step 2 : Implémenter** : migrations, repo, `HttpError.code`, runner (type `bench`), routes, câblage, garde dans `serverRoutes`, faux llama-bench, note dans `CLAUDE.md`.
- [ ] **Step 3 : Vérifier** : `bun test` et `bun run check` verts. Avec `LLAMA_WEBUI_DATA_DIR=/tmp/lw-j5` et `curl` :
  - un `POST /api/bench/run` sur le vrai Qwen3-0.6B (`kind: "bench"`, `-r 2`) aboutit à `ok` avec pp/tg proches de la commande manuelle (même ordre de grandeur que la fixture) ;
  - 30B-A3B `ngl: "all"` `dev: ["CUDA1"]` → `failed` « Mémoire insuffisante » ;
  - faux serveur prêt + `stopServer: true` → arrêté puis relancé (`/api/server/state`) ;
  - `POST /api/server/start` pendant un run → 409 ;
  - `GET /api/bench/devices` liste `Vulkan3`.
- [ ] **Step 4 : Commit** : `J5: runs de benchmark, runner llama-bench et API`.

---

### Task 3 : Runner serveur, MTP, « créer un profil »

**Files:**
- Create : `server/bench/prompt.ts` (copie de `../llama-tui/src/bench/prompt.ts`, `promptOf(tokens: number)`), `server/bench/server.ts`
- Modify : `server/bench/runner.ts`, `server/bench/runner.test.ts`, `server/routes/bench.ts`, `testdata/fake/fake-llama-server.ts`

**Interfaces:**
- `runServerTrial(o: { cmd: BuiltCommand; p; n; r; fetch; signal; onPhase(ph: BenchPhase, step?); onLine(l: string); now }): Promise<{ pp: Measure; tg: Measure; draftAcceptPct: number | null }>` : adaptation de `BenchRunner.trial` de llama-tui.
  - Même `ERROR_LINE`, même délai d'attente de sortie, timeouts de chargement et de requête à 10 min, `probeHealth` (port occupé → échec).
  - Phases : `loading`, `warmup` (`"Bonjour."`, 16 jetons), puis `measure` × `r` (`step` = i/r).
  - Chaque mesure : `/completion` avec `{ prompt: promptOf(p), n_predict: n, cache_prompt: false, temperature: 0, seed: 42 }`.
  - `pp`/`tg` = moyenne et écart-type de `prompt_per_second`/`predicted_per_second`. `tokens` = `prompt_n`/`predicted_n` de la dernière mesure.
  - `draftAcceptPct` = Σ`draft_n_accepted` / Σ`draft_n` × 100 si `draft_n > 0`, sinon `null`.
- Dans le runner, type `server` : `cmd = buildCommand` d'un profil dérivé.
  - `{ id: spec.profileId ?? 0, name: "bench", model: spec.modelPath, mmproj: spec.mmprojPath ?? undefined, cwd: dirname(modelPath), args: [...serverArgs(spec.params), ...spec.serverArgs], env: profil d'origine ou {} }`, avec le port des réglages.
  - Les échecs du serveur (sortie, OOM) passent par `benchFailure` sur le tail.
- `POST /api/bench/:id/to-profile` → 201 `Profile` :
  - `model` et `mmproj` via `profileModelPath(…, { modelsDir: settings.modelsDir, home })` ;
  - `args = [...serverArgs(params), ...spec.serverArgs]` ;
  - `env` du profil d'origine s'il existe encore ;
  - nom « <stem> — bench #<id> », suffixé « (2) », « (3) »… si pris ;
  - un run `running` → 409.
- `GET /api/bench/from-profile/:id` → `Pick<BenchSpec, "modelPath"|"mmprojPath"|"profileId"|"params"|"serverArgs">` :
  - modèle via `profilePaths` ;
  - `params`/`serverArgs` via `paramsFromServerArgs(profile.args)`.
- Faux serveur : `timings` de `/completion` avec `prompt_n`, `predicted_n` et, si `FAKE_DRAFT=1`, `draft_n: 40, draft_n_accepted: 19`.

- [ ] **Step 1 : Test qui échoue.** Dans `runner.test.ts`, « a server run measures r times and reports draft acceptance » :
  - `kind: "server"`, `r: 2`, faux serveur avec `FAKE_PP=1000 FAKE_TG=50 FAKE_DRAFT=1`, port libre ;
  - attendus : `ok`, `pp.tps` 1000, `tg.tps` 50, `stddev` 0, `draftAcceptPct` 47.5 ;
  - aucun processus `fake-llama-server` restant (`proc.exitCode` connu).
  
  Run : `bun test server/bench/runner.test.ts`. Expected : FAIL (501).
- [ ] **Step 2 : Implémenter** `prompt.ts`, `server.ts`, le branchement dans le runner, les deux routes et le faux serveur.
- [ ] **Step 3 : Vérifier** : `bun test` et `bun run check` verts. Avec `curl` :
  - run serveur du profil faux → `ok` avec MTP ;
  - `to-profile` deux fois → deux noms distincts ;
  - `from-profile` d'un profil copié de llama-tui → `params.fa = "on"`, `serverArgs` contient `--spec-type`.
- [ ] **Step 4 : Commit** : `J5: run serveur, acceptation MTP et profil depuis un run`.

---

### Task 4 : Page Benchmark

**Files:**
- Create :
  - `web/src/lib/bench.ts` ;
  - `web/src/features/bench/{BenchPage,BenchForm,BenchLiveCard,BenchHistory,BenchCompareDialog,BenchBars}.tsx`.
- Modify : `web/src/app/{router.tsx,routes.ts}` (`/bench` retiré de `MILESTONE_BY_PATH`).
- shadcn : `checkbox` (`bunx shadcn@latest docs checkbox` d'abord).

**Interfaces:**
- **`lib/bench.ts`** — store zustand `useBench` :
  - état : `runs`, `live`, `filters: { kind?; modelPath?; status? }`, `draft: BenchSpec`, `selected: number[]` ;
  - actions : `load()`, `setDraft(patch)`, `fromProfile(id)`, `rerun(run)` (`draft = run.spec`), `launch(stopServer?)`, `cancel()`, `remove(id)`, `removeFailed()`, `toProfile(id): Promise<Profile>`, `toggle(id)` ;
  - événements WS `bench-progress` / `bench-run`, abonnés une fois ;
  - au retour du WS (`hello`), `load()`.
- **`BenchPage`** : en-tête « Benchmark ». En haut, deux colonnes : `BenchForm` à gauche ; à droite `BenchLiveCard` pendant un run, sinon le dernier run. En dessous, `BenchHistory`.
- **`BenchForm`** (`GlassCard` « Nouveau benchmark ») :
  - `Select` « Partir d'un profil » (« Aucun » ou un profil ; un choix appelle `fromProfile`) ;
  - modèle : `InputGroup` + `ModelPicker` (projecteur seulement pour le type serveur) ;
  - `Tabs` « llama-bench · Serveur » ;
  - grille de champs : `-ngl` (nombre, ou `Select` auto/all), `-ncmoe`, `-t`, `-b`, `-ub` ;
  - `-dev` : une `Checkbox` par device de `/api/bench/devices` à plus de 0 MiB (`CUDA0` « RTX 5070 Ti · 15,6 Go »…), rien de coché = auto ;
  - `-ts` : un nombre par device coché ;
  - `-sm`, `-fa`, `-ctk`, `-ctv` : `Select` avec « défaut » ;
  - `-ot` : `Textarea`, une règle par ligne ;
  - `-p`, `-n`, `-r` ;
  - « Autres flags serveur » (`Textarea`, découpage par `shellSplit` de `shared/shell.ts`). Avec llama-bench : note « ignorés par llama-bench » ;
  - erreurs zod sous chaque champ (`issues`) ;
  - `ignoredByBench(serverArgs)` non vide sous l'onglet llama-bench → `Alert` qui liste flag et raison, avec le rappel que le débit de génération de llama-bench n'inclut pas le décodage spéculatif ;
  - bouton « Lancer » désactivé pendant un run ou si le serveur est externe ;
  - 409 `server-running` → `AlertDialog` « Arrêter llama-server ? Il sera relancé avec le même profil à la fin du benchmark. » → `launch(true)`.
- **`BenchLiveCard`** :
  - type (`Badge`), modèle, phase en français (« Arrêt du serveur », « Chargement », « Échauffement », « Prompt », « Génération », « Mesure », « Relance du serveur »), `Progress` sur `step`, durée écoulée (`useNow`) ;
  - 20 dernières lignes dans un bloc `bg-well` monospace ;
  - bouton « Annuler ».
- **`BenchHistory`** (`GlassCard` « Historique ») :
  - filtres `Select` type / modèle / statut ;
  - bouton « Supprimer les échecs » avec `ConfirmDialog` ;
  - `Table` : `Checkbox`, date, type (`Badge` « llama-bench » / « serveur »), modèle (stem), flags (`benchArgs` ou `serverArgs` tronqués en mono, complets en `Tooltip`), pp t/s ± écart, tg t/s ± écart, MTP %, VRAM pic (somme, détail par GPU en `Tooltip`), durée, statut (`Badge` ; `failed` destructif avec l'erreur en `Tooltip`) ;
  - `DropdownMenu` par ligne : Relancer, Créer un profil (puis navigation vers `/profiles?id=`), Copier la commande, Supprimer ;
  - bouton « Comparer (n) » actif pour 2 à 4 runs sélectionnés.
- **`BenchCompareDialog`** (`Dialog` large) :
  - une colonne par run ;
  - lignes : type, modèle, chaque flag (valeurs qui diffèrent en `font-medium` sur `bg-accent`), p/n/r, pp, tg, MTP, VRAM par GPU, build, CPU/GPU du matériel figé (« matériel différent » si les `hardware` diffèrent) ;
  - `Alert` si les types sont mélangés : « llama-bench et serveur ne se comparent pas directement : décodage spéculatif et contexte ne sont pas mesurés par llama-bench ».
  - `BenchBars` en dessous.
- **`BenchBars`** : deux petits graphiques en barres horizontales, pp puis tg (une échelle chacun, jamais un double axe).
  - Une couleur par run dans l'ordre fixe des tons `--tone-*`, avec légende et valeur en texte à droite de chaque barre (texte en tokens de texte, pas en couleur de série).
  - Hover : `Tooltip` avec la valeur ± écart.
  - Suivre la skill `dataviz` (barres fines, extrémité arrondie de 4 px, espace de 2 px) ; vérifier les deux thèmes.

- [ ] **Step 1 : Implémenter** : composant shadcn, store, composants, routes.
- [ ] **Step 2 : Vérifier.** Chrome, **les deux thèmes**, faux serveur et faux llama-bench dans `/tmp/lw-j5`, `FAKE_BENCH_STEP_MS=400` :
  - formulaire prérempli depuis un profil importé de llama-tui (`-fa on`, Alerte MTP + `-c` sous llama-bench) ;
  - erreurs sous les champs (`-ngl` dans « Autres flags ») ;
  - lancement avec serveur prêt → dialogue → progression en direct dans deux onglets → serveur relancé ;
  - Annuler ;
  - OOM (`FAKE_BENCH_OOM=1`) ;
  - filtres ; Relancer ; Créer un profil ; comparaison mélangée avec avertissement et barres ;
  - Supprimer les échecs ;
  - `bun run check` vert.
- [ ] **Step 3 : Commit** : `J5: page Benchmark`.

---

### Task 5 : Vérification du jalon avec le vrai modèle

**Files:** aucun nouveau (corrections éventuelles dans les fichiers des tâches 1–4).

- [ ] **Step 1 : llama-bench réel.**
  1. Base `/tmp/lw-j5`, profil Qwen3.8-27B (créé depuis la page Modèles) démarré.
  2. Lancer depuis la page, à partir du profil, un run llama-bench (`-p 512 -n 128 -r 3`) → confirmation → serveur arrêté, run `ok`, serveur relancé PRÊT.
  3. Lancer à la main la commande affichée (« Copier la commande ») dans un terminal, serveur arrêté : pp/tg à ±5 % de l'historique.
- [ ] **Step 2 : Run serveur réel.** Même profil, type Serveur, `-r 3` :
  - `ok` ;
  - tg proche des stats du chat J4 (~50 t/s) ;
  - MTP ≈ 48 % ;
  - VRAM pic par GPU cohérente avec la page Système ;
  - comparaison avec le run llama-bench → avertissement affiché ;
  - noter les deux tg dans le ledger : écart attendu, dû au MTP.
- [ ] **Step 3 : Review Focus 1, 2, 5.**
  - OOM réel (30B-A3B, `-ngl all`, `-dev CUDA1` seul) → « Mémoire insuffisante » et serveur relancé ;
  - annuler pendant le chargement du run serveur puis pendant la mesure llama-bench → `cancelled`, puis `pgrep -af "llama-bench|llama-server"` ne montre que le serveur relancé ;
  - modifier un commentaire de `server/routes/bench.ts` pendant un run → `interrupted` et serveur relancé ;
  - « Créer un profil » depuis le run serveur → le profil démarre.
- [ ] **Step 4 : Suite complète** : `bun test` et `bun run check` verts ; chaque page touchée relue dans les deux thèmes ; serveurs arrêtés et Bun coupé à la fin.
- [ ] **Step 5 : Commit** : `J5: vérification du jalon` (seulement s'il y a des corrections).
