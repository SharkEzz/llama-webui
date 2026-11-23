/** Frame rate while something moves on its own or under the hand (transitions, easing values, camera being handled). */
export const ACTIVE_FPS = 60;
/**
 * Frame rate of the ambient animations that loop at rest (streaks, memory pulse) and of the easing of the streaks' own
 * count, length and speed: 30 fps keeps them fluid.
 */
export const AMBIENT_FPS = 30;
/** Frame rate when only the camera drift moves (under 0.1 unit/s: 20 fps is enough). */
export const DRIFT_FPS = 20;
/** Slack (ms): a slightly early rAF still counts, so at 120 Hz 60 fps really is every other frame. */
const SLACK_MS = 4;

/**
 * What the smoothed values still easing need after a frame: the active rate, the ambient one (only the streaks' own
 * parameters are easing), or nothing (all settled).
 */
export type Motion = 'active' | 'ambient' | false;

/**
 * Scene render pacing (frameloop “never”): redrawing at the display's refresh rate (120 Hz and up) costs without adding
 * anything, and redrawing a still scene is pointless. Whatever animates flags it during the frame; the next one comes at
 * `ACTIVE_FPS`, at `AMBIENT_FPS` for an ambient animation, at `DRIFT_FPS` for drift alone, or never as long as nothing
 * asks for it. The ambient animations and the smoothings advance with the time between frames, not per frame: they
 * keep their speed and their curve.
 */
export class FramePacer {
  /** An animation needs the next frame (flagged during the frame, reset afterwards). */
  active = false;
  /** An ambient animation (streaks, pulse) needs the next frame, at `AMBIENT_FPS` (flagged and reset like `active`). */
  ambient = false;
  /** The camera is drifting (kept up to date every frame). */
  drift = false;
  /** A frame as soon as possible: an input changed (snapshot, hover, theme, size). */
  requested = true;
  /** The user is handling the camera (between the start and end of the gesture). */
  interacting = false;
  private activeUntil = 0;
  private fps = 0;
  private last = Number.NEGATIVE_INFINITY;

  /** Keeps the full frame rate for `ms` (camera damping after a gesture). */
  hold(now: number, ms: number): void {
    this.activeUntil = Math.max(this.activeUntil, now + ms);
  }

  /** On every rAF (`now` in ms): should this frame be drawn? */
  shouldRender(now: number): boolean {
    const fps = this.requested || this.interacting || now < this.activeUntil ? ACTIVE_FPS : this.fps;
    return fps > 0 && now - this.last >= 1000 / fps - SLACK_MS;
  }

  /** After a frame: pace of the next one, based on what moved during this one (`moving`: see `Smoother.takeMoving`). */
  rendered(now: number, moving: Motion): void {
    this.last = now;
    this.requested = false;
    const active = this.active || moving === 'active';
    const ambient = this.ambient || moving === 'ambient';
    this.fps = active ? ACTIVE_FPS : ambient ? AMBIENT_FPS : this.drift ? DRIFT_FPS : 0;
    this.active = false;
    this.ambient = false;
  }
}
