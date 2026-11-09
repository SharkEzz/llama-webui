# Page « Topologie » : flux de données en direct, scène 3D

## Intention

Montrer la **topologie physique de la machine** (CPU, mémoire, NVMe, GPU, chipset) et **ce qui y circule en direct**
pendant l'inférence ou un bench llama-server : débits PCIe par GPU, lecture du disque du modèle, trafic DRAM, phase du
serveur (chargement, prompt, génération) et répartition du modèle entre les devices.

## Décisions

| Question            | Décision                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Flux affichés       | Débits **mesurés** (PCIe RX/TX par GPU NVIDIA, lecture NVMe, DRAM par `perf`, sinon activité CPU) **et** phases    |
| Moment d'usage      | Pendant l'inférence / un bench                                                                                     |
| Rendu               | 3D stylisée, **react-three-fiber + drei**, cadence de rendu pilotée (voir Performances)                            |
| Interaction         | Caméra en vue 3/4 (dérive lente), glisser / déplacer / zoomer, « Recentrer la vue » ; survol d'un bloc = infobulle |
| Mise en page        | Scène plein cadre + cartes HUD en verre dans les coins                                                             |
| Topologie           | **Découverte automatique** depuis sysfs (`server/hardware/pci.ts`)                                                 |
| Placement du modèle | Parsé dans les **logs de démarrage** de llama-server (`server/monitor/placement.ts`)                               |

## Architecture

- **Graphe statique** : `GET /api/topology` → `{ graph, placement }`. Le graphe (`TopologyGraph`, `shared/src/topology.ts`)
  est relu à chaque appel (l'état courant des liens change avec les états d'énergie) : CPU (`/proc/cpuinfo`), mémoire
  (`MemTotal`, température des barrettes `spd5118`), chaque GPU (classe PCI 0x03) et contrôleur NVMe (0x0108) avec son
  lien vers le CPU, directement (port racine) ou via un nœud **chipset**. Capacité d'un lien = min des deux bouts
  (`max_link_speed/width`), état courant = `current_link_*` du côté aval. Noms d'après pci.ids (le nom entre crochets
  est préféré) ; seuls les noms demandés sont gardés en mémoire.
- **Chipset** : le premier bridge sous le port racine est un chipset s'il vient du fabricant de la plateforme (celui du
  port racine : AMD pour Promontory, X570, 600 Series), s'il n'est pas sous un port externe (sysfs `removable`) et si
  son nom pci.ids complet n'est ni Thunderbolt ni USB4. Un switch tiers (PLX/Broadcom, ASMedia, Microchip : carte NVMe,
  riser) n'en est pas un : ses périphériques restent reliés au CPU. Les bridges du périphérique lui-même (switch d'une
  Radeon) ne comptent pas.
