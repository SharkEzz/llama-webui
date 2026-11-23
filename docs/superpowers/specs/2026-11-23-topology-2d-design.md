# Topology in 2D, two views: design

Decisions marked **(user)** were taken by the user on 2026-11-23; those marked **(call)** are the author's and can be
overturned. A throwaway mockup exists in `.cache/spikes/topology-2d/` (`index.html`, about 1,100 lines, untracked, plus
`measure.ts`): it draws three directions from simulated data, on four machines (`?machine=one|two|four|mine`, the last
one being the user's: two GPUs on the CPU, one behind the chipset, an integrated one), and is the reference for how
each view looks, how it is placed and what it costs. It supersedes the scene of `2026-11-07-topology-design.md` and
`2026-11-09-topology-visibility-design.md`; what those say about the data (graph, placement, phases, levels) still holds.

## Intent

The Topology page draws the machine as a three.js scene. After the fixes of `perf/baseline-lots`, it is still the most
expensive page of the app at rest: 8.4% of a core for the renderer and 12.9% for Chromium's GPU process in the run
`after-lots`, against 3.1% and 6.6% for the Dashboard and 1.2 to 1.5% and about 2% for a plain page. Its chunk, three.js
included, is 973 kB before compression.

The scene becomes an animated 2D drawing that keeps the system information **(user)**. Two views of it ship, the
**card diagram** and the **board plan**, and a control on the page switches between them **(user)**: the diagram
shows the most figures at a glance, the plan looks like a machine.

## Goals

- The page shows what it shows today: every block of the hardware graph, the memory each one holds in layers, the CPU
  threads, the measured traffic of each link in both directions, peer-to-peer between GPUs, the amber and red levels,
  the phase and the model split.
- Two views, **Cards** and **Board**, switched by a control on the page **(user)**. The choice is kept by the browser
  from one visit to the next; a first visit opens Cards **(call)**.
- A block shows the essentials; a click opens its detail **(user)**, with every figure of today's tooltip and the ones
  the snapshot already carries that the page never showed (below).
- Both views place themselves from the graph, whatever the machine: no GPU, one, four, a GPU behind a chipset, an
  integrated GPU, several NVMe drives, several chipsets.
- At rest, the page costs about what the Dashboard costs in the same profiling run, instead of two to three times as
  much (a target to check, not a budget that fails a build); three.js leaves the bundle.

## Non-goals

- The isometric direction of the mockup: not kept **(user)**.
- No camera: no rotation, pan or zoom. The drawing is scaled to the frame **(call)**.
- No new measurement and no API change: nothing under `app/server/` or `packages/webui-shared/` moves. The detail
  panel only reads fields the snapshot already has.
- No layout made for a phone: on a narrow screen the drawing scrolls inside its frame **(call)**.
- No new profiling scenario: the `pages` scenario already measures `/topology` at rest **(call)**.
- The Phase and Model cards keep their content.

## Anti-goals

- A board view that claims to know where a slot is. The app knows the graph (what hangs off the CPU, what hangs off a
  chipset), not the motherboard: the plan is a convention, and the legend and the documentation say so.
- Script that runs per frame for the whole drawing, or a drawing that keeps redrawing when nothing flows: that is what
  made the 3D scene expensive.
- A state carried by color alone, or a figure reachable only by hovering (touch screens, keyboards).
- Two views that drift apart: a figure whose value, level or wording differs from one to the other, or a detail panel
  that is not the same. A view may put fewer figures on its blocks than the other (the board does); what it leaves out
  is in the panel.

## Constraints

- The tests run in Node without a DOM (`vitest.config.ts`, `environment: 'node'`): everything worth testing (placement,
  link geometry, what a streak lane shows) is pure functions; components stay thin.
- `flows.ts` already projects the snapshot onto the graph (`linkFlows`, `nodeLive`, `linkBadge`, `peerLinks`,
  `gpuTones`, `placementSeries`) with 560 lines of tests: it is kept, and both views read it.
- React lint rules of the project (React Compiler rules, no state mirrored in an effect, `useEffectEvent` rather than
  a suppression): the canvas loop is an imperative module driven from one effect, not state.
- The theme is the source of colors (tokens of `@llama-webui/theme`, light and dark); a canvas needs them resolved,
  again on a theme change.
- `prefers-reduced-motion` is honored (`useReducedMotion.ts` exists).
- UI text in English; numbers and units through `app/src/lib/format.ts`.
- The documentation changes in the same PR (table of `site/content/developers/contributing/workflow.mdx`).

## Approaches

1. **HTML blocks, one SVG for the tracks, one canvas for the streaks (chosen).** Blocks are DOM (theme typography,
   real buttons); a link's track is an SVG path; the moving streaks of all links are drawn on a single canvas by one
   timer at 20 frames per second, stopped when no link has traffic to show. Values change once per second, eased by CSS
   transitions in steps. Measured on the mockup (two GPUs, Chromium headless with GPU compositing, % of a core,
   renderer / GPU process): 2.3 / 3.5 at rest and 4.1 / 9.3 while generating for the cards, 2.3 / 3.9 and 4.0 / 9.9
   for the board, against 1.2 / 1.9 for the same page without a view.
2. **One composited element per streak** (`offset-path` animations, no script per frame): the first version of the
   mockup, still behind `?streaks=css`. It keeps the compositor busy at the display's rate for every streak and
   measured higher than one canvas at 20 frames per second; dropped.
3. **Everything on one 2D canvas** (blocks included): cheapest to draw, but text, focus, theme and accessibility would
   all be redone by hand; dropped.
4. **Keep three.js with a flat camera**: keeps the bundle and the per-frame loop that this work removes; dropped.

The user chose the look (cards and board, both in the app); the technique is the author's, from the measurements
**(call)**.

## Design

### Page

`TopologyPage` keeps its frame (full height under the status bar) and its data (`useTopology`, `useMonitor`,
`useServer`, `watchTopology` while the page is shown). The frame has two parts **(call)**:

- A **side column** of fixed width at the right, from top to bottom: the page title with the view control, the
  **Phase** card, the **Model** card, the legend button, and the **detail** of the selected block when there is one.
  The column scrolls on its own when it is taller than the frame.
- The **drawing**, in the room that is left. Nothing is laid over it: a drawing fitted to its frame cannot be moved
  from under a card, and opening or closing the detail never resizes it.

On a narrow frame the column goes above the drawing; where the detail opens there is left to the builder.

- The Phase and Model cards keep their content (`Hud.tsx`) but no longer fold, since they no longer cover anything;
  `hudPrefs.ts` goes with the fold **(call)**.
- The **view control** is a two-option segmented control, `Cards` and `Board`, labelled “View”: it names both views,
  where a single button would only name the other one **(call)**. Its value is stored under one `localStorage` key,
  read like `hudPrefs.ts` reads its own today (anything unreadable means Cards).
- Only the selected view is mounted. Switching is immediate; the detail stays open on the same block.
- “Recenter view”, the mouse hint and the WebGL error boundary go.
- The drawing has a natural size computed by its layout and is scaled to its room, between a minimum scale under which
  it scrolls instead and a maximum so a small machine does not blow up **(call: bounds left to the builder, about 0.75
  and 1.5)**.

### What both views share

- **Model**: `flows.ts`, unchanged in behavior. It gains the rows the detail adds (below) and exports the Gen and
  width label it already builds.
- **Blocks** are buttons. What a block can show is what `nodeLive` gives today: its name, headline, bar, second line,
  and for a tank its layers (model, KV cache, compute, other; one “used” layer without a placement, and always for
  the memory) as stacked bars filled by a `transform`, with the amber and red levels of `FILL_WARN_PCT` and
  `FILL_CRIT_PCT` spelled out in text. The CPU shows one tile per thread. A hidden or suspended card is dimmed and
  says why. The mockup's memory bar split between llama-server and the rest is not taken: resident memory is not a
  part of “used” (mapped weights are page cache).
- **Links**: a track per link of the graph, in the tone of its level (`LINK_WARN`, `LINK_CRIT`). A PCIe link carries
  a small permanent label with its current generation and width, as in the mockup **(call)**: it is what tells a
  downgraded link at rest. The lines of `linkBadge` (throughput per direction, share of the capacity once it matters)
  appear under that label while the link has traffic to show; the memory link has no permanent label, only those
  lines. The layout provides the anchor. A dashed track and its “P2P” or “P2P requested” tag per `peerLinks`. A link
  of kind `internal` (an integrated GPU) is a plain track: no label, no streaks.
- **Streaks**: for each link that `linkShown` lets through, streaks run along the track in each measured direction,
  drawn on the view's one canvas at 20 frames per second. Their parameters are the mockup's, the ones that were
  measured **(call)**: one to eight streaks per lane and never more than the track has room for, a speed in pixels per
  second on the log scale of today's `flowVisual` (from `FLOOR_BPS` to 20 GB/s), a fixed length. The track's own
  intensity follows the same scale. No link shown: the timer is stopped and the canvas is clear. Reduced motion: the
  timer never starts; the labels still say what flows.
- **Memory link without a bandwidth measurement** (no perf access): today it pulses at a rate that follows
  `activity`. In 2D its track takes an intensity that follows `activity`, updated with each sample, without a pulse
  **(call)**: with no managed server `activity` is the machine's CPU load, never zero, and a pulse would animate the
  page at rest. The legend and the memory's fact keep saying that the link shows CPU activity.
- **Detail**: a click, Enter or Space on a block opens its detail in the side column: the block's name and all its
  figures, live; Escape, its close button or a second click closes it; the selected block is marked. It replaces the
  hover tooltip. Rows added to today's facts, each only when the snapshot has the value: for a GPU, VRAM held by
  llama-server (`procVramBytes`), memory controller (`memUtilPct`), fan (`fanPct`), power limit (`powerLimitW`, and
  the factory limit when it differs), graphics and memory clocks (`clockGrMhz`, `clockMemMhz`); for the CPU, the load
  average (`load`); for the memory, the page cache (`cachedBytes`).
- **Easing**: fills, bars and tiles change by CSS transitions in a few steps (not a continuous animation); none under
  reduced motion.

### Cards

Glass cards like the Dashboard's, linked by curves.

- Rows by depth in the graph: the CPU on top with the memory at its left and an integrated GPU at its right (it is
  part of the CPU, not a device in a slot), the devices of the CPU's root ports below
  (GPUs, then NVMe drives, then chipsets, each by bus address, the order of today's `layoutGraph`), the devices of a
  chipset one row further, centered under it and shifted when two chipsets would collide.
- A row sits one gap below the tallest card of the row above; the links and their badges live in that gap. A link
  leaves the bottom of its parent, drops, crosses inside the gap and arrives on top of its card; its badge sits in the
  gap beside the arrival.
- A GPU card: utilization with its bar, VRAM with its layers, temperature and power. CPU: load, thread tiles,
  temperature, frequency. Memory: used and its bar. An integrated GPU: utilization, VRAM and its bar, in a card the
  size of the memory's. NVMe: read and write. Chipset: device count
  and share of its link to the CPU.
- A row has no fixed width: the natural width of the drawing is that of its widest row, and the page scales it.

### Board

A top view of a motherboard, by convention: the socket in the upper middle with the thread tiles in it, the DIMMs
standing at its right as vertical tanks, one horizontal slot per GPU below the socket (those of the CPU first, then
those of a chipset), the chipset at the lower right with its NVMe drives under it, the NVMe drives of the CPU as
sticks at the socket's left.

- Tracks run at right angles with rounded corners, each in its own channel so that no two cross: a port further right
  on the socket turns higher and runs further right.
- A GPU in its slot shows its name, utilization, VRAM, temperature and power on one line above its tank; its link's
  label sits at the left end of the slot. The other parts show less than their card does (an NVMe stick has its name
  and one rate, the socket has the load and the temperature): the rest is in the detail.
- What the graph has that a board picture has no place for by convention: an integrated GPU is a small part beside
  the socket, under the CPU's drives, on a short plain track, not a slot; a second chipset stacks under the first; an
  unlinked block goes after the last slot, so it stays visible.
- The DIMM count comes from the memory block's detail (`dimms`) when it is known; otherwise two populated slots are
  drawn.

### Code

In `app/src/features/topology/`:

| File                                                                        | Role                                                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `flows.ts`                                                                  | Kept; the detail rows are added to it.                                                                                                                       |
| `smooth.ts`                                                                 | `FLOOR_BPS` kept (`flows.ts` reads it), moved if the file has nothing else left; `Smoother` and the 3D `flowVisual` go, the log scale lives in `streaks.ts`. |
| `geometry.ts` (new)                                                         | Pure: a curve or a rounded right-angle route as an SVG path and as sampled points with lengths.                                                              |
| `layoutCards.ts`, `layoutBoard.ts` (new)                                    | Pure: graph → natural size, a rectangle per block, a path and a badge anchor per link, a path per peer link.                                                 |
| `streaks.ts` (new)                                                          | Pure lane model (which streaks, where, at a given time) and the canvas loop that draws it.                                                                   |
| `CardsView.tsx`, `BoardView.tsx` (new)                                      | Thin: the blocks of one view at the rectangles of its layout.                                                                                                |
| `Stage.tsx` (new)                                                           | Shared: the fit to the frame, the SVG tracks, badges, peer tags, the canvas, selection.                                                                      |
| `Detail.tsx` (new)                                                          | The detail panel.                                                                                                                                            |
| `viewPrefs.ts` (new)                                                        | The stored view, replacing `hudPrefs.ts`.                                                                                                                    |
| `themeColors.ts`                                                            | Rewritten without three.js: the colors the canvas needs, resolved from the tokens.                                                                           |
| `Hud.tsx`, `TopologyPage.tsx`                                               | Adapted as above.                                                                                                                                            |
| `TopologyScene.tsx`, `Labels.tsx`, `layout.ts`, `pacing.ts` and their tests | Removed.                                                                                                                                                     |

`three`, `@react-three/fiber`, `@react-three/drei` and `@types/three` leave `app/package.json` and the lockfile.

### Tests

- Layouts, on fixture graphs (no GPU; one; two with one behind a chipset; four; an integrated GPU on an `internal`
  link; two NVMe drives; two chipsets; an unlinked block): deterministic, every block placed, no two rectangles
  overlap, every link has a path that starts and ends on its blocks, no badge anchor inside a rectangle, and on the
  board no two tracks cross.
- Geometry: lengths and sampled points of a curve and of a route.
- Streaks: no lane for a link under the floor, more and faster streaks with more throughput, both directions, nothing
  to draw at all when no link is shown.
- `flows.ts`: the added detail rows, present only with their value.
- The stored view: an unreadable value means Cards.

### Outside the feature

- Documentation, same PR: `site/content/docs/topology.mdx` (rewritten: two views, the control, the detail panel, no
  camera, no WebGL section), `docs/getting-started/requirements.mdx` (WebGL no longer needed),
  `developers/frontend.mdx` (file table, the three.js chunk), `developers/architecture.mdx` (the three.js mention).
- `README.md` (the “3D hardware topology” section, its image `docs/assets/screenshots/topology.jpg`, the
  react-three-fiber credit) and the landing page (`site/src/landing/sections/MonitoringSection.tsx`: “Your machine,
  in 3D” and its image text).
- Screenshots: `topology-{dark,light}[-800].webp` retaken, and a second pair for the board view
  (`site/scripts/shots.ts` sets the stored view) **(call)**. They need the demo instance with a model on the GPUs:
  done with the user.
- Measure: `pnpm profiling pages --name topology-before` on the branch point, the same with `--name topology-after
  --compare topology-before` at the end; the cost while generating, which no scenario covers, once by hand with the
  mockup's `measure.ts` pointed at the page.

## Left to the builder

- Sizes, gaps and scale bounds, starting from the mockup's.
- Where the detail panel sits in a narrow frame.
- How `Stage.tsx` and the two views split the markup, as long as the views hold nothing but their blocks.
- The order of the work. A possible one: geometry, layouts and streak model with their tests; the stage, the cards
  view and the detail panel behind the control while the 3D scene still exists; the board view; removal of the scene
  and of three.js; documentation, landing page, README; screenshots and measures.
