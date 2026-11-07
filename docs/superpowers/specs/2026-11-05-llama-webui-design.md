# llama-webui — Spec de design et jalons

## Contexte

`../llama-tui` est un superviseur terminal (Bun + OpenTUI, référence TS dans `src/`, port Go ignoré) pour **un** `llama-server` local : profils JSON, start/stop/switch, débit live (`/slots` + `/metrics`), GPU NVIDIA (NVML) et AMD (sysfs), logs, onglet Optimiseur (estimation VRAM/KV depuis l'en-tête GGUF + benchmark `/completion`). Il n'a ni chat, ni persistance, ni sweep, ignore les GPU AMD pour le tuning, et ne gère pas `--override-tensor`.

Objectif : reprendre ce concept en **dashboard web moderne** pour usage personnel sur cette machine (localhost, pas d'auth), avec en plus un **chat**, une **persistance sqlite**, un **benchmark** historisé et un **module tuning** capable d'explorer les combinaisons d'offload pour des modèles de ~100 Go sur ce matériel :

| Ressource | Valeur |
|---|---|
| CUDA0 | RTX 5070 Ti 16 Go (bus 01:00.0) |
| CUDA1 | RTX 5060 Ti 16 Go (bus 03:00.0) |
| Vulkan3 | RX 9070 XT 16 Go (bus 08:00.0) |
| iGPU | Radeon 610M (bus 0d:00.0, à masquer) |
| RAM / swap | 61 Go / 80 Go |
| CPU | Ryzen 5 9600X, 6c/12t, 1 nœud NUMA |
| llama.cpp | `/home/tristan/BUILD/llama.cpp/build/bin` (b12119, CUDA + Vulkan + CPU + BLAS), `llama-bench` et `llama-fit-params` présents |
| Modèles | `~/Modèles` (342 Go libres, NVMe) |

Décisions prises en brainstorming :
- Usage perso localhost. Une seule instance llama-server à la fois. UI en français, thème sombre par défaut ; **mode clair livré en J3** (demande du 2026-11-05).
- Logique métier TS de llama-tui **copiée et adaptée** (pas de package partagé, llama-tui intact).
- **Tout l'état en sqlite** (`bun:sqlite`) : config, profils, conversations, benchmarks. Les profils s'**importent/exportent en JSON** (format compatible llama-tui) ; import des profils de `~/.config/llama-tui/config.json` proposé au premier lancement.
- Pas de persistance des métriques ni des logs (ring en RAM comme aujourd'hui, 2 min → configurable jusqu'à ~30 min).
- Modèles : navigateur de répertoire + métadonnées GGUF, pas de téléchargement HF.
- Chat v1 : streaming + Markdown + code, paramètres de sampling par conversation, stats par message. Pas d'images en v1 (prévu v2, le backend garde la porte ouverte).
- Tuning : sweep paramétrable mesuré par **llama-bench**, validation des meilleurs par **llama-server** réel ; espace de recherche incluant **Vulkan3**, `--override-tensor`, `--n-cpu-moe`.
- Frontend servi par **Bun** (HTML imports, `bun-plugin-tailwind`) : un seul process et un seul port. *(Révisé en J1 : Vite avait d'abord été retenu, puis retiré à la demande de l'utilisateur puisque Bun couvre tout.)*
- **Tests : minimum utile.** Pas de TDD systématique. Seuls les parseurs purs à fixtures (flags `--help`, `/metrics`, `/slots`, nvidia-smi, JSON llama-bench) et l'estimateur/générateur d'espace ont des tests unitaires. Le reste se vérifie à la main via l'UI à chaque jalon.

Hors périmètre v1 : auth, multi-instance, mode router `--models-dir`, téléchargement HF, images dans le chat, RPC/RDMA (voir « Pistes disque/réseau » en J6), mobile.

---

## Architecture

```
llama-webui/
├─ server/            Bun (API REST + WebSocket + superviseur + collecteurs + sqlite)
│  ├─ index.ts        Bun.serve : routes /api/*, /ws, importe web/index.html (fallback SPA)
│  ├─ db/             schema.sql, migrations, repos (profiles, conversations, benchmarks, settings)
│  ├─ supervisor/     copié de llama-tui src/server/{supervisor,args,health,discovery,flags}.ts
│  ├─ collectors/     copié de llama-tui src/collectors/* (+ src/hardware/*), snapshot 1 Hz
│  ├─ models/         scan GGUF (copie src/model/gguf.ts) + cache métadonnées
│  ├─ chat/           proxy streaming vers /v1/chat/completions, persistance
│  ├─ bench/          runner llama-bench (JSON) + runner /completion (copie src/bench/runner.ts)
│  ├─ tuning/         estimateur (copie src/tuning/*), générateur d'espace, file de sweep
│  └─ system/         checks système (copie src/tuning/checks.ts)
├─ web/               React 19 + TypeScript + Tailwind v4 + shadcn/ui (Base UI), bundlé par Bun
│  ├─ src/app/        routes (react-router), layout, fond animé
│  ├─ src/features/   dashboard, server, profiles, models, chat, bench, tuning, system, logs, settings
│  ├─ src/components/ ui (shadcn) + glass/ (cartes verre, gauges, charts)
│  └─ src/lib/        client API, store WS (zustand), formatters
├─ shared/            types TS partagés (Snapshot, Profile, GgufInfo, BenchResult, SweepSpec…) + schémas zod
└─ package.json       workspaces [server, web, shared] ; scripts dev / build / start / check / test
```

**Transport**
- REST JSON `/api/*` pour les actions et les lectures ponctuelles.
- Un WebSocket `/ws` qui pousse : `snapshot` (1 Hz, même structure que le `Snapshot` de `llama-tui/src/store/store.ts`), `log` (lignes), `server-state`, `bench-progress`, `sweep-progress`. Le client se reconnecte seul et rejoue l'état via `GET /api/state`.
- Chat : `POST /api/chat/:conversationId/messages` répond en **SSE** (relais du stream OpenAI-compatible de llama-server).

**Dev / prod**
- `bun run dev` : `bun --hot server/index.ts` (port 7860, HMR web + rechargement du serveur).
- `bun run start` : même serveur en `NODE_ENV=production` (bundle minifié en mémoire, pas d'étape de build). `LLAMA_WEBUI_HOST` change l'adresse d'écoute (défaut 127.0.0.1).
- `bun check` sur l'ensemble, `bun test` pour `server/` et `shared/` (fixtures réutilisées depuis `llama-tui/testdata/`).

**Design system** (skill `frontend-design` au moment de J1)
- Fond : dégradé sombre profond + 3-4 « bulles » radiales (accent violet/cyan/ambre) en `position:fixed`, animées en CSS (`translate` + `scale`, 80-180 s, `prefers-reduced-motion` respecté), `filter: blur(80px)`.
- Cartes : `backdrop-filter: blur(16px)`, fond sombre translucide (`oklch(0.1 0.02 280 / 42%)`), bordure `white/10`, léger dégradé interne, ombre douce. Tokens shadcn surchargés dans `web/src/index.css`.
- Charts temps réel : **uPlot** (léger, 1 Hz sans jank) habillé aux couleurs du thème ; jauges SVG maison. Suivre la skill `dataviz` au moment des charts.
- Typo : Inter (UI) + JetBrains Mono (chiffres, logs, flags).
- **Thèmes clair et sombre, selon les conventions shadcn/Tailwind v4** : variables du thème clair dans `:root`, du sombre dans `.dark` (classe sur `<html>`), exposées à Tailwind par `@theme inline`. Les composants n'emploient que les classes sémantiques (`bg-background`, `bg-card`, `text-muted-foreground`, `border-border`, `bg-muted`, `ring-ring`, `bg-popover`…) et des tokens projet déclarés de la même façon (`--surface`/`bg-surface` pour le verre, `--well` pour les zones de code/logs, `--success`, tons `--tone-*`) ; pas de couleurs en dur (`white/10`, `black/30`, `emerald-400`) ni de `dark:` quand un token suffit. Composants shadcn utilisés tels quels (Card, Button, Badge, Select, DropdownMenu, Tooltip…) plutôt que réinventés ; personnalisation par variantes et tokens, pas par surcharge ad hoc.

---

## Modèle de données (sqlite)

- `settings(key, value_json)` : binary, host, port par défaut, `models_dir` (défaut `~/Modèles`), `poll_interval_ms`, `history_seconds`, `hidden_gpus[]`, préférences d'affichage.
- `profiles(id, name UNIQUE, model_path, mmproj_path, cwd, host, port, args_json, env_json, created_at, updated_at, source)` — mêmes champs que llama-tui ; `args` valide les flags réservés (`--host --port --metrics --slots --props -m -mm`), catalogue via `llama-server --help`.
- `conversations(id, title, profile_id, model_path, sampling_json, system_prompt, created_at, updated_at)` ; `messages(id, conversation_id, role, content, stats_json, created_at)` (stats : ttft_ms, prompt_tokens, gen_tokens, pp_tps, tg_tps, draft_accept).
- `bench_runs(id AUTOINCREMENT, kind 'bench'|'server', model_path, args_json, hardware_json, pp_tps, tg_tps, vram_mib_json, status, error, log_excerpt, duration_ms, sweep_id, sweep_label, fit, created_at)` — `kind` = l'outil qui a mesuré ; l'appartenance à un sweep se lit dans `sweep_id` (dans un sweep, les runs `bench` explorent, les runs `server` valident). *(Révisé en J6 : pas de kind `sweep-item`.)*
- `sweeps(id AUTOINCREMENT, name, model_path, profile_id, spec_json (préréglage, base, espace, p/n/r, autres flags serveur), status, best_run_id, created_at, finished_at)`.

---

## Jalons

### J1 — Socle (monorepo, API vide, design system)
- Workspaces `server/ web/ shared/`, scripts dev/start/check/test.
- `server/index.ts` : Bun.serve, `/api/health`, `/ws` avec heartbeat, service de l'UI (HTML import).
- sqlite : ouverture, migrations, table `settings`.
- Web : React + Tailwind v4 + shadcn init (Base UI), react-router, layout (sidebar + header statut), fond animé, composants `GlassCard`, `Gauge`, `StatTile`, page d'accueil avec placeholders.
- **Vérif** : `bun run dev` ouvre l'UI, `/api/health` répond, WS connecté, rendu du fond et des cartes validé visuellement, `bun check` vert.

### J2 — Serveur, profils, logs
- Copier/adapter `supervisor.ts`, `args.ts`, `health.ts`, `discovery.ts`, `flags.ts` (états idle/starting/ready/stopping/crashed/external, pdeathsig via `setpriv`, SIGTERM 5 s puis SIGKILL, détection serveur externe par `/proc`).
- API : `GET/POST/PUT/DELETE /api/profiles`, `POST /api/profiles/import` (JSON llama-tui), `GET /api/profiles/:id/export`, `POST /api/server/{start,stop,restart,switch}`, `GET /api/server/state`, `GET /api/server/props`, `GET /api/flags`.
- Ring de logs 10 000 lignes diffusé en WS ; `GET /api/logs?since=`.
- Web : page **Serveur** (statut, commande effective, actions avec confirmation, infos `/props`), page **Profils** (liste, formulaire avec autocomplétion de flags et aide inline, duplication, import/export), page **Logs** (suivi auto, filtre niveau, recherche, couleurs).
- **Vérif** : lancer le profil Qwen3.8-27B depuis l'UI, voir PRÊT, switcher, arrêter, importer les 2 profils de llama-tui ; tests unitaires sur args/validation/parse flags avec `llama-tui/testdata/llama-server-help.txt`.

### J3 — Monitoring
- **Mode clair** (en tête de jalon) : jeu de tokens clair (verre clair, bulles plus pâles et moins saturées, contrastes AA) ; bascule Système / Sombre / Clair dans la barre d'état (DropdownMenu shadcn), choix en `localStorage` + réglage `theme` en sqlite, classe posée sur `<html>` par un script inline avant le premier rendu (pas de flash), suivi de `prefers-color-scheme` en mode Système ; migration vers les tokens des ~25 couleurs codées en dur de J1-J2 (10 fichiers) ; `GlassCard` réécrit sur `Card` shadcn + token de surface ; éléments bruts de J1-J2 remplacés par leurs primitives shadcn (liste des profils, suggestions de flags → `Command`, états vides/erreurs → `Alert`/`Skeleton`) ; API de chaque composant vérifiée avec `bunx shadcn@latest docs <composant>` (variante Base UI). Vérif : chaque page relue dans les deux thèmes.
- Copier/adapter `collectors/*` et `hardware/*` : `/slots` + `/metrics` (deltas), NVML worker + fallback nvidia-smi, sysfs AMD (RX 9070 XT, 610M masquée par défaut), `/proc` CPU/RAM/disque, disque du modèle.
- Snapshot 1 Hz en WS ; historique en RAM, `history_seconds` configurable (défaut 300).
- Web : page **Dashboard** (débit gen/prompt, spéculatif si drafts, slots/contexte, requêtes récentes, bandeau système), page **Système** (une carte par GPU avec util/VRAM/PCIe/puissance/clocks/temp, CPU + heatmap cœurs, mémoire, disque), page **Réglages** (collecteurs, intervalle, historique, GPU masqués, binaire, models_dir).
- **Vérif** : charger le modèle, lancer quelques requêtes, voir débit et VRAM bouger ; tests des parseurs avec `testdata/metrics-*.txt`, `slots-*.json`, `nvidia-*.csv`.

### J4 — Modèles et chat
- `models/` : scan récursif de `models_dir`, lecture en-tête GGUF (`@huggingface/gguf`), gestion des shards, cache par (path, mtime, size) en sqlite ; `GET /api/models`, `GET /api/models/info?path=`. Sélecteur de modèle réutilisé dans Profils, Bench, Tuning.
- `chat/` : conversations + messages en sqlite ; `POST .../messages` relaie `/v1/chat/completions` en stream, mesure TTFT, lit `timings` pour les stats ; arrêt de génération ; régénération ; titre auto (premiers mots).
- Web : page **Modèles** (tableau archi/quant/taille/couches/ctx/experts, filtre), page **Chat** (liste de conversations, fil Markdown + code avec copie via `react-markdown` + `shiki`, panneau sampling par conversation, stats sous chaque réponse, indication du profil/modèle actif, désactivé si serveur non PRÊT).
- **Vérif** : conversation complète en streaming avec le modèle chargé, relecture après rechargement de page, modification de la température prise en compte.

### J5 — Benchmark
- `bench/` : runner **llama-bench** (`-o json`, `-r`, `-p/-n`, passage de `-ngl -ot -ncmoe -dev -ts -sm -fa -ctk/-ctv -t -b/-ub`, parsing du JSON, détection OOM) et runner **serveur** (copie de `runner.ts` : warm-up + `/completion` mesuré, VRAM réelle via collecteurs). Mutuellement exclusifs avec le superviseur (le bench serveur demande l'arrêt du serveur géré, refuse si externe).
- Persistance dans `bench_runs` avec `hardware_json` figé ; `GET /api/bench/runs`, `POST /api/bench/run`, `POST /api/bench/:id/cancel`, `POST /api/bench/:id/to-profile`.
- Web : page **Benchmark** (formulaire modèle + flags ou profil existant, choix llama-bench / serveur, progression en direct, historique filtrable, comparaison côte à côte, « créer un profil depuis ce run »).
- **Vérif** : un run llama-bench et un run serveur sur Qwen3.8-27B apparaissent dans l'historique avec pp/tg cohérents avec la ligne de commande manuelle.

### J6 — Tuning et sweep
- `tuning/` : copier `estimate.ts`, `presets.ts`, `checks.ts` ; étendre l'estimateur aux devices Vulkan (RX 9070 XT) et à `--override-tensor`/`--n-cpu-moe` (experts MoE sur CPU, tenseurs par motif) ; prendre en compte RAM + mmap quand le modèle dépasse VRAM+RAM (lecture NVMe = goulot, afficher le débit disque nécessaire vs mesuré).
- **Recommandation** : préréglages existants (chat, agent, contexte, faire tenir) + « 100 Go » (MoE experts CPU, attention/norms sur GPU, 3 GPU) → tableau Flag · Valeur · Pourquoi + estimations VRAM/RAM par device + avertissements.
- **Sweep** : l'utilisateur définit un espace (par flag, liste de valeurs ; devices à inclure ; motifs `-ot` proposés) → produit cartésien filtré par l'estimateur (élimine ce qui ne tient pas) → file persistée dans `sweeps`/`bench_runs`, exécution séquentielle par llama-bench, reprise après arrêt, annulation, classement par score du préréglage → **validation** des N meilleurs par run serveur réel → « créer un profil ».
- Panneau **checks système** (lecture seule, commande à copier) : persistence NVIDIA, power limit, PCIe, ReBAR, `nvidia_uvm`, DPM AMD, governor, THP, memlock, swappiness, IOMMU, vitesse disque du modèle, swap.
- Pistes disque/réseau évoquées (RDMA, SSD/NVMe) : RDMA n'a pas de sens sur une seule machine et le backend RPC de llama.cpp est réseau TCP, hors périmètre ; le NVMe compte dès qu'on dépasse la RAM via mmap, donc on expose la mesure de lecture du disque du modèle et un check de débit séquentiel.
- Web : page **Tuning** (matériel détecté, modèle, préréglage, recommandation, éditeur d'espace de sweep, file et progression, classement, bouton valider, bouton profil).
- **Vérif** : sur Qwen3.8-27B, un sweep de ~6 variantes (`-ngl` × devices) se termine, se classe, le meilleur se valide en serveur et devient un profil démarrable. Tests de l'estimateur et du générateur d'espace.

### J7 — Finitions
- Raccourcis clavier globaux, toasts, états vides, gestion d'erreurs uniformes, écran « serveur injoignable ».
- Fichier `README.md` (installation, `bun run dev`, `bun run start`, import depuis llama-tui), revue `frontend-design` de cohérence visuelle, passe perf (uPlot, mémo).

---

## Fichiers de référence à copier/adapter (llama-tui, version TS)

- `src/server/{supervisor,args,health,discovery,flags}.ts`
- `src/collectors/*`, `src/hardware/*`, `src/store/store.ts` (type `Snapshot`)
- `src/model/gguf.ts`, `src/tuning/{estimate,presets,checks}.ts`, `src/bench/runner.ts`
- `src/config/schema.ts` (schéma zod des profils, pour l'import/export)
- `testdata/*` (fixtures de tests)
- Specs : `docs/superpowers/specs/2026-11-03-*.md`

## Exécution

Chaque jalon a son propre plan dans `docs/superpowers/plans/` (J1 : `2026-11-05-j1-socle.md`). Les jalons s'exécutent dans l'ordre J1 → J7.
