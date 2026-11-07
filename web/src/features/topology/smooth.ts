/** Lissage exponentiel par clé, pour que les valeurs du tick (1 s) n'avancent pas par sauts dans la boucle de rendu. */
export class Smoother {
  private v = new Map<string, number>();

  /** `tau` : constante de temps (s) ; après `tau`, 63 % du chemin vers la cible est fait. */
  constructor(private readonly tau = 0.35) {}

  step(key: string, target: number | null, dt: number): number {
    const t = target ?? 0;
    const prev = this.v.get(key);
    if (prev === undefined) {
      this.v.set(key, t);
      return t;
    }
    const next = prev + (t - prev) * (1 - Math.exp(-dt / this.tau));
    this.v.set(key, next);
    return next;
  }
}

const FLOOR_BPS = 1e5;
const CEIL_BPS = 20e9;
const RANGE = Math.log10(CEIL_BPS / FLOOR_BPS);
export const MAX_PARTICLES = 64;

/**
 * Traduction d'un débit en paramètres visuels, en échelle log : 50 Mo/s doivent rester visibles à côté de 20 Go/s.
 * `particles` : nombre de particules sur le lien ; `speed` : fraction du lien parcourue par seconde ; `glow` : 0..1.
 */
export function flowVisual(bps: number | null): { particles: number; speed: number; glow: number } {
  if (bps === null || !(bps >= FLOOR_BPS)) return { particles: 0, speed: 0, glow: 0 };
  const x = Math.min(1, Math.log10(bps / FLOOR_BPS) / RANGE);
  return { particles: Math.round(4 + (MAX_PARTICLES - 4) * x), speed: 0.15 + 0.6 * x, glow: 0.15 + 0.85 * x };
}
