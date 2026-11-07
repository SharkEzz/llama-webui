# J3 — Mode clair et monitoring : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un mode clair (verre clair + bulles pastel) avec bascule Système / Sombre / Clair, l'UI J1-J2 remise sur les tokens et primitives shadcn, puis le monitoring temps réel (llama-server, GPU NVIDIA/AMD, CPU, RAM, disque) avec Dashboard, Système et Réglages.

**Architecture:** Thèmes à la manière de shadcn : variables CSS du clair dans `:root`, du sombre dans `.dark`, exposées à Tailwind par `@theme inline` ; les composants n'emploient que des classes sémantiques. Monitoring : collecteurs **copiés et adaptés** de `../llama-tui/src/collectors` + `src/hardware/cpu.ts` + `src/store/{ring,store,poller}.ts` (TS uniquement) ; un `Monitor` (le `Poller` de llama-tui) vit dans le runtime (survit à `bun --hot`), échantillonne en permanence à `pollIntervalMs`, garde l'historique en anneaux et pousse un `snapshot` JSON par tick sur le WS ; le client relit l'historique au (re)branchement puis ajoute les points de chaque snapshot.

**Tech Stack:** existant J2 + `uplot` (charts), composants shadcn `card table tabs dropdown-menu command alert skeleton progress slider` (Base UI).

**Spec:** `docs/superpowers/specs/2026-11-05-llama-webui-design.md` (sections Design system et J3). Plans précédents : `2026-11-05-j1-socle.md`, `2026-11-05-j2-serveur-profils-logs.md`.

## Global Constraints

- **Tailwind/shadcn correctement** (consigne utilisateur) : classes sémantiques seulement (`bg-background`, `bg-card`, `text-muted-foreground`, `border-border`, `bg-muted`, `ring-ring`, `bg-popover`…) et tokens projet déclarés pareil ; aucune couleur en dur (`white/x`, `black/x`, `emerald-*`, hex) dans `web/src` hors `index.css` ; pas de `dark:` quand un token suffit ; primitives shadcn plutôt qu'éléments bruts ; API vérifiée avec `bunx shadcn@latest docs <composant>` (variante Base UI : `render`, `nativeButton`).
- Choix utilisateur (2026-11-05) : mode clair = **verre clair + bulles pastel** ; thème initial **Système** ; collecte **permanente** (même sans onglet ouvert).
- Skills : `frontend-design` pour la palette claire (Task 1), `dataviz` **avant** d'écrire le premier chart (Task 5).
- UI en français. Polices Inter + JetBrains Mono (pas Geist). Verre et bulles conservés dans les deux thèmes.
- Tests minimaux : seulement les parseurs à fixtures (`/metrics`, `/slots`, nvidia-smi CSV, fdinfo AMD), copiés de `../llama-tui/test/` ; fixtures copiées dans `testdata/`. Le reste se vérifie à la main dans Chrome, dans **les deux thèmes**.
- `historySeconds` défaut 300 (30–1800), `pollIntervalMs` défaut 1000 (≥ 250) ; iGPU `0000:0d:00.0` masquée par défaut (`hiddenGpus`), une carte masquée ou en veille (runtime-suspended) n'est **jamais lue**.
- Le `Monitor` vit dans `server/runtime.ts` : modifier un fichier `server/monitor/**` ou `server/collectors/**` demande un redémarrage complet de Bun (piège `bun --hot` de CLAUDE.md) ; erreurs comparées par `name`, pas `instanceof`.
- Vérifier depuis le Chrome distant : `LLAMA_WEBUI_HOST=0.0.0.0`, http://192.168.0.20:7860. Un nouveau fichier `web/src/**` peut demander de relancer `bun run dev`.
- Commits en français, un par tâche, suffixe `Co-Authored-By:` du modèle qui exécute.

## Review Focus

