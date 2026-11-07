/** Cadence quand quelque chose s'anime (particules, pulsation, transitions, caméra manipulée). */
export const ACTIVE_FPS = 60;
/** Cadence quand seule la dérive de la caméra bouge (moins de 0,1 unité/s : 20 i/s suffisent). */
export const DRIFT_FPS = 20;
/** Marge (ms) : un rAF un peu en avance compte, à 120 Hz 60 i/s font bien une image sur deux. */
const SLACK_MS = 4;

/**
 * Cadence de rendu de la scène (frameloop « never ») : redessiner à la fréquence de l'écran (120 Hz et plus) coûte sans
 * rien apporter, et redessiner une scène immobile ne sert à rien. Ce qui s'anime le signale pendant l'image ; la
 * suivante vient à `ACTIVE_FPS`, à `DRIFT_FPS` pour la seule dérive, ou jamais tant que rien ne la demande.
 */
export class FramePacer {
  /** Une animation a besoin de l'image suivante (signalé pendant l'image, remis à zéro après). */
  active = false;
  /** La caméra dérive (tenu à jour à chaque image). */
  drift = false;
  /** Une image au plus tôt : une entrée a changé (snapshot, survol, thème, taille). */
  requested = true;
  /** L'utilisateur manipule la caméra (entre le début et la fin du geste). */
  interacting = false;
  private activeUntil = 0;
  private fps = 0;
  private last = Number.NEGATIVE_INFINITY;

  /** Garde la pleine cadence pendant `ms` (amortissement de la caméra après un geste). */
  hold(now: number, ms: number): void {
    this.activeUntil = Math.max(this.activeUntil, now + ms);
  }

  /** À chaque rAF (`now` en ms) : faut-il dessiner cette image ? */
  shouldRender(now: number): boolean {
    const fps = this.requested || this.interacting || now < this.activeUntil ? ACTIVE_FPS : this.fps;
    return fps > 0 && now - this.last >= 1000 / fps - SLACK_MS;
  }

  /** Après une image : cadence de la suivante d'après ce qui a bougé pendant celle-ci. */
  rendered(now: number, moving: boolean): void {
    this.last = now;
    this.requested = false;
    this.fps = this.active || moving ? ACTIVE_FPS : this.drift ? DRIFT_FPS : 0;
    this.active = false;
  }
}
