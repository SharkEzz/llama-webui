# Page « Topologie » : flux de données en direct, scène 3D

## Intention

Montrer la **topologie physique de la machine** (CPU, mémoire, NVMe, GPU, chipset) et **ce qui y circule en direct**
pendant l'inférence ou un bench llama-server : débits PCIe par GPU, lecture du disque du modèle, activité CPU, phase du
serveur (chargement, prompt, génération) et répartition du modèle entre les devices.

## Décisions

| Question            | Décision                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Flux affichés       | Débits **mesurés** (PCIe RX/TX par GPU NVIDIA, lecture NVMe, CPU/RAM) **et** phases llama-server |
| Moment d'usage      | Pendant l'inférence / un bench                                                                   |
| Rendu               | 3D stylisée, **react-three-fiber + drei**                                                        |
| Interaction         | Caméra fixe en vue 3/4 (dérive lente), survol d'un bloc = infobulle                              |
| Mise en page        | Scène plein cadre + cartes HUD en verre dans les coins                                           |
| Topologie           | **Découverte automatique** depuis sysfs (`server/hardware/pci.ts`)                               |
| Placement du modèle | Parsé dans les **logs de démarrage** de llama-server (`server/monitor/placement.ts`)             |

## Architecture

- **Graphe statique** : `GET /api/topology` → `{ graph, placement }`. Le graphe (`TopologyGraph`, `shared/src/topology.ts`)
  est relu à chaque appel : CPU (`/proc/cpuinfo`), mémoire (`MemTotal`, température des barrettes `spd5118`), chaque GPU
  (classe PCI 0x03) et contrôleur NVMe (0x0108) avec son lien vers le CPU, directement (port racine) ou via un nœud
  **chipset** (bridges entre le port racine et la carte qui ne sont pas les siens). Capacité d'un lien = min des deux
  bouts (`max_link_speed/width`), état courant = `current_link_*` du côté aval.
- **Valeurs live** : aucun nouveau collecteur. Le client projette le `Snapshot` existant (`web/src/features/topology/flows.ts`) :
  `pcieRxBps/pcieTxBps` (NVML) sur les liens GPU, `disk.model.readBps` sur le NVMe du modèle, `proc.cpuPct` comme
  _activité_ du lien mémoire. Un chipset porte la somme de ce qui passe derrière lui.
- **Placement** : `PlacementTracker` rejoue le ring de logs (qui survit à `bun --hot`) et suit `supervisor.subscribe` ;
  lignes `using device X (…) (busId)`, `X model|KV|compute buffer size = N MiB` (sommées par device), `offloaded N/M
  layers`. Nul pour un serveur externe, `idle` ou `crashed`. Diffusé par le message WS `placement`.
- **Phase** : `phaseOf(state, snapshot)` (`shared/`) : arrêté → chargement → inactif → prompt (un slot lit encore son
  prompt) → génération.
- **Scène** (`TopologyScene.tsx`) : dalles arrondies (émission = charge, corps teinté du ton du composant), tubes
  (épaisseur = capacité PCIe), particules instanciées (nombre et vitesse en échelle log du débit, un sens de chaque côté
  du tube), pulsation du lien mémoire ∝ activité CPU. Caméra ajustée au cadre par projection des coins de la scène
  (`fitCamera`, `layout.ts`) pour laisser les coins aux cartes HUD. Couleurs = tokens CSS résolus en RGB via un canvas
  2D (Three ne lit pas `oklch()`).
- **Étiquettes et infobulle** : DOM ordinaire (`Labels.tsx`), ancré chaque image par `<Projector>` sur le sommet des
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
ou que les droits refusent ; après un échec, nouvel essai au plus toutes les 60 s.

## Limites assumées

- Bande passante DRAM : AMD Zen 4/5 seulement pour l'instant ; la part de llama-server ne voit ni les préfetchs
  d'autres cœurs ni les DMA.
- Pas de débit PCIe pour les GPU AMD (absent de sysfs) ni de trafic GPU ↔ GPU (passe par le root complex).
- Le placement dépend du format des logs de llama.cpp (niveau INFO, présent quelle que soit la verbosité) ; après un
  très long run, la ligne de lancement peut être évincée du ring (10 000 lignes) → répartition inconnue jusqu'au
  prochain démarrage.
- Linux uniquement (sysfs).