1. **Carte AMD en veille (RX 9070 XT quand elle est runtime-suspended) ou masquée (iGPU 610M)** : le monitoring ne doit jamais la réveiller (pas de lecture sysfs/fdinfo) ; elle apparaît « en veille » / « masquée ». Vérif manuelle Task 4 : une carte dont `/sys/bus/pci/devices/<bus>/power/runtime_status` vaut `suspended` le reste après 1 min de Dashboard ouvert (au moment du plan, `0000:08:00.0` et `0000:0d:00.0` sont `active` : vérifier sur l'iGPU masquée qu'aucun fichier n'est lu, `strace -f -e openat -p <pid bun>` filtré sur `0000:0d:00.0`).
2. **NVML absent ou en échec** : repli sur `nvidia-smi` ; `nvidia-smi` absent aussi → pas de GPU NVIDIA listé, aucun crash, le reste du snapshot continue. Vérif manuelle Task 4 (réglage `collectors.nvml: false`, puis binaire nvidia-smi introuvable via `PATH` réduit).
3. **llama-server redémarré (nouveau PID) ou compteurs `/metrics` remis à zéro** : pas de débit négatif ni de pic absurde au tick suivant (les deltas repartent de zéro). Couvert par les tests copiés de `liveRates`/`requestDelta` (Task 3) + vérif Task 8 (Redémarrer pendant une génération).
4. **Changer `historySeconds` ou `pollIntervalMs` à chaud** : l'historique est redimensionné (les points récents gardés), la cadence suit, les charts se recalent sans recharger la page. Vérif manuelle Task 7.
5. **Thème** : aucun flash du mauvais thème au chargement (script inline avant le rendu), passage Système ↔ Clair ↔ Sombre sans rechargement, charts uPlot et toasts recolorés. Vérif manuelle Tasks 1 et 5.

---

### Task 1 : Thèmes clair/sombre et bascule

**Files:**

- Modify : `web/src/index.css`, `web/index.html`, `web/src/components/ui/sonner.tsx`, `web/src/app/StatusBar.tsx`, `shared/src/settings.ts`
- Create : `web/src/lib/theme.ts`, `web/src/app/ThemeToggle.tsx`
- shadcn : `dropdown-menu` (déjà là), vérifier `bunx shadcn@latest docs dropdown-menu`

**Interfaces:**

- `settings.ts` : `theme: z.enum(["system", "light", "dark"]).default("system")`.
- `index.css` : `:root` = **clair**, `.dark` = **sombre** (valeurs J1/J2 actuelles déplacées dans `.dark`). Tokens projet ajoutés dans les deux blocs puis exposés dans `@theme inline` : `--surface` / `--surface-foreground` (verre des cartes), `--surface-border`, `--well` (fond des zones de code/logs/commande), `--success` (état Prêt, connecté), `--warning`, `--bubble-violet|cyan|amber|rose` + `--bubble-opacity` (bulles pastel peu saturées en clair), `--page-from` / `--page-to` (dégradé de fond). `--card` = `var(--surface)`, `--sidebar` = `var(--surface)`. Utilitaire `.glass` supprimé au profit de `bg-card` + `backdrop-blur-lg` + `border-border` (Task 2). `@custom-variant dark (&:where(.dark, .dark *));`.
- `index.html` : script inline **avant** le bundle : lit `localStorage["llama-webui:theme"]` (défaut `"system"`), résout avec `matchMedia("(prefers-color-scheme: dark)")`, pose ou retire `class="dark"` sur `<html>` et `style.colorScheme`.
- `lib/theme.ts` : store zustand `useTheme { mode: "system" | "light" | "dark"; resolved: "light" | "dark"; setMode(mode): void }` — `setMode` met à jour la classe de `<html>`, `localStorage` et `PATCH /api/settings { theme }` ; écoute `prefers-color-scheme` en mode système ; au démarrage, si `GET /api/settings` diffère du `localStorage`, la base fait foi (un autre navigateur a pu changer le choix).
- `ThemeToggle` : `DropdownMenu` shadcn (déclencheur `Button variant="ghost" size="icon"` avec `Sun`/`Moon`/`Monitor` lucide selon `mode`), 3 éléments radio « Système », « Clair », « Sombre ».
- `sonner.tsx` : `theme={resolved}` depuis `useTheme`.

- [ ] **Step 1 : Palette claire** — invoquer `frontend-design` ; écrire les valeurs `:root` (clair) : fond clair tiède légèrement violet, verre blanc translucide (`oklch(1 0 0 / 55-70%)`), bordure `oklch(0.2 0.02 280 / 10%)`, bulles pastel (même teintes, chroma ÷ 2, opacité ~0,25), texte et `muted-foreground` au contraste AA sur le verre.
- [ ] **Step 2 : Implémenter** settings, script inline, `lib/theme.ts`, `ThemeToggle` (dans `StatusBar`, à droite de la version API), `sonner.tsx`.
- [ ] **Step 3 : Vérifier** — Chrome : bascule des 3 modes sans rechargement ; mode Système suit l'émulation `prefers-color-scheme` (DevTools > Rendering) ; rechargement en Clair → pas de flash sombre ; choix conservé après redémarrage de Bun ; `bun run check` vert.
- [ ] **Step 4 : Commit** — `J3: thèmes clair/sombre (tokens shadcn) et bascule Système/Clair/Sombre`.

---

### Task 2 : UI J1-J2 sur tokens et primitives shadcn

**Files:**

- Modify : tous les fichiers de `web/src` (hors `components/ui`) contenant des couleurs en dur — aujourd'hui `components/glass/{GlassCard,StatTile,Gauge,AuroraBackground}.tsx`, `app/{Sidebar,StatusBar,AppLayout}.tsx`, `features/server/{ServerPage,ServerStateBadge}.tsx`, `features/profiles/{ProfilesPage,ProfileForm,ArgsEditor,highlight}.tsx`, `features/logs/{LogsPage,LogRow}.tsx`, `features/home/HomePage.tsx`, `components/CodeTextarea.tsx`
- shadcn : `card alert skeleton command` (`bunx shadcn@latest docs card|command|alert|skeleton` d'abord)

**Interfaces:**

- `GlassCard` devient une fine composition de `Card` / `CardHeader` / `CardTitle` / `CardAction` / `CardContent` shadcn (mêmes props qu'en J1 : `title?`, `icon?`, `actions?`, `className?`, `children`) ; le verre vient du token `--card` + `backdrop-blur-lg` sur `Card` via `className`, pas d'une classe `.glass`. `StatTile` sur `Card size="sm"`.
- Sidebar : `bg-sidebar` / `text-sidebar-foreground` / `bg-sidebar-accent` (lien actif) ; liste des profils (`ProfilesPage`) en `Button variant="ghost"` alignés à gauche (état sélectionné via `bg-accent`) au lieu de `<button>` bruts.
- Suggestions de flags (`ArgsEditor`) rendues avec `Command` / `CommandList` / `CommandItem` (`shouldFilter={false}`, `value` contrôlée = suggestion active) ; le clavier reste géré par le textarea ; ajouter `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant` sur le textarea (mineur J2).
- États vides et erreurs (« Aucun profil », « Aucun log », erreurs de `/props`) en `Alert` ; chargements (`/props`, profils) en `Skeleton`.
- Couleurs : état Prêt / Connecté → `text-success` / `bg-success` ; zones de code, commande, logs, `CodeTextarea` → `bg-well` ; séparateurs → `divide-border` / `border-border` ; ombres → `shadow-sm` sans couleur.
- [ ] **Step 1 : Implémenter** la migration fichier par fichier.
- [ ] **Step 2 : Vérifier qu'il ne reste rien en dur** — `grep -rnE "(white|black)/[0-9]+|emerald-|#[0-9a-fA-F]{3,6}\b" web/src --include='*.tsx' | grep -v components/ui` : aucune ligne.
- [ ] **Step 3 : Vérifier à la main** — Chrome, **les deux thèmes** : Accueil, Serveur (avec le faux serveur `testdata/fake/fake-llama-server` prêt), Profils (suggestions de flags, coloration, dialogue de suppression), Logs ; contrastes lisibles, pas de texte blanc sur blanc ; `bun run check` vert.
- [ ] **Step 4 : Commit** — `J3: UI J1-J2 sur tokens et primitives shadcn`.

---

### Task 3 : `shared/` et parseurs des collecteurs

**Files:**

- Create : `shared/src/monitor.ts`
- Create (copies adaptées de `../llama-tui/src/collectors/`) : `server/collectors/{prometheus,llama,gpu,nvidia,amdgpu,system,disk,proc}.ts`
- Copy fixtures : `../llama-tui/testdata/{metrics-idle.txt,metrics-after.txt,slots-idle.json,slots-busy.json,nvidia-gpu.csv,nvidia-apps.csv,fdinfo-amd-igpu.txt,fdinfo-amd-vram.txt,fdinfo-other.txt}` → `testdata/`
- Test : `server/collectors/{llama,nvidia,amdgpu}.test.ts` (copies de `../llama-tui/test/{llama,nvidia,amdgpu}.test.ts`, chemins de fixtures vers `testdata/`)
- Modify : `shared/src/ws.ts`, `shared/src/settings.ts`, `shared/src/index.ts`

**Interfaces:**

- `monitor.ts` (types sérialisables, copiés de llama-tui sans `Map`) : `GpuSample`, `MemInfo`, `SystemSample`, `DiskSample`, `SlotView`, `Health`, `RequestStats`, `SpecStats`, `RequestRecord`, `CpuInfo` ; `SERIES` (copie de `store.ts`) ;

  ```ts
  export interface Snapshot {
    at: number; tick: number;
    health: Health | null;            // null : aucun serveur actif
    rates: { genTps: number; ppTps: number };
    slots: SlotView[] | null;
    kv: { usedTokens: number; totalTokens: number } | null;
    queue: { processing: number; deferred: number; busySlots: number } | null;
    lastRequest: RequestStats | null; spec: SpecStats | null; recentRequests: RequestRecord[]; // plus récente d'abord
    gpus: GpuSample[];                // utilisées par le serveur (VRAM > 64 Mio)
    allGpus: GpuSample[];             // toutes, triées par busId, masquées/en veille comprises (non lues)
    proc: { cpuPct: number; rssBytes: number } | null;
    system: SystemSample | null; disk: DiskSample | null;
    points: Record<string, number | null>; // valeurs ajoutées à l'historique à ce tick (NaN → null)
  }
  export interface HistoryDump { intervalMs: number; capacity: number; at: number; series: Record<string, (number | null)[]> }
  ```
- `ws.ts` : `snapshot` → `{ type: "snapshot"; payload: Snapshot }`.
- `settings.ts` : `collectors: z.object({ nvml: z.boolean().default(true), system: z.boolean().default(true), disk: z.boolean().default(true) }).default({ nvml: true, system: true, disk: true })`.
- Collecteurs : copies de llama-tui, imports de types vers `@llama-webui/shared` ; `LlamaRaw.metrics` reste une `Map` côté serveur (jamais envoyée telle quelle).
- [ ] **Step 1 : Copier fixtures et tests** ; `bun test server/collectors` : FAIL (modules absents).
- [ ] **Step 2 : Implémenter** `monitor.ts` et les collecteurs copiés.
- [ ] **Step 3 : Vérifier** — `bun test` : PASS (attendus des tests llama-tui inchangés) ; `bun run check` vert.
- [ ] **Step 4 : Commit** — `J3: types de monitoring partagés et collecteurs (copiés de llama-tui)`.

---

### Task 4 : `Monitor` serveur, NVML, API et WS

**Files:**

- Create (copies adaptées) : `server/collectors/nvml/{symbols,read,worker,monitor}.ts`, `server/collectors/registry.ts`, `server/hardware/cpu.ts`, `server/monitor/{ring,history,monitor}.ts`, `server/routes/monitor.ts`
- Modify : `server/runtime.ts`, `server/index.ts`, `server/app.ts`, `server/routes/` (PATCH settings → `monitor.configure`)

**Interfaces:**

- `history.ts` : `Ring` et `History` copiés de llama-tui + `History.dump(at: number): HistoryDump` (NaN → null).
- `registry.ts` : `Collectors.start(settings)` / `configure(settings)` copiés, avec `config.collectors` et `pollIntervalMs` lus dans `Settings` ; plus de `display`/`needs` : tout est mesuré sauf les cartes de `hiddenGpus` (lecture d'identité seulement) et les cartes AMD en veille.
- `monitor.ts` : `class Monitor { static async start(deps: { supervisor: Supervisor; settings: Settings }): Promise<Monitor>; configure(settings: Settings): Promise<void>; latest(): Snapshot | null; history(): HistoryDump; onSnapshot(fn: (s: Snapshot) => void): () => void; stop(): void }` — logique de `Poller.doTick` copiée (deltas, `foldRecent`, `specStats`, séries GPU sans trous) ; sans `props` (déjà servi par `/api/server/props`) ni `recheckExternal` (déjà fait par `server/index.ts`) ; `configure` redimensionne l'historique (`History.resized`) quand `historySeconds` change et relance le timer quand `pollIntervalMs` change.
- `runtime.ts` : `Runtime.monitor: Monitor` créé une fois (survit à `bun --hot`) ; arrêté dans le handler SIGINT/SIGTERM.
- `index.ts` : `monitor.onSnapshot((s) => hub.broadcast({ type: "snapshot", payload: s }))` (désabonné au dispose) ; `PATCH /api/settings` appelle `monitor.configure(next)`.
- Routes (toutes via `guarded()`) : `GET /api/monitor/snapshot` → `Snapshot | null`, `GET /api/monitor/history` → `HistoryDump & { bootId: string }`, `GET /api/system/info` → `{ cpu: CpuInfo; gpus: { key, name, vendor, busId, vramTotalBytes }[] }`.
- [ ] **Step 1 : Implémenter**.
- [ ] **Step 2 : Vérifier à la main** — `bun run dev` : `curl /api/monitor/snapshot` montre `allGpus` (2 NVIDIA lues, RX 9070 XT en veille ou lue selon son état, iGPU `hidden`), `system`, `disk` ; un client WS reçoit un `snapshot` par seconde ; `PATCH {"historySeconds":60}` → `history().capacity` = 60 ; `PATCH {"pollIntervalMs":500}` → 2 snapshots/s.
- [ ] **Step 3 : Vérifier les points 1-2 du Review Focus** — (1) voir Review Focus 1 ; (2) `PATCH {"collectors":{"nvml":false}}` puis redémarrage → GPU NVIDIA via nvidia-smi ; `LLAMA_WEBUI_NVIDIA_SMI=/nonexistent` (variable lue par `registry.ts`, défaut `nvidia-smi`, transmise à `NvidiaMonitor({ bin })`) → pas de GPU NVIDIA, snapshot toujours émis.
- [ ] **Step 4 : Commit** — `J3: Monitor serveur (NVML, AMD sysfs, système, disque), API et snapshots WS`.

---

### Task 5 : Web — store de monitoring et charts uPlot

**Files:**

- Create : `web/src/lib/monitor.ts`, `web/src/components/charts/TimeSeriesChart.tsx`, `web/src/components/charts/chartTheme.ts`, `web/src/lib/format.ts` (ajouts)
- Modify : `web/package.json` (`uplot`)

**Interfaces:**

- `lib/monitor.ts` : store `useMonitor { snapshot: Snapshot | null; history: { intervalMs: number; capacity: number; times: number[]; series: Map<string, (number | null)[]> } }` — à chaque passage du WS à `open` (et sur `hello` d'un autre `bootId`) : `GET /api/monitor/history` remplace tout ; chaque `snapshot` ajoute `snapshot.points` (anneaux bornés à `capacity`, temps = `snapshot.at`) ; `useSeries(key): (number | null)[]` sélecteur.
- `chartTheme.ts` : couleurs lues des variables CSS (`getComputedStyle(document.documentElement)`) : axes `--muted-foreground`, grille `--border`, séries `--tone-*` ; recalculées quand `useTheme().resolved` change.
- `TimeSeriesChart({ series: { key: string; label: string; tone: Tone; unit?: string }[]; height?: number; yMax?: number; format?(v: number): string })` : uPlot dans un `ResizeObserver`, données = `useMonitor().history`, mise à jour par `setData` (pas de recréation par tick), légende et curseur en Inter, valeurs en mono tabulaire, `null` = trou.
- `format.ts` : `formatBytes(n)` (« 12,3 Go »), `formatRate(tps)` (« 42,7 tok/s »), `formatBps(n)` (« 1,2 Go/s »), `formatPct(n)`, séparateur décimal français.
- [ ] **Step 1 : Invoquer la skill `dataviz`** et suivre ses règles (formes, couleurs, légende) pour `TimeSeriesChart`.
- [ ] **Step 2 : Implémenter** ; `bun add uplot` dans `web/`.
- [ ] **Step 3 : Vérifier** — page Accueil provisoire avec un chart débit gen/prompt et un chart VRAM : se remplit à 1 Hz, garde l'historique après rechargement, recoloré au changement de thème sans rechargement (Review Focus 5) ; pas de saccade (profil Performance Chrome : < 4 ms par tick).
- [ ] **Step 4 : Commit** — `J3: store de monitoring et charts uPlot thémés`.

---

### Task 6 : Page Dashboard

**Files:**

- Create : `web/src/features/dashboard/{DashboardPage,ThroughputCard,ContextCard,RequestsTable,SystemStrip}.tsx`
- Modify : `web/src/app/router.tsx` ; retirer le chart provisoire de l'Accueil
- shadcn : `table progress` (`bunx shadcn@latest docs table|progress`)

**Interfaces:**

- `DashboardPage` : rangée de `StatTile` (débit génération, débit prompt, acceptation spéculative **seulement si** `spec.drafts > 0`, contexte utilisé) ; `ThroughputCard` (`TimeSeriesChart` gen + prompt) ; `ContextCard` (slots : barre `Progress` par slot `nDecoded + nPromptProcessed` / `nCtx`, file `queue.processing` / `deferred`) ; `RequestsTable` (`Table` shadcn : heure, tokens prompt / cache / générés, durée, pp tok/s, tg tok/s, acceptation ; 20 dernières) ; `SystemStrip` (une `Card` compacte : CPU %, RAM, une jauge VRAM par GPU de `snapshot.gpus`, disque du modèle).
- Sans serveur actif : `Alert` « llama-server est arrêté » avec lien vers Serveur ; le bandeau système reste affiché.
- [ ] **Step 1 : Implémenter**.
- [ ] **Step 2 : Vérifier** — Chrome, deux thèmes, avec le faux serveur prêt puis sans serveur.
- [ ] **Step 3 : Commit** — `J3: page Dashboard`.

---

### Task 7 : Pages Système et Réglages

**Files:**

- Create : `web/src/features/system/{SystemPage,GpuCard,CpuCard,CoreHeatmap,MemoryCard,DiskCard}.tsx`, `web/src/features/settings/SettingsPage.tsx`
- Modify : `web/src/app/router.tsx`, `web/src/app/routes.ts` (`MILESTONE_BY_PATH` sans `/dashboard`, `/system`, `/settings`)
- shadcn : `tabs slider switch input select` (`bunx shadcn@latest docs tabs|slider`)

**Interfaces:**

- `GpuCard({ gpu })` : nom, bus, vendeur ; `Gauge` util et VRAM ; lignes PCIe (gen×largeur actuelle / max, débit rx/tx), puissance / limite, horloges, température, ventilateur ; sparkline util (`TimeSeriesChart` compact) ; carte masquée ou en veille : `Badge` « masquée » / « en veille », pas de mesures.
- `CpuCard` + `CoreHeatmap` (une case par cœur, intensité = `corePct`, couleur via `--tone-violet` et opacité, valeur en infobulle) ; `MemoryCard` (RAM utilisée / disponible / swap) ; `DiskCard` (lecture/écriture machine, disque du modèle et son débit de lecture).
- `SettingsPage` (`Tabs` : « Général », « Monitoring », « Apparence ») : binaire llama-server, `modelsDir`, hôte/port par défaut ; collecteurs (3 `Switch`), intervalle (`Select` 250 / 500 / 1000 / 2000 ms), historique (`Slider` 30–1800 s, pas de 30), GPU masqués (liste de `/api/system/info` avec `Switch` par carte) ; thème (même choix que `ThemeToggle`). Enregistrement champ par champ (`PATCH /api/settings`), erreurs zod sous le champ, toast « Réglage enregistré ».
- [ ] **Step 1 : Implémenter**.
- [ ] **Step 2 : Vérifier** — Chrome, deux thèmes ; Review Focus 4 : historique 300 → 60 → 600 s et intervalle 1000 → 500 ms à chaud, charts recalés sans rechargement ; masquer puis afficher la RX 9070 XT.
- [ ] **Step 3 : Commit** — `J3: pages Système et Réglages`.

---

### Task 8 : Vérification J3 sur le vrai modèle

**Files:** aucun (corrections éventuelles dans les fichiers concernés).

- [ ] **Step 1 : Charger** `qwen3.8-27b-mtp` depuis la page Serveur.
- [ ] **Step 2 : Lancer quelques requêtes** — `for i in 1 2 3; do curl -s localhost:8080/v1/chat/completions -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"Écris 200 mots sur les GPU."}],"max_tokens":300}' > /dev/null; done` ; pendant ce temps le Dashboard montre le débit (cohérent avec `timings` des réponses), l'acceptation spéculative (profil MTP), les slots, les requêtes récentes ; la page Système montre VRAM et utilisation des deux NVIDIA qui montent.
- [ ] **Step 3 : Review Focus 3** — Redémarrer le serveur pendant une génération : aucun débit négatif ni pic au tick suivant.
- [ ] **Step 4 : Vérifier** — `bun run check` vert, `bun test` vert ; arrêt du serveur, VRAM libérée.
- [ ] **Step 5 : Commit** (si corrections) — `J3: vérification du jalon`.

---

## Self-review (fait)

- Couverture spec J3 : mode clair en tête (T1-T2) avec bascule DropdownMenu, `localStorage` + sqlite, script anti-flash, suivi système, migration des couleurs en dur, `GlassCard` sur `Card`, primitives `Command`/`Alert`/`Skeleton` ; collecteurs `/slots` + `/metrics`, NVML + repli nvidia-smi, sysfs AMD (9070 XT, 610M masquée), `/proc` CPU/RAM/disque, disque du modèle (T3-T4) ; snapshot 1 Hz WS, historique RAM configurable (T4-T5) ; Dashboard (T6), Système + heatmap cœurs, Réglages (T7) ; vérif modèle chargé + requêtes (T8) ; tests des parseurs à fixtures (T3).
- Types : `Snapshot`/`HistoryDump`/`SERIES` définis en T3, produits en T4, consommés en T5-T7 ; `Settings.theme` (T1) et `Settings.collectors` (T3) lus par `useTheme`, `Monitor.configure` et `SettingsPage` ; `Tone` (J1) réutilisé par les charts.
- Review Focus : 1-2 vérifiés en T4, 3 par tests T3 + T8, 4 en T7, 5 en T1/T5.
- Mineurs J2 repris : accessibilité combobox des suggestions (T2). Les autres mineurs J2 restent hors J3.