- **Valeurs live** : le client projette le `Snapshot` (`web/src/features/topology/flows.ts`) : `pcieRxBps/pcieTxBps`
  (NVML) sur les liens GPU, `disk.perDisk[bloc]` sur chaque NVMe (écritures vers le disque, lectures vers le CPU ; le
  total machine compte aussi les SATA/USB et n'est jamais prêté à un NVMe), `system.memBw` (perf) sur le lien CPU ↔ RAM.
  Sans mesure DRAM, ce lien porte une _activité_ : le CPU de llama-server ramené au nombre de threads (0–100 % de la
  machine), sinon le CPU système. Un chipset porte la somme de ce qui passe derrière lui.
- **Placement** (`PlacementTracker`) : rejoue le ring de logs (qui survit à `bun --hot`) et suit `supervisor.subscribe` ;
  diffusé par le message WS `placement`. Lit, depuis la dernière ligne `[llama-webui] lancement:` :
  - `using device X (…) (busId)` : device ggml ↔ adresse PCI ;
  - `offloaded N/M layers` : le premier est le modèle principal, le second ouvre un draft (`-md`) et clôt la lecture ;
  - `X model|KV|RS|compute buffer size = N MiB` : `RS` (état récurrent d'un modèle hybride) compte avec le cache KV ;
    le compute se compte **par contexte** (`llama_context: constructing llama_context` en ouvre un, celui d'un MTP
    s'ajoute au principal) et une nouvelle réservation (`sched_reserve: reserving`) remplace la précédente ;
  - les buffers du mmproj (fonctions de `clip.cpp`, estimés avant même le modèle) sont ignorés ;
  - les sondes de l'ajustement mémoire (`-fit`), entre « fitting params to device memory » et « fitting params to free
    memory took », sont sautées : à `-lv 5` elles écrivent leurs couches, buffers à 0 MiB et contextes avant le vrai
    chargement (fixture `testdata/llama-server-load-mtp-lv5.txt`).

  Nul pour un serveur externe, `idle` ou `crashed`. Le dernier placement lu est gardé avec le PID du serveur (sur
  `globalThis`) : il reste valable une fois la ligne de lancement évincée du ring, ou après un rechargement de Bun, tant
  que le serveur suivi a le même PID ; oublié à l'arrêt.
- **Phase** : `phaseOf(state, snapshot)` (`shared/`) : arrêté → chargement → inactif → prompt → génération. Un slot
  occupé est en phase prompt tant qu'il n'a généré aucun token (`n_decoded = 0`) : `n_prompt_tokens` est tout le
  contexte du slot (il grossit des tokens générés) et `n_prompt_tokens_processed` exclut le cache.
- **Scène** (`TopologyScene.tsx`, rendu revu par `2026-11-09-topology-visibility-design.md` : réservoirs, pastilles
  de débit, traits lumineux, cartes repliables) : dalles arrondies (émission = charge, corps teinté du ton du composant), tubes
  (épaisseur = capacité PCIe), particules instanciées (nombre et vitesse en échelle log du débit, un sens de chaque côté
  du tube), pulsation du lien mémoire ∝ activité quand la DRAM n'est pas mesurée. Caméra ajustée au cadre par projection
  des coins de la scène (`fitCamera`, `layout.ts`) pour laisser les coins aux cartes HUD. Couleurs = tokens CSS résolus
  en RGB via un canvas 2D (Three ne lit pas `oklch()`).
- **Étiquettes et infobulle** : DOM ordinaire (`Labels.tsx`), ancré à chaque image par `<Projector>` sur le sommet des
  blocs (drei `<Html>` perd le premier portail sous React 19 en mode strict).
- **Mouvement réduit** : pas de particules ni de dérive ; la lueur reste proportionnelle au débit, les chiffres restent
  dans les étiquettes.

## Bande passante DRAM (perf)

`server/collectors/membw.ts` garde un `perf stat -a -e umc_cas_cmd.rd,umc_cas_cmd.wr -I <cadence>` ouvert (PMU du
contrôleur mémoire AMD Zen 4/5, une commande CAS = 64 octets : tout ce qui touche la DRAM, CPU, DMA GPU et NVMe) et un
`perf stat -p <pid> -e ls_any_fills_from_sys.dram_io_all` sur llama-server (sa part, approximative). Sans root quand
`kernel.perf_event_paranoid ≤ 0` (ou `setcap cap_perfmon=ep` sur perf). Suit l'interrupteur du collecteur système.
Résultat dans `SystemSample.memBw` et `proc.dramBps`, séries `mem.read`, `mem.write`, `proc.dram` ; affiché sur le
lien CPU ↔ RAM (écritures d'un côté, lectures de l'autre), dans l'infobulle de la RAM, le HUD et la carte Mémoire de la
page Système. Repli « activité CPU » quand perf manque, que l'événement est inconnu (Intel : `uncore_imc` à ajouter)
ou que les droits refusent.

Relances : un `perf` arrêté, qu'il ait donné des valeurs ou non, est relancé au plus une fois par minute (pas de boucle
de lancement à chaque tick) ; un PID auquel perf n'a jamais pu s'attacher n'est pas réessayé. Coût mesuré avec
Qwen3.8-27B : aucun écart de vitesse de génération avec ou sans `perf stat -p` (57,45 tok/s) ; `perf stat -a` : 0 % CPU,
19 Mo de RSS.

## Performances

- **Rendu** (`pacing.ts`, `FramePacer`) : le canvas est en `frameloop="never"` et un pilote ne dessine que si la scène
  le demande. Ce qui s'anime le signale pendant l'image (particules, pulsation, lissages pas encore arrivés, retour au
  cadrage, geste et amortissement de la caméra) : 60 i/s au plus, quelle que soit la fréquence de l'écran ; la seule
  dérive de la caméra : 20 i/s ; rien : aucune image jusqu'au prochain changement (snapshot, survol, thème, taille).
- **Bundle** : three.js et react-three-fiber ne sont chargés qu'à l'ouverture de la page. En production, le front est
  construit au démarrage par `Bun.build` et découpé par page (`server/routes/web.ts`) : le bundler de `Bun.serve`
  ignorait le découpage.
- **pci.ids** : chaque nom est cherché dans le texte (`indexOf`, sans découper le fichier en lignes) et seul le résultat
  est mémorisé ; plus aucune relecture après la première lecture de la topologie.

## Limites assumées

- Bande passante DRAM : AMD Zen 4/5 seulement pour l'instant ; la part de llama-server ne voit ni les préfetchs
  d'autres cœurs ni les DMA.
- Pas de débit PCIe pour les GPU AMD (absent de sysfs) ni de trafic GPU ↔ GPU (passe par le root complex).
- Le placement dépend du format des logs de llama.cpp (niveau INFO, présent quelle que soit la verbosité). Il ne décrit
  que le modèle principal : la mémoire d'un draft (`-md`) et du mmproj n'y figure pas (elle reste visible dans la VRAM
  de chaque carte).
- Sur Intel, le PCH n'apparaît pas comme un bridge sous un port racine : ses périphériques sont dessinés reliés au CPU.
  Derrière un switch tiers, le lien affiché est celui du périphérique jusqu'au switch, pas le lien partagé vers le CPU.
- Linux uniquement (sysfs).
