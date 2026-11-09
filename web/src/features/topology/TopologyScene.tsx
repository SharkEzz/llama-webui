import type { TopologyGraph, TopologyLink, TopologyNode } from '@llama-webui/shared';
import { OrbitControls, RoundedBox, Tube } from '@react-three/drei';
import { advance, Canvas, useFrame, useThree } from '@react-three/fiber';
import { type ComponentRef, type RefObject, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  Color,
  type InstancedMesh,
  type Mesh,
  type MeshStandardMaterial,
  Object3D,
  QuadraticBezierCurve3,
  Vector3,
} from 'three';
import type { Tone } from '@/components/glass/tones';
import type { LayerKind, LinkFlow, NodeLive, PeerLink } from './flows';
import {
  type Bounds,
  FOV_DEG,
  fitCamera,
  type Layout,
  type LinkPath,
  type Placed,
  pathPoint,
  peerPath,
  type Vec3,
} from './layout';
import { FramePacer } from './pacing';
import { flowVisual, MAX_STREAKS, Smoother } from './smooth';
import { LAYER_TINT, type SceneColors } from './themeColors';

/*
 * 3D scene: blocks (components) joined by tubes (links) carrying streaks (measured throughput). GPUs and memory are
 * glass tanks filled to the memory in use; the CPU shows its threads on its top face.
 * Labels (with the traffic of each block's link) and the tooltip are DOM (the <Labels> layer, outside the canvas):
 * theme typography, tokens and contrast. The scene positions them itself on every frame (<Projector>): no portal per
 * label (drei <Html> loses the first one under React 19 in strict mode).
 */

export interface TopologySceneProps {
  graph: TopologyGraph;
  layout: Layout;
  flows: Map<string, LinkFlow>;
  /** Peer-to-peer connections between GPUs (dotted, not measured). */
  peers: PeerLink[];
  live: Map<string, NodeLive>;
  tones: Map<string, Tone>;
  colors: SceneColors;
  reducedMotion: boolean;
  hovered: string | null;
  onHover: (id: string | null) => void;
  /** DOM label layer (`data-node` elements), moved on every frame. */
  labelLayer: RefObject<HTMLDivElement | null>;
  /** Filled in by the scene: camera recentering. */
  view: RefObject<SceneView | null>;
  /** The camera left (true) or returned to (false) its initial framing. */
  onViewMoved: (moved: boolean) => void;
}

/** Reference capacity for tube thickness: Gen5 x16. */
const REF_BPS = 16 * 3.938e9;

export function TopologyScene(p: TopologySceneProps) {
  const smoother = useMemo(() => new Smoother(0.4), []);
  const pacer = useMemo(() => new FramePacer(), []);
  // An input changed: a frame as soon as possible, then running smoothings keep the pace (see FramePacer).
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggers, the scene reads these values on the next frame
  useEffect(() => {
    pacer.requested = true;
  }, [pacer, p.flows, p.peers, p.live, p.tones, p.colors, p.hovered, p.layout, p.reducedMotion]);
  const byId = useMemo(() => new Map(p.graph.nodes.map((n) => [n.id, n])), [p.graph]);
  const peerPaths = useMemo(() => {
    const out = new Map<string, LinkPath>();
    for (const peer of p.peers) {
      const from = p.layout.nodes.get(peer.from);
      const to = p.layout.nodes.get(peer.to);
      if (from && to) out.set(peer.id, peerPath(from, to));
    }
    return out;
  }, [p.peers, p.layout]);
  const nodeColor = (n: TopologyNode): Color => {
    const tone = p.tones.get(n.id);
    if (tone) return p.colors.tone[tone];
    return n.kind === 'cpu' ? p.colors.primary : p.colors.neutral;
  };
  return (
    <Canvas
      frameloop="never"
      gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
      dpr={[1, 1.5]}
      camera={{ fov: FOV_DEG, near: 0.1, far: 200, position: [0, 12, 14] }}
      style={{ position: 'absolute', inset: 0 }}
      className="cursor-grab active:cursor-grabbing"
      onPointerMissed={() => p.onHover(null)}
    >
      <FrameDriver pacer={pacer} smoother={smoother} />
      <Rig
        bounds={p.layout.bounds}
        drift={!p.reducedMotion}
        view={p.view}
        onMovedChange={p.onViewMoved}
        pacer={pacer}
      />
      <Projector layout={p.layout} peerPaths={peerPaths} layer={p.labelLayer} />
      <ambientLight intensity={p.colors.dark ? 0.55 : 0.85} />
      <directionalLight position={[6, 12, 8]} intensity={p.colors.dark ? 1.2 : 1.5} />
      <directionalLight position={[-8, 6, -6]} intensity={0.4} />
      {p.graph.nodes.map((n) => {
        const placed = p.layout.nodes.get(n.id);
        const live = p.live.get(n.id);
        if (!placed || !live) return null;
        return (
          <NodeBlock
            key={n.id}
            node={n}
            placed={placed}
            live={live}
            color={nodeColor(n)}
            colors={p.colors}
            hovered={p.hovered === n.id}
            onHover={p.onHover}
            smoother={smoother}
          />
        );
      })}
      {p.graph.links.map((l) => {
        const path = p.layout.paths.get(l.id);
        const toNode = byId.get(l.to);
        const flow = p.flows.get(l.id);
        if (!path || !toNode || !flow) return null;
        return (
          <Link
            key={l.id}
            link={l}
            path={path}
            flow={flow}
            color={nodeColor(toNode)}
            colors={p.colors}
            reducedMotion={p.reducedMotion}
            smoother={smoother}
            pacer={pacer}
          />
        );
      })}
      {p.peers.map((peer) => {
        const path = peerPaths.get(peer.id);
        return path && <PeerDots key={peer.id} path={path} confirmed={peer.confirmed} colors={p.colors} />;
      })}
    </Canvas>
  );
}

