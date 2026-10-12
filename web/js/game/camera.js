// Camera: smooth follow with look-ahead in the running direction, a vertical
// dead zone that settles on the ground Nova stands on, look-down on request,
// clamped to the map, and trauma-based screen shake (off with reduced motion).
// Works in internal pixels.

import { TILE } from './physics.js';

export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.prevX = 0;
    this.prevY = 0;
    this.viewW = 480;
    this.viewH = 270;
    this.ahead = 0;
    this.focusY = 0;
    this.lookDown = 0;
    this.trauma = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.reducedMotion = false;
    this.mapW = 0;
    this.mapH = 0;
  }

  setView(w, h) {
    this.viewW = w;
    this.viewH = h;
  }

  setMap(wTiles, hTiles) {
    this.mapW = wTiles * TILE;
    this.mapH = hTiles * TILE;
  }

  snap(p) {
    this.ahead = p.facing * 2 * TILE;
    this.focusY = p.y * TILE;
    const t = this.target(p);
    this.x = this.prevX = t.x;
    this.y = this.prevY = t.y;
  }

  target(p) {
    const px = p.x * TILE + this.ahead;
    const py = this.focusY - TILE * 1.2 + this.lookDown;
    let x = px - this.viewW / 2;
    // Keep Nova a little below the middle: more sky ahead of a jump.
    let y = py - this.viewH * 0.56;
    return this.clamp(x, y);
  }

  clamp(x, y) {
    const maxX = this.mapW - this.viewW;
    x = maxX <= 0 ? maxX / 2 : Math.min(Math.max(0, x), maxX);
    const maxY = this.mapH - this.viewH;
    // Taller than the map (portrait screens): sit the map's floor on the screen's floor.
    y = maxY <= 0 ? maxY : Math.min(Math.max(0, y), maxY);
    return { x, y };
  }

  update(dt, p) {
    this.prevX = this.x;
    this.prevY = this.y;
    // Look-ahead grows with speed and eases, so turning does not whip the view.
    const want = (p.facing * 1.6 + p.vx * 0.22) * TILE;
    const lim = 4 * TILE;
    const aheadTarget = Math.max(-lim, Math.min(lim, want));
    this.ahead += (aheadTarget - this.ahead) * Math.min(1, dt * 2.6);

    // Vertical: follow the ground when standing, and only big moves when airborne.
    const feet = p.y * TILE;
    if (p.onGround) this.focusY += (feet - this.focusY) * Math.min(1, dt * 6);
    else {
      const above = feet - this.focusY;
      if (above < -3 * TILE) this.focusY = feet + 3 * TILE;
      else if (above > 1.5 * TILE) this.focusY += (feet - 1.5 * TILE - this.focusY) * Math.min(1, dt * 10);
    }
    const ld = p.downT > 0.3 ? 4 * TILE : 0;
    this.lookDown += (ld - this.lookDown) * Math.min(1, dt * 4);

    const t = this.target(p);
    const k = Math.min(1, dt * 9);
    this.x += (t.x - this.x) * k;
    this.y += (t.y - this.y) * Math.min(1, dt * 7);
    const c = this.clamp(this.x, this.y);
    this.x = c.x;
    this.y = c.y;

    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    if (this.reducedMotion || this.trauma <= 0) {
      this.shakeX = 0;
      this.shakeY = 0;
    } else {
      const s = this.trauma * this.trauma * 5;
      this.shakeX = (Math.random() * 2 - 1) * s;
      this.shakeY = (Math.random() * 2 - 1) * s;
    }
  }

  shake(amount) {
    if (this.reducedMotion) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Interpolated, pixel-snapped view origin for rendering. */
  view(alpha) {
    return {
      x: Math.round(this.prevX + (this.x - this.prevX) * alpha + this.shakeX),
      y: Math.round(this.prevY + (this.y - this.prevY) * alpha + this.shakeY),
    };
  }
}
