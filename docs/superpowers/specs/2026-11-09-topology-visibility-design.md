# Topologie : transferts et utilisation visibles

Complète `2026-11-07-topology-design.md` (architecture, mesures, performances : inchangées).

## Intention

La page doit se **comprendre d'un coup d'œil** : où est le modèle, qui travaille, où ça circule. Les chiffres exacts
viennent en appui. La scène 3D reste. Quatre défauts à corriger : débits peu lisibles (billes minuscules, chiffres
seulement en totaux dans une carte), utilisation peu lisible (une lueur), aucun signal de saturation, scène trop petite
(60 % de la largeur du cadre).

**Échecs à éviter** : des chiffres trompeurs, une scène trop chargée.

Aucun changement serveur, API ou WebSocket : tout vient du `Snapshot` et du `ModelPlacement` existants.

## Décisions

| Sujet  | Décision                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| Blocs  | GPU et mémoire sont des **réservoirs** en verre remplis selon la VRAM / RAM occupée ; barre de charge sur l'étiquette |
| CPU    | **Grille des threads** sur la face supérieure, une tuile par thread, allumée selon sa charge                          |
| Liens  | **Pastille** de débit sur chaque lien actif, **traits lumineux** allongés sur deux voies (un sens par voie)           |
| Cartes | Phase et Model restent, **repliables** en une ligne ; Throughput disparaît ; la légende s'ouvre par un bouton « ? »   |

## Règles

**Honnêteté des chiffres**

- Niveau d'un réservoir : linéaire, égal à la mesure (VRAM utilisée / totale, RAM utilisée / totale).
- Couches d'un GPU, de bas en haut : modèle, cache KV, calcul (logs de chargement), puis autre VRAM (mesure − somme,
  jamais négatif). Si les logs annoncent plus que la mesure (chargement en cours, estimation `-sm tensor`), les trois
  couches sont réduites en proportion : la mesure gagne.
- Seules les couches du modèle portent la couleur du GPU ; « autre » et « utilisée » (répartition inconnue) sont neutres.
- Mémoire : une seule couche. Les poids en `mmap` sont du cache disque, absent de « utilisée ».
- Saturation d'un lien : plus fort des deux sens / capacité du lien dans son état courant. Ambre ≥ 70 %, rouge ≥ 90 %.
  Remplissage : ambre ≥ 85 %, rouge ≥ 95 %. Toute couleur d'alerte a son ratio écrit à côté.
- Les traits gardent l'échelle logarithmique ; la pastille donne la valeur exacte.

**Sobriété**

- Pastille sur tout lien dont le débit mesuré dépasse 100 kB/s pendant que llama-server charge ou génère ; au repos,
  seulement à partir de 8 MiB/s (le trafic de fond d'un GPU inactif, quelques MiB/s, ne fait pas apparaître de
  pastille). Pourcentage de capacité seulement à partir de 25 %. Les infobulles gardent tous les chiffres.
- La pastille d'un lien est empilée sur l'étiquette du composant où il arrive : posée au milieu du lien, elle
  recouvrait ses voisines dès que plusieurs liens partent du CPU, ou que la caméra tourne.
- Mots plutôt que flèches : `→ GPU` / `→ host`, `read` / `write` (NVMe, mémoire), `→ devices` / `→ host` (chipset).
- Étiquettes : GPU = charge + barre + VRAM ; CPU = charge + barre ; mémoire = RAM utilisée ; NVMe = nom seul ;
  chipset = lien courant.
- NVMe et chipset restent des dalles pleines.
- Pas de nouvelle dépendance ni de post-traitement ; rendu à la demande conservé (`FramePacer`).
- Mouvement réduit : pas de traits ni de dérive ; pastilles, réservoirs et jauges restent.
- L'état replié des cartes est gardé par le navigateur ; la caméra ne se recadre pas quand on replie.

## Limites assumées

- En génération, un lien GPU reste sous 1 % de sa capacité : l'alerte de saturation sert surtout au chargement
  (lecture NVMe, envoi vers les GPU) et au lien partagé d'un chipset.
- L'ambre d'alerte est aussi le ton du troisième GPU : sur son lien, c'est la pastille (pourcentage) qui porte l'alerte.
- L'état courant d'un lien NVMe ou chipset est celui lu à l'ouverture de la page.
- Les totaux « tous GPU » de l'ancienne carte Throughput ne sont plus affichés.

## Pair-à-pair entre GPU (ajout en cours de réalisation)

Demande : faire apparaître un lien entre les cartes NVIDIA quand elles sont en mode P2P.

- llama.cpp active le pair-à-pair CUDA dès que `GGML_CUDA_P2P` existe, là où le pilote l'autorise, et n'en écrit rien.
  Le superviseur ajoute donc une ligne après la ligne de lancement (`P2P_LOG_LINE`) quand la variable est dans
  l'environnement du serveur : seul changement serveur de ce lot, avec le champ `p2p` du placement.
- NCCL, avec `NCCL_DEBUG=INFO`, dit ce qui se passe réellement : `Channel … via P2P/…` (direct) ou
  `P2P is disabled between connected GPUs` et `via SHM/…` (par la mémoire de l'hôte). Trois états : `active`,
  `unavailable`, `requested` (demandé, sans confirmation possible).
- Lien pointillé, immobile, entre les cartes d'un même backend qui portent le modèle : net et étiqueté « P2P » quand
  NCCL le confirme, estompé et « P2P requested » sinon, **absent** quand le pilote le refuse (l'état est alors écrit
  dans la carte Model et l'infobulle des cartes). Pas de traits : ce trafic n'est pas mesuré à part, il est compté
  dans le lien PCIe de chaque carte.
- NCCL donne aussi l'adresse PCI de chaque device CUDA : en `-sm tensor`, où llama-server n'en donne aucune, les
  parts du modèle retrouvent leur carte.
- Constat sur la machine de développement (RTX 5070 Ti + 5060 Ti) : `GGML_CUDA_P2P=1` est demandé mais le pilote
  refuse (`nvidia-smi topo -p2p r` : `NS`), les échanges passent par la RAM.