/** Camera damping after a gesture: it dies out in under a second (factor 0.12 per frame). */
const DAMPING_MS = 1000;

/**
 * Render loop (frameloop “never”): on every rAF, a frame only if the pacer asks for one. A hidden tab no longer gets
 * rAFs: nothing is drawn.
 */
function FrameDriver({ pacer, smoother }: { pacer: FramePacer; smoother: Smoother }) {
  const get = useThree((s) => s.get);
  const size = useThree((s) => s.size);
  // Resizing clears the canvas: draw a frame right away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `size` is the trigger
  useEffect(() => {
    pacer.requested = true;
  }, [pacer, size]);
  useEffect(() => {
    let raf = requestAnimationFrame(function tick(now) {
      raf = requestAnimationFrame(tick);
      if (!pacer.shouldRender(now)) return;
      // With frameloop “never”, the scene clock follows the time passed in here, in seconds.
      advance(now / 1000, true, get());
      pacer.rendered(now, smoother.takeMoving());
    });
    return () => cancelAnimationFrame(raf);
  }, [pacer, smoother, get]);
  return null;
}

/** Camera control from the DOM (the “Recenter view” button). */
export interface SceneView {
  reset: () => void;
}

/** Duration of the return to the initial framing (s). */
const RESET_S = 0.6;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface RigProps {
  bounds: Bounds;
  drift: boolean;
  view: RefObject<SceneView | null>;
  onMovedChange: (moved: boolean) => void;
  pacer: FramePacer;
}

/**
 * 3/4-view camera fitted to the frame, with a very slow drift (disabled under prefers-reduced-motion). Drag rotates,
 * right-click (or two fingers) pans, the wheel zooms: once the user takes over, the camera stays where they left it
 * (no drift, no refit on resize) until “Recenter view”, which eases it back.
 */
