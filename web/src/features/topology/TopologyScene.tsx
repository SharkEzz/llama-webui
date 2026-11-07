import type { TopologyGraph, TopologyLink, TopologyNode } from '@llama-webui/shared';
import { OrbitControls, RoundedBox, Tube } from '@react-three/drei';
import { advance, Canvas, useFrame, useThree } from '@react-three/fiber';
import { type ComponentRef, type RefObject, useEffect, useMemo, useRef } from 'react';
import {
  type Color,
  type InstancedMesh,
  type MeshStandardMaterial,
  Object3D,
  QuadraticBezierCurve3,
  Vector3,
} from 'three';
import type { Tone } from '@/components/glass/tones';
import type { LinkFlow, NodeLive } from './flows';
import { type Bounds, FOV_DEG, fitCamera, type Layout, type Placed } from './layout';
import { FramePacer } from './pacing';
import { flowVisual, MAX_PARTICLES, Smoother } from './smooth';
import type { SceneColors } from './themeColors';

/*
 * Scène 3D : dalles translucides (composants) reliées par des tubes (liens) parcourus de particules (débit mesuré).
 * Les étiquettes et l'infobulle sont du DOM (couche <Labels>, hors canvas) : typographie, tokens et contraste du
 * thème. La scène les positionne elle-même à chaque image (<Projector>) : pas de portail par étiquette (drei <Html>
 * perd le premier sous React 19 en mode strict).
 */

export interface TopologySceneProps {
  graph: TopologyGraph;
  layout: Layout;
  flows: Map<string, LinkFlow>;
  live: Map<string, NodeLive>;
  tones: Map<string, Tone>;
  colors: SceneColors;
  reducedMotion: boolean;
  hovered: string | null;
  onHover: (id: string | null) => void;
  /** Couche DOM des étiquettes (éléments `data-node`), déplacée à chaque image. */
  labelLayer: RefObject<HTMLDivElement | null>;
  /** Rempli par la scène : recentrage de la caméra. */
  view: RefObject<SceneView | null>;
  /** La caméra a quitté (true) ou retrouvé (false) son cadrage initial. */
  onViewMoved: (moved: boolean) => void;
}

/** Capacité de référence pour l'épaisseur des tubes : Gen5 x16. */
const REF_BPS = 16 * 3.938e9;

export function TopologyScene(p: TopologySceneProps) {
  const smoother = useMemo(() => new Smoother(0.4), []);
  const pacer = useMemo(() => new FramePacer(), []);
  // Une entrée a changé : une image au plus tôt, puis les lissages en cours gardent la cadence (voir FramePacer).
  // biome-ignore lint/correctness/useExhaustiveDependencies: déclencheurs, la scène lit ces valeurs à l'image suivante
  useEffect(() => {
    pacer.requested = true;
  }, [pacer, p.flows, p.live, p.tones, p.colors, p.hovered, p.layout, p.reducedMotion]);
  const byId = useMemo(() => new Map(p.graph.nodes.map((n) => [n.id, n])), [p.graph]);
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
      <Projector layout={p.layout} layer={p.labelLayer} />
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
        const from = p.layout.nodes.get(l.from);
        const to = p.layout.nodes.get(l.to);
        const toNode = byId.get(l.to);
        const flow = p.flows.get(l.id);
        if (!from || !to || !toNode || !flow) return null;
        return (
          <Link
            key={l.id}
            link={l}
            from={from}
            to={to}
            flow={flow}
            color={nodeColor(toNode)}
            colors={p.colors}
            reducedMotion={p.reducedMotion}
            smoother={smoother}
            pacer={pacer}
          />
        );
      })}
    </Canvas>
  );
}

/** Amortissement de la caméra après un geste : il s'éteint en moins d'une seconde (facteur 0,12 par image). */
const DAMPING_MS = 1000;

/**
 * Boucle de rendu (frameloop « never ») : à chaque rAF, une image seulement si le pacer la demande. Un onglet caché ne
 * reçoit plus de rAF : rien n'est dessiné.
 */
function FrameDriver({ pacer, smoother }: { pacer: FramePacer; smoother: Smoother }) {
  const get = useThree((s) => s.get);
  const size = useThree((s) => s.size);
  // Redimensionner efface le canvas : une image tout de suite.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `size` est le déclencheur
  useEffect(() => {
    pacer.requested = true;
  }, [pacer, size]);
  useEffect(() => {
    let raf = requestAnimationFrame(function tick(now) {
      raf = requestAnimationFrame(tick);
      if (!pacer.shouldRender(now)) return;
      // En frameloop « never », l'horloge de la scène suit le temps passé ici, en secondes.
      advance(now / 1000, true, get());
      pacer.rendered(now, smoother.takeMoving());
    });
    return () => cancelAnimationFrame(raf);
  }, [pacer, smoother, get]);
  return null;
}

