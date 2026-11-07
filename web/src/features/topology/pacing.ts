/** Frame rate while something animates (particles, pulse, transitions, camera being handled). */
export const ACTIVE_FPS = 60;
/** Frame rate when only the camera drift moves (under 0.1 unit/s: 20 fps is enough). */
export const DRIFT_FPS = 20;
/** Slack (ms): a slightly early rAF still counts, so at 120 Hz 60 fps really is every other frame. */
const SLACK_MS = 4;

/**
 * Scene render pacing (frameloop “never”): redrawing at the display's refresh rate (120 Hz and up) costs without adding
 * anything, and redrawing a still scene is pointless. Whatever animates flags it during the frame; the next one comes at
 * `ACTIVE_FPS`, at `DRIFT_FPS` for drift alone, or never as long as nothing asks for it.
 */
export class FramePacer {
  /** An animation needs the next frame (flagged during the frame, reset afterwards). */
  active = false;
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

  /** After a frame: pace of the next one, based on what moved during this one. */
  rendered(now: number, moving: boolean): void {
    this.last = now;
    this.requested = false;
    this.fps = this.active || moving ? ACTIVE_FPS : this.drift ? DRIFT_FPS : 0;
    this.active = false;
  }
}