function Rig({ bounds, drift, view, onMovedChange, pacer }: RigProps) {
  const { camera, size } = useThree();
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const cam = useMemo(() => fitCamera(bounds, size.width / Math.max(1, size.height)), [bounds, size]);
  const fitDist = useMemo(() => Math.hypot(...sub3(cam.position, cam.target)), [cam]);
  const moved = useRef(false);
  // Animated return: starting pose and progress (0 → 1), null when not animating.
  const back = useRef<{ pos: Vector3; target: Vector3; t: number } | null>(null);

  useEffect(() => {
    view.current = {
      reset: () => {
        const c = controls.current;
        if (!c) return;
        moved.current = false;
        back.current = drift ? { pos: camera.position.clone(), target: c.target.clone(), t: 0 } : null;
        pacer.requested = true;
        onMovedChange(false);
      },
    };
    return () => {
      view.current = null;
    };
  }, [view, camera, drift, onMovedChange, pacer]);

  // After the controls (priority -1, which apply the damping): the resting pose wins as long as the user has not
  // taken over.
  useFrame(({ clock }, dt) => {
    const c = controls.current;
    pacer.drift = drift && !moved.current;
    if (!c || moved.current) return;
    const t = drift ? clock.elapsedTime : 0;
    goalPos.set(
      cam.position[0] + Math.sin(t * 0.11) * 0.7,
      cam.position[1] + Math.sin(t * 0.07) * 0.35,
      cam.position[2] + Math.cos(t * 0.09) * 0.5,
    );
    goalTarget.set(cam.target[0], cam.target[1], cam.target[2]);
    const b = back.current;
    if (b) {
      b.t = Math.min(1, b.t + dt / RESET_S);
      const k = easeInOut(b.t);
      goalPos.lerpVectors(b.pos, goalPos, k);
      goalTarget.lerpVectors(b.target, goalTarget, k);
      if (b.t >= 1) back.current = null;
      else pacer.active = true;
    }
    camera.position.copy(goalPos);
    c.target.copy(goalTarget);
    camera.lookAt(goalTarget);
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping={drift}
      dampingFactor={0.12}
      minDistance={fitDist * 0.25}
      maxDistance={fitDist * 2.5}
      // Stay above the floor: never go under the slabs.
      maxPolarAngle={Math.PI / 2 - 0.05}
      onStart={() => {
        pacer.interacting = true;
        back.current = null;
        if (moved.current) return;
        moved.current = true;
        onMovedChange(true);
      }}
      onEnd={() => {
        pacer.interacting = false;
        if (drift) pacer.hold(performance.now(), DAMPING_MS);
        else pacer.requested = true;
      }}
    />
  );
}

const goalPos = new Vector3();
const goalTarget = new Vector3();
const sub3 = (a: readonly number[], b: readonly number[]) => a.map((v, i) => v - b[i]!);

const projected = new Vector3();

interface ProjectorProps {
  layout: Layout;
  peerPaths: Map<string, LinkPath>;
  layer: RefObject<HTMLDivElement | null>;
}

/**
 * Projects the top of each block and the middle of each peer-to-peer link onto the screen, and anchors their DOM label
 * there (bypassing React, every frame).
 */
function Projector({ layout, peerPaths, layer }: ProjectorProps) {
  const { camera, size } = useThree();
  const els = useRef(new Map<string, HTMLElement>());
  const anchors = useMemo(() => {
    const out: { selector: string; at: Vec3 }[] = [];
    for (const [id, placed] of layout.nodes) {
      // The CPU's label sits behind its top face, which shows its threads.
      const back = id === 'cpu' ? placed.size[2] / 2 : 0;
      out.push({
        selector: `[data-node="${CSS.escape(id)}"]`,
        at: [placed.pos[0], placed.size[1] + 0.1, placed.pos[2] - back],
      });
    }
    for (const [id, path] of peerPaths)
      out.push({ selector: `[data-peer="${CSS.escape(id)}"]`, at: pathPoint(path, 0.5) });
    return out;
  }, [layout, peerPaths]);
  useFrame(() => {
    const root = layer.current;
    if (!root) return;
    for (const { selector, at } of anchors) {
      let el = els.current.get(selector);
      if (!el?.isConnected) {
        // A peer-to-peer tag only exists while its link does.
        el = root.querySelector<HTMLElement>(selector) ?? undefined;
        if (!el) continue;
        els.current.set(selector, el);
      }
      projected.set(at[0], at[1], at[2]).project(camera);
      const x = (projected.x * 0.5 + 0.5) * size.width;
      const y = (0.5 - projected.y * 0.5) * size.height;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.style.visibility = projected.z < 1 ? 'visible' : 'hidden';
      // No room above for the hovered block's tooltip: it moves below the label (see Labels).
      const stack = el.firstElementChild as HTMLElement | null;
      const tip = stack?.querySelector<HTMLElement>(':scope > dl');
      el.classList.toggle('tip-below', !!stack && !!tip && y - stack.offsetHeight - tip.offsetHeight < 16);
    }
  });
  return null;
}

interface NodeBlockProps {
  node: TopologyNode;
  placed: Placed;
  live: NodeLive;
  color: Color;
  colors: SceneColors;
  hovered: boolean;
  onHover: (id: string | null) => void;
  smoother: Smoother;
}

function NodeBlock({ node, placed, live, color, colors, hovered, onHover, smoother }: NodeBlockProps) {
  // GPUs and memory are tanks: a glass shell around the memory in use. The other blocks are solid.
  const tank = node.kind === 'gpu' || node.kind === 'ram';
  const mat = useRef<MeshStandardMaterial>(null);
  const liveRef = useRef(live);
  const hoveredRef = useRef(hovered);
  useEffect(() => {
    liveRef.current = live;
    hoveredRef.current = hovered;
  }, [live, hovered]);
  useFrame((_, dt) => {
    const m = mat.current;
    if (!m) return;
    const l = liveRef.current;
    // A tank's contents carry its load; its shell only keeps a faint glow of its own.
    const target = l.dim ? 0.04 : tank ? 0.18 : 0.15 + 0.85 * Math.min(1, (l.loadPct ?? 0) / 100);
    m.emissiveIntensity = smoother.step(`${node.id}:glow`, target, dt) * (hoveredRef.current ? 1.6 : 1);
  });
  const [w, h, d] = placed.size;
  const [x, , z] = placed.pos;
  // The block body takes on a bit of its tone (more in the light theme, where emission alone barely shows).
  const body = useMemo(() => colors.slab.clone().lerp(color, colors.dark ? 0.2 : 0.45), [colors, color]);
  const opacity = tank ? (live.dim ? 0.12 : colors.dark ? 0.26 : 0.34) : live.dim ? 0.4 : 0.94;
  return (
    <group position={[x, h / 2, z]}>
      <RoundedBox
        args={[w, h, d]}
        radius={0.09}
        smoothness={4}
        onPointerOver={(e) => {
          e.stopPropagation();
          onHover(node.id);
        }}
        onPointerOut={() => onHover(null)}
      >
        <meshStandardMaterial
          ref={mat}
          color={body}
          emissive={color}
          emissiveIntensity={0.1}
          roughness={0.42}
          metalness={0.15}
          transparent
          opacity={opacity}
          depthWrite={!tank}
        />
      </RoundedBox>
      {tank && !live.dim && (
        <TankFill id={node.id} size={placed.size} live={live} color={color} colors={colors} smoother={smoother} />
      )}
      {node.kind === 'cpu' && live.cores.length > 0 && (
        <CoreGrid
          key={live.cores.length}
          id={node.id}
          size={placed.size}
          cores={live.cores}
          colors={colors}
          smoother={smoother}
        />
      )}
    </group>
  );
}

/** Gap between a tank's shell and its contents. */
const TANK_INSET = 0.08;
/** Slot of each layer kind, from the bottom up; “other” and “used” (split unknown) share the last, neutral one. */
const SLOT: Record<LayerKind, number> = { model: 0, kv: 1, compute: 2, other: 3, used: 3 };
const SLOTS = [0, 1, 2, 3] as const;
const WHITE = new Color('#ffffff');
/** Objects inside a tank let the pointer through to its shell, which carries the hover. */
const noRaycast = () => null;

interface TankFillProps {
  id: string;
  size: Vec3;
  live: NodeLive;
  color: Color;
  colors: SceneColors;
  smoother: Smoother;
}

/**
 * Contents of a tank: one box per layer, stacked from the floor of the shell. The total height is the measured fill,
 * on a linear scale; the glow follows the load. A thin surface closes the liquid and carries the fill alert.
 */
function TankFill({ id, size, live, color, colors, smoother }: TankFillProps) {
  const [w, h, d] = size;
  const inner: Vec3 = [w - 2 * TANK_INSET, h - 2 * TANK_INSET, d - 2 * TANK_INSET];
  const boxes = useRef<(Mesh | null)[]>([]);
  const surface = useRef<Mesh>(null);
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);
  // The model keeps the block's full tone, its KV cache and compute buffers lighter shades; the rest is neutral.
  const shades = useMemo(
    () => [
      color.clone().lerp(WHITE, LAYER_TINT.model),
      color.clone().lerp(WHITE, LAYER_TINT.kv),
      color.clone().lerp(WHITE, LAYER_TINT.compute),
      colors.neutral.clone().lerp(colors.slab, colors.dark ? 0.62 : 0.5),
    ],
    [color, colors],
  );
  useFrame((_, dt) => {
    const l = liveRef.current;
    const load = smoother.step(`${id}:load`, Math.min(1, (l.loadPct ?? 0) / 100), dt);
    let y = -inner[1] / 2;
    for (const slot of SLOTS) {
      const pct = l.layers.reduce((s, x) => (SLOT[x.kind] === slot ? s + x.pct : s), 0);
      const height = smoother.step(`${id}:layer:${slot}`, Math.min(1, pct / 100), dt) * inner[1];
      const box = boxes.current[slot];
      if (!box) continue;
      box.visible = height > 1e-3;
      box.scale.set(inner[0], Math.max(height, 1e-3), inner[2]);
      box.position.y = y + height / 2;
      (box.material as MeshStandardMaterial).emissiveIntensity = slot === 3 ? 0.04 + 0.16 * load : 0.3 + 0.7 * load;
      y += height;
    }
    const top = surface.current;
    if (top) {
      top.visible = y > -inner[1] / 2 + 1e-3;
      top.position.y = y + 0.012;
    }
  });
  const alert = live.fillLevel === 'crit' ? colors.critical : live.fillLevel === 'warn' ? colors.warning : null;
  // Colors mix in linear space, where a little of a bright tone goes a long way.
  const empty = useMemo(() => colors.slab.clone().lerp(color, colors.dark ? 0.02 : 0.12), [colors, color]);
  return (
    <>
      {SLOTS.map((slot) => (
        <mesh
          key={slot}
          ref={(m) => {
            boxes.current[slot] = m;
          }}
          visible={false}
          raycast={noRaycast}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial
            color={shades[slot]}
            emissive={shades[slot]}
            emissiveIntensity={0.3}
            roughness={0.5}
            metalness={0.05}
          />
        </mesh>
      ))}
      <mesh ref={surface} visible={false} raycast={noRaycast}>
        <boxGeometry args={[inner[0], 0.024, inner[2]]} />
        {/* Seen from above, a bright surface would make a shallow tank look full: it takes the color of an empty tank,
            so the level reads on the sides. */}
        <meshBasicMaterial color={alert ?? empty} toneMapped={false} />
      </mesh>
    </>
  );
}