/** Pilotage de la caméra depuis le DOM (bouton « Recentrer »). */
export interface SceneView {
  reset: () => void;
}

/** Durée du retour au cadrage initial (s). */
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
 * Caméra en vue 3/4 ajustée au cadre, à dérive très lente (désactivée sous prefers-reduced-motion). Glisser pivote,
 * clic droit (ou deux doigts) déplace, la molette zoome : dès que l'utilisateur la prend en main, la caméra reste où il
 * l'a laissée (ni dérive ni recadrage au redimensionnement) jusqu'au « Recentrer », qui la ramène en douceur.
 */
function Rig({ bounds, drift, view, onMovedChange, pacer }: RigProps) {
  const { camera, size } = useThree();
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const cam = useMemo(() => fitCamera(bounds, size.width / Math.max(1, size.height)), [bounds, size]);
  const fitDist = useMemo(() => Math.hypot(...sub3(cam.position, cam.target)), [cam]);
  const moved = useRef(false);
  // Retour animé : pose de départ et progression (0 → 1), null hors animation.
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

  // Après les contrôles (priorité -1, qui appliquent l'amortissement) : la pose de repos l'emporte tant que
  // l'utilisateur n'a pas pris la main.
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
      // Reste au-dessus du sol : on ne passe pas sous les dalles.
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

/** Projette le sommet de chaque bloc sur l'écran et y ancre son étiquette DOM (sans passer par React, à chaque image). */
function Projector({ layout, layer }: { layout: Layout; layer: RefObject<HTMLDivElement | null> }) {
  const { camera, size } = useThree();
  const els = useRef(new Map<string, HTMLElement>());
  useFrame(() => {
    const root = layer.current;
    if (!root) return;
    for (const [id, placed] of layout.nodes) {
      let el = els.current.get(id);
      if (!el?.isConnected) {
        el = root.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`) ?? undefined;
        if (!el) continue;
        els.current.set(id, el);
      }
      projected.set(placed.pos[0], placed.size[1] + 0.1, placed.pos[2]).project(camera);
      const x = (projected.x * 0.5 + 0.5) * size.width;
      const y = (0.5 - projected.y * 0.5) * size.height;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.style.visibility = projected.z < 1 ? 'visible' : 'hidden';
      // Trop près du bord haut : l'infobulle passe sous l'étiquette (voir Labels).
      el.classList.toggle('tip-below', y < 230);
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
    const target = l.dim ? 0.04 : 0.1 + 0.9 * Math.min(1, (l.loadPct ?? 0) / 100);
    m.emissiveIntensity = smoother.step(`${node.id}:glow`, target, dt) * (hoveredRef.current ? 1.6 : 1);
  });
  const [w, h, d] = placed.size;
  const [x, , z] = placed.pos;
  // Le corps du bloc prend un peu de son ton (davantage en thème clair, où l'émission seule se voit peu).
  const body = useMemo(() => colors.slab.clone().lerp(color, colors.dark ? 0.2 : 0.45), [colors, color]);
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
          opacity={live.dim ? 0.4 : 0.94}
        />
      </RoundedBox>
    </group>
  );
}

interface LinkProps {
  link: TopologyLink;
  from: Placed;
  to: Placed;
  flow: LinkFlow;
  color: Color;
  colors: SceneColors;
  reducedMotion: boolean;
  smoother: Smoother;
  pacer: FramePacer;
}

function Link({ link, from, to, flow, color, colors, reducedMotion, smoother, pacer }: LinkProps) {
  const neutral = color === colors.neutral;
  const curve = useMemo(() => {
    // Les tubes partent des flancs qui se font face (pas du dessus : les faces supérieures et les étiquettes restent
    // libres) et passent en arc au-dessus du sol.
    const a = new Vector3(from.pos[0], from.size[1] * 0.5, from.pos[2]);
    const b = new Vector3(to.pos[0], to.size[1] * 0.5, to.pos[2]);
    const dir = b.clone().sub(a);
    dir.y = 0;
    dir.normalize();
    const edge = (size: Placed['size'], sign: number) =>
      Math.min(
        Math.abs(dir.x) > 1e-6 ? size[0] / 2 / Math.abs(dir.x) : Number.POSITIVE_INFINITY,
        Math.abs(dir.z) > 1e-6 ? size[2] / 2 / Math.abs(dir.z) : Number.POSITIVE_INFINITY,
      ) * sign;
    const start = a.clone().addScaledVector(dir, edge(from.size, 1));
    const end = b.clone().addScaledVector(dir, edge(to.size, -1));
    const mid = start.clone().lerp(end, 0.5);
    mid.y = 0.45 + start.distanceTo(end) * 0.12;
    return new QuadraticBezierCurve3(start, mid, end);
  }, [from, to]);
  const radius =
    link.kind === 'memory'
      ? 0.14
      : link.kind === 'internal'
        ? 0.05
        : 0.05 + 0.13 * Math.sqrt(Math.min(1, (flow.maxBps ?? 0) / REF_BPS));

  const mat = useRef<MeshStandardMaterial>(null);
  const flowRef = useRef(flow);
  useEffect(() => {
    flowRef.current = flow;
  }, [flow]);
  useFrame(({ clock }, dt) => {
    const m = mat.current;
    if (!m) return;
    const f = flowRef.current;
    let target: number;
    if (link.kind === 'memory' && f.fwdBps === null && f.backBps === null) {
      // Sans mesure DRAM : pulsation dont la cadence suit l'activité CPU (0–100) ; sans animation, une intensité fixe.
      const a = Math.min(1, (f.activity ?? 0) / 100);
      if (!reducedMotion && a > 0) pacer.active = true;
      target = reducedMotion
        ? 0.08 + 0.6 * a
        : 0.08 + a * (0.35 + 0.35 * Math.abs(Math.sin(clock.elapsedTime * (1 + 4 * a))));
    } else {
      const total = (f.fwdBps ?? 0) + (f.backBps ?? 0);
      target = 0.06 + (neutral ? 0.3 : 0.7) * flowVisual(total > 0 ? total : null).glow;
    }
    m.emissiveIntensity = smoother.step(`${link.id}:glow`, target, dt);
  });

  return (
    <group>
      <Tube args={[curve, 40, radius, 10, false]}>
        <meshStandardMaterial
          ref={mat}
          color={colors.tube}
          emissive={color}
          emissiveIntensity={0.06}
          roughness={0.5}
          metalness={0.1}
          transparent
          opacity={link.kind === 'internal' ? 0.25 : 0.5}
        />
      </Tube>
      {!reducedMotion && link.kind !== 'internal' && (
        <>
          <Particles
            id={`${link.id}:fwd`}
            curve={curve}
            bps={flow.fwdBps}
            color={color}
            reverse={false}
            side={0.1}
            smoother={smoother}
            pacer={pacer}
          />
          <Particles
            id={`${link.id}:back`}
            curve={curve}
            bps={flow.backBps}
            color={color}
            reverse
            side={-0.1}
            smoother={smoother}
            pacer={pacer}
          />
        </>
      )}
    </group>
  );
}

interface ParticlesProps {
  id: string;
  curve: QuadraticBezierCurve3;
  bps: number | null;
  color: Color;
  /** Sens aval → amont. */
  reverse: boolean;
  /** Décalage latéral (unités) pour que les deux sens ne se superposent pas. */
  side: number;
  smoother: Smoother;
  pacer: FramePacer;
}

const tmpPoint = new Vector3();
const tmpTangent = new Vector3();

/** Particules le long d'un lien : nombre et vitesse en échelle log du débit (voir flowVisual), lissés. */
function Particles({ id, curve, bps, color, reverse, side, smoother, pacer }: ParticlesProps) {
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  // Décalage initial de chaque particule, déterministe (suite de Weyl).
  const offsets = useMemo(() => Array.from({ length: MAX_PARTICLES }, (_, i) => (i * 0.6180339887) % 1), []);
  const bpsRef = useRef(bps);
  const phase = useRef(0);
  useEffect(() => {
    bpsRef.current = bps;
  }, [bps]);
  useFrame((_, dt) => {
    const m = mesh.current;
    if (!m) return;
    const vis = flowVisual(bpsRef.current);
    const n = Math.round(smoother.step(`${id}:n`, vis.particles, dt));
    const speed = smoother.step(`${id}:speed`, vis.speed, dt);
    phase.current = (phase.current + speed * dt) % 1;
    if (n > 0) pacer.active = true;
    m.count = n;
    for (let i = 0; i < n; i++) {
      let u = (offsets[i]! + phase.current) % 1;
      if (reverse) u = 1 - u;
      curve.getPointAt(u, tmpPoint);
      curve.getTangentAt(u, tmpTangent);
      // Perpendiculaire horizontale à la tangente : les deux sens circulent côte à côte.
      const len = Math.hypot(tmpTangent.x, tmpTangent.z) || 1;
      dummy.position.set(
        tmpPoint.x + (tmpTangent.z / len) * side,
        tmpPoint.y,
        tmpPoint.z - (tmpTangent.x / len) * side,
      );
      dummy.scale.setScalar(0.055 + 0.03 * Math.sin((u + phase.current) * Math.PI * 2));
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, MAX_PARTICLES]} count={0} frustumCulled={false}>
      <sphereGeometry args={[1, 8, 8]} />
      <meshBasicMaterial color={color} transparent opacity={0.95} toneMapped={false} />
    </instancedMesh>
  );
}