interface CoreGridProps {
  id: string;
  size: Vec3;
  cores: number[];
  colors: SceneColors;
  smoother: Smoother;
}

const tile = new Object3D();
const tileColor = new Color();

/** One tile per CPU thread on the top face, lit with the thread's load. Remounted when the thread count changes. */
function CoreGrid({ id, size, cores, colors, smoother }: CoreGridProps) {
  const [w, h, d] = size;
  const n = cores.length;
  const mesh = useRef<InstancedMesh>(null);
  const coresRef = useRef(cores);
  useEffect(() => {
    coresRef.current = cores;
  }, [cores]);
  const off = useMemo(() => colors.slab.clone().lerp(colors.primary, colors.dark ? 0.16 : 0.1), [colors]);
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const margin = 0.16;
    const cols = Math.ceil(Math.sqrt((n * w) / d));
    const rows = Math.ceil(n / cols);
    const cell = Math.min((w - 2 * margin) / cols, (d - 2 * margin) / rows);
    for (let i = 0; i < n; i++) {
      tile.position.set((-(cols - 1) / 2 + (i % cols)) * cell, 0, (-(rows - 1) / 2 + Math.floor(i / cols)) * cell);
      tile.scale.set(cell * 0.82, 1, cell * 0.82);
      tile.updateMatrix();
      m.setMatrixAt(i, tile.matrix);
      // Colors exist before the first frame: the material is compiled with them.
      m.setColorAt(i, off);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [n, w, d, off]);
  useFrame((_, dt) => {
    const m = mesh.current;
    if (!m) return;
    for (let i = 0; i < n; i++) {
      const k = smoother.step(`${id}:core:${i}`, Math.min(1, (coresRef.current[i] ?? 0) / 100), dt);
      m.setColorAt(i, tileColor.copy(off).lerp(colors.primary, k));
    }
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, n]}
      position={[0, h / 2 + 0.02, 0]}
      frustumCulled={false}
      raycast={noRaycast}
    >
      <boxGeometry args={[1, 0.04, 1]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

interface LinkProps {
  link: TopologyLink;
  path: LinkPath;
  flow: LinkFlow;
  color: Color;
  colors: SceneColors;
  reducedMotion: boolean;
  smoother: Smoother;
  pacer: FramePacer;
}

const LEVEL_STEP = { ok: 0, warn: 1, crit: 2 } as const;
const tint = new Color();

function Link({ link, path, flow, color, colors, reducedMotion, smoother, pacer }: LinkProps) {
  const neutral = color === colors.neutral;
  const curve = useMemo(
    () => new QuadraticBezierCurve3(new Vector3(...path.start), new Vector3(...path.ctrl), new Vector3(...path.end)),
    [path],
  );
  const radius =
    link.kind === 'memory'
      ? 0.16
      : link.kind === 'internal'
        ? 0.05
        : 0.07 + 0.15 * Math.sqrt(Math.min(1, (flow.maxBps ?? 0) / REF_BPS));

  const mat = useRef<MeshStandardMaterial>(null);
  const flowRef = useRef(flow);
  useEffect(() => {
    flowRef.current = flow;
  }, [flow]);
  useFrame(({ clock }, dt) => {
    const m = mat.current;
    if (!m) return;
    const f = flowRef.current;
    // Near its capacity the link leaves its own color for the alert ones (0 = ok, 1 = warning, 2 = critical).
    const level = smoother.step(`${link.id}:level`, LEVEL_STEP[f.level], dt);
    tint.copy(color);
    if (level > 1) tint.copy(colors.warning).lerp(colors.critical, level - 1);
    else if (level > 0) tint.lerp(colors.warning, level);
    m.emissive.copy(tint);
    let target: number;
    if (link.kind === 'memory' && f.fwdBps === null && f.backBps === null) {
      // Without a DRAM measurement: a pulse whose rate follows CPU activity (0–100); without animation, a fixed intensity.
      const a = Math.min(1, (f.activity ?? 0) / 100);
      if (!reducedMotion && a > 0) pacer.active = true;
      target = reducedMotion
        ? 0.08 + 0.6 * a
        : 0.08 + a * (0.35 + 0.35 * Math.abs(Math.sin(clock.elapsedTime * (1 + 4 * a))));
    } else {
      const total = (f.fwdBps ?? 0) + (f.backBps ?? 0);
      target = 0.08 + (neutral ? 0.35 : 0.8) * flowVisual(total > 0 ? total : null).glow + 0.25 * Math.min(1, level);
    }
    m.emissiveIntensity = smoother.step(`${link.id}:glow`, target, dt);
  });

  // The two directions run side by side inside the tube, which does not write depth so they show through it.
  const lane = radius * 0.5 + 0.02;
  const thickness = Math.min(0.055, Math.max(0.035, radius * 0.3));
  return (
    <group>
      <Tube args={[curve, 40, radius, 10, false]}>
        <meshStandardMaterial
          ref={mat}
          color={colors.tube}
          emissive={color}
          emissiveIntensity={0.08}
          roughness={0.5}
          metalness={0.1}
          transparent
          opacity={link.kind === 'internal' ? 0.25 : 0.42}
          depthWrite={false}
        />
      </Tube>
      {!reducedMotion && link.kind !== 'internal' && (
        <>
          <Streaks
            id={`${link.id}:fwd`}
            curve={curve}
            bps={flow.fwdBps}
            color={color}
            reverse={false}
            side={lane}
            thickness={thickness}
            smoother={smoother}
            pacer={pacer}
          />
          <Streaks
            id={`${link.id}:back`}
            curve={curve}
            bps={flow.backBps}
            color={color}
            reverse
            side={-lane}
            thickness={thickness}
            smoother={smoother}
            pacer={pacer}
          />
        </>
      )}
    </group>
  );
}

interface StreaksProps {
  id: string;
  curve: QuadraticBezierCurve3;
  bps: number | null;
  color: Color;
  /** Downstream → upstream direction. */
  reverse: boolean;
  /** Lateral offset (units) so the two directions do not overlap. */
  side: number;
  /** Radius of a streak (units). */
  thickness: number;
  smoother: Smoother;
  pacer: FramePacer;
}

const UP = new Vector3(0, 1, 0);
const tmpPoint = new Vector3();
const tmpTangent = new Vector3();

/**
 * Streaks along one lane of a link: elongated along the curve, their count, length and speed on a log scale of the
 * throughput (see flowVisual), smoothed.
 */
function Streaks({ id, curve, bps, color, reverse, side, thickness, smoother, pacer }: StreaksProps) {
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  // Initial offset of each streak, deterministic (Weyl sequence): adding one does not move the others.
  const offsets = useMemo(() => Array.from({ length: MAX_STREAKS }, (_, i) => (i * 0.6180339887) % 1), []);
  const span = useMemo(() => curve.getLength(), [curve]);
  const bpsRef = useRef(bps);
  const phase = useRef(0);
  useEffect(() => {
    bpsRef.current = bps;
  }, [bps]);
  useFrame((_, dt) => {
    const m = mesh.current;
    if (!m) return;
    const vis = flowVisual(bpsRef.current);
    const speed = smoother.step(`${id}:speed`, vis.speed, dt);
    const length = Math.min(smoother.step(`${id}:length`, vis.length, dt), span * 0.3);
    // Streaks never cover more than half the lane: on a short link they would merge into a solid bar.
    const room = length > 0 ? Math.max(1, Math.floor((span * 0.5) / length)) : 0;
    const n = Math.min(room, Math.round(smoother.step(`${id}:n`, vis.count, dt)));
    phase.current = (phase.current + speed * dt) % 1;
    if (n > 0) pacer.active = true;
    m.count = n;
    for (let i = 0; i < n; i++) {
      let u = (offsets[i]! + phase.current) % 1;
      if (reverse) u = 1 - u;
      curve.getPointAt(u, tmpPoint);
      curve.getTangentAt(u, tmpTangent);
      // Horizontal perpendicular to the tangent: the two directions run side by side.
      const len = Math.hypot(tmpTangent.x, tmpTangent.z) || 1;
      dummy.position.set(
        tmpPoint.x + (tmpTangent.z / len) * side,
        tmpPoint.y,
        tmpPoint.z - (tmpTangent.x / len) * side,
      );
      dummy.quaternion.setFromUnitVectors(UP, tmpTangent);
      // A streak grows out of one end and shrinks into the other instead of popping in and out.
      const ends = Math.min(1, 8 * u, 8 * (1 - u));
      dummy.scale.set(thickness * ends, (length / 2) * ends, thickness * ends);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, MAX_STREAKS]}
      count={0}
      frustumCulled={false}
      renderOrder={1}
      raycast={noRaycast}
    >
      <sphereGeometry args={[1, 10, 10]} />
      <meshBasicMaterial color={color} transparent opacity={0.95} toneMapped={false} />
    </instancedMesh>
  );
}

/** Spacing of the dots of a peer-to-peer link (units). */
const DOT_GAP = 0.2;

/**
 * Peer-to-peer link between two GPUs: a dotted line, still. Dotted because nothing measures what it carries (that
 * traffic is part of each card's own link figures); fainter when the launch only requested it and nothing confirms it.
 */
function PeerDots({ path, confirmed, colors }: { path: LinkPath; confirmed: boolean; colors: SceneColors }) {
  const mesh = useRef<InstancedMesh>(null);
  const points = useMemo(() => {
    const curve = new QuadraticBezierCurve3(
      new Vector3(...path.start),
      new Vector3(...path.ctrl),
      new Vector3(...path.end),
    );
    return curve.getSpacedPoints(Math.max(2, Math.round(curve.getLength() / DOT_GAP)));
  }, [path]);
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    points.forEach((point, i) => {
      tile.position.copy(point);
      tile.scale.setScalar(0.055);
      tile.updateMatrix();
      m.setMatrixAt(i, tile.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  }, [points]);
  return (
    <instancedMesh
      key={points.length}
      ref={mesh}
      args={[undefined, undefined, points.length]}
      frustumCulled={false}
      raycast={noRaycast}
    >
      <sphereGeometry args={[1, 10, 10]} />
      <meshBasicMaterial color={colors.neutral} transparent opacity={confirmed ? 0.9 : 0.4} toneMapped={false} />
    </instancedMesh>
  );
}
