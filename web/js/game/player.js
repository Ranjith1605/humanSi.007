// Nova, the ship's penguin navigator. A small state machine on top of the
// physics contract: idle / run / skid / jump / fall / glide / hurt / pulse.
// Everything that makes the controls feel generous lives here: coyote time,
// jump buffering, variable jump height, the flap-glide, corner nudges (in
// physics.js) and squash-and-stretch for the renderer.

import {
  T, MAX_RUN, RUN_ACCEL, GROUND_FRICTION, SKID_DECEL, AIR_ACCEL, AIR_DRAG,
  GRAVITY, GRAVITY_RISE_HOLD, GRAVITY_RISE_RELEASE, JUMP_VELOCITY, MAX_FALL,
  COYOTE_TIME, JUMP_BUFFER, GLIDE_MAX_FALL, SPRING_VELOCITY, BOOST_SPEED, BOOST_DECAY,
  UPDRAFT_ACCEL, UPDRAFT_MAX_UP, HURT_KNOCK_UP, HURT_KNOCK_AWAY, HURT_CONTROL_LOCK,
  INVULN_TIME, BODY_W, BODY_H, moveX, moveY, tilesUnderfoot, tileAt,
} from './physics.js';
import { touchCrumble } from './level.js';

const PULSE_COOLDOWN = 0.55;
const ASSIST_BOOST_TIME = 3;
const ASSIST_BOOST_MUL = 1.3;

export class Player {
  constructor() {
    this.w = BODY_W;
    this.h = BODY_H;
    this.reset(0, 0);
  }

  reset(x, y) {
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.vx = 0;
    this.vy = 0;
    this.facing = 1;
    this.onGround = false;
    this.groundRow = -1;
    this.riding = null;
    this.coyote = 0;
    this.buffer = 0;
    this.jumping = false;
    this.launched = false;
    this.glideArmed = false;
    this.gliding = false;
    this.skidding = false;
    this.boostT = 0;
    this.assistT = 0;
    this.lock = 0;
    this.invuln = 0;
    this.pulseCD = 0;
    this.pulseAnim = 0;
    this.dropT = 0;
    this.downT = 0;
    this.state = 'idle';
    this.animT = 0;
    this.runPhase = 0;
    this.sx = 1;
    this.sy = 1;
    this.alive = true;
    this.frozen = false;
    this.airT = 0;
  }

  get centerY() {
    return this.y - this.h / 2;
  }

  squash(sx, sy) {
    this.sx = sx;
    this.sy = sy;
  }

  /** Knockback and invulnerability. Returns false while still invulnerable. */
  hurt(fromX) {
    if (this.invuln > 0 || !this.alive || this.frozen) return false;
    this.invuln = INVULN_TIME;
    this.lock = HURT_CONTROL_LOCK;
    const away = this.x >= fromX ? 1 : -1;
    this.vx = away * HURT_KNOCK_AWAY;
    this.vy = -HURT_KNOCK_UP;
    this.onGround = false;
    this.riding = null;
    this.gliding = false;
    this.glideArmed = false;
    this.jumping = false;
    this.launched = false;
    this.boostT = 0;
    this.squash(1.3, 0.75);
    return true;
  }

  speedBoost() {
    this.assistT = ASSIST_BOOST_TIME;
  }

  update(dt, inp, lv, emit) {
    this.prevX = this.x;
    this.prevY = this.y;
    if (this.frozen) return;

    this.invuln = Math.max(0, this.invuln - dt);
    this.lock = Math.max(0, this.lock - dt);
    this.pulseCD = Math.max(0, this.pulseCD - dt);
    this.pulseAnim = Math.max(0, this.pulseAnim - dt);
    this.dropT = Math.max(0, this.dropT - dt);
    this.boostT = Math.max(0, this.boostT - dt);
    this.assistT = Math.max(0, this.assistT - dt);
    this.buffer = inp.jumpPressed ? JUMP_BUFFER : Math.max(0, this.buffer - dt);
    this.coyote = this.onGround ? COYOTE_TIME : Math.max(0, this.coyote - dt);

    // Moving platforms carry whoever stands on them.
    if (this.riding) {
      const p = this.riding;
      if (p.dx) moveX(lv, this, p.dx);
      if (p.dy < 0) {
        const r = moveY(lv, this, p.dy, true);
        if (r.ceiling) this.riding = null;
      } else if (p.dy > 0) {
        this.y += p.dy;
      }
    }

    const control = this.lock <= 0 && this.alive;
    const dir = control ? (inp.right ? 1 : 0) - (inp.left ? 1 : 0) : 0;
    const maxSpeed = MAX_RUN * (this.assistT > 0 ? ASSIST_BOOST_MUL : 1);
    const cap = this.boostT > 0 ? maxSpeed + Math.max(0, BOOST_SPEED - maxSpeed) * (this.boostT / BOOST_DECAY) : maxSpeed;

    this.skidding = false;
    if (this.onGround) {
      if (dir !== 0) {
        if (Math.sign(this.vx) === -dir && Math.abs(this.vx) > 1.5) {
          this.vx += dir * SKID_DECEL * dt;
          this.skidding = true;
        } else {
          this.vx += dir * RUN_ACCEL * dt;
        }
        this.facing = dir;
      } else if (this.boostT <= 0) {
        const f = GROUND_FRICTION * dt;
        this.vx = Math.abs(this.vx) <= f ? 0 : this.vx - Math.sign(this.vx) * f;
      }
    } else if (dir !== 0) {
      this.vx += dir * AIR_ACCEL * dt;
      this.facing = dir;
    } else {
      const f = AIR_DRAG * dt;
      this.vx = Math.abs(this.vx) <= f ? 0 : this.vx - Math.sign(this.vx) * f;
    }
    if (Math.abs(this.vx) > cap) this.vx = Math.sign(this.vx) * cap;

    // Jump: buffered presses and coyote time both count.
    let jumpedNow = false;
    if (control && this.buffer > 0 && (this.onGround || this.coyote > 0)) {
      this.vy = -JUMP_VELOCITY;
      this.onGround = false;
      this.riding = null;
      this.coyote = 0;
      this.buffer = 0;
      this.jumping = true;
      this.launched = false;
      this.glideArmed = false;
      jumpedNow = true;
      this.squash(0.72, 1.32);
      emit('jump', { x: this.x, y: this.y, speed: Math.abs(this.vx) });
    }

    // Drop through one-way surfaces with Down.
    if (control && inp.down && this.onGround && this.standingOnOneWay(lv)) {
      this.dropT = 0.22;
      this.onGround = false;
      this.riding = null;
      this.y += 0.02;
      emit('drop', { x: this.x, y: this.y });
    }

    // Flap-glide: a fresh press while airborne arms it; holding keeps it on.
    if (!this.onGround && control && inp.jumpPressed && !jumpedNow) this.glideArmed = true;
    if (!inp.jump || !control) this.glideArmed = false;
    const wasGliding = this.gliding;
    this.gliding = !this.onGround && this.glideArmed && this.vy > -2;
    if (this.gliding && !wasGliding) emit('glide-start', { x: this.x, y: this.y });

    // Gravity: gentle while a held jump rises, heavy when released early.
    let g = GRAVITY;
    if (this.vy < 0 && !this.launched && this.jumping) g = inp.jump ? GRAVITY_RISE_HOLD : GRAVITY_RISE_RELEASE;
    this.vy += g * dt;

    if (this.gliding) {
      const z = this.updraftAt(lv);
      if (z) {
        // Lift fades out near the zone's ceiling so Nova hovers instead of overshooting.
        const hover = z.liftTop - 0.25;
        const f = Math.min(1, Math.max(0, (this.y - hover) / 0.6));
        this.vy -= UPDRAFT_ACCEL * f * dt;
        if (this.vy < -UPDRAFT_MAX_UP) this.vy = -UPDRAFT_MAX_UP;
        if (this.y < z.liftTop - 0.5 && this.vy < 0) this.vy = 0;
        this.inUpdraft = true;
      } else this.inUpdraft = false;
      if (this.vy > GLIDE_MAX_FALL) this.vy = Math.max(GLIDE_MAX_FALL, this.vy - 110 * dt);
    } else {
      this.inUpdraft = false;
      if (this.vy > MAX_FALL) this.vy = MAX_FALL;
    }
    if (this.vy >= 0) {
      this.jumping = false;
      this.launched = false;
    }

    if (moveX(lv, this, this.vx * dt)) this.vx = 0;
    const wasGround = this.onGround;
    const impact = this.vy;
    const r = moveY(lv, this, this.vy * dt, this.dropT > 0);
    if (r.ceiling) {
      this.vy = 0;
      this.jumping = false;
      emit('bonk', { x: this.x, y: this.y - this.h });
    }
    if (r.landed) {
      this.vy = 0;
      this.onGround = true;
      this.riding = r.platform;
      this.groundRow = r.platform ? -1 : r.row;
      this.gliding = false;
      if (!wasGround && this.airT > 0.08) {
        const k = Math.min(1, impact / 22);
        this.squash(1 + 0.35 * k, 1 - 0.3 * k);
        emit('land', { x: this.x, y: this.y, impact });
      }
      this.airT = 0;
    } else {
      this.onGround = false;
      this.riding = null;
      this.airT += dt;
    }

    // Ground toys: crumbling tiles, springs, boosters.
    if (this.onGround && !this.riding && this.groundRow >= 0) {
      const under = tilesUnderfoot(lv, this, this.groundRow);
      let spring = null;
      for (const u of under) {
        if (u.code === T.CRUMBLE) {
          if (!lv.crumble.has(u.ty * lv.w + u.tx)) emit('crumble-touch', { tx: u.tx, ty: u.ty });
          touchCrumble(lv, u.tx, u.ty);
        }
        if (u.code === T.SPRING) spring = u;
      }
      if (spring) {
        this.vy = -SPRING_VELOCITY;
        this.onGround = false;
        this.launched = true;
        this.jumping = false;
        this.glideArmed = false;
        this.squash(0.65, 1.4);
        emit('spring', { tx: spring.tx, ty: spring.ty, x: this.x, y: this.y });
      } else {
        const c = tileAt(lv, Math.floor(this.x), this.groundRow);
        const code = c === T.BOOST_R || c === T.BOOST_L ? c : under.find((u) => u.code === T.BOOST_R || u.code === T.BOOST_L)?.code;
        if (code === T.BOOST_R || code === T.BOOST_L) {
          const d = code === T.BOOST_R ? 1 : -1;
          if (this.boostT < BOOST_DECAY - 0.05 || Math.sign(this.vx) !== d) emit('boost', { x: this.x, y: this.y, dir: d });
          this.vx = d * Math.max(BOOST_SPEED, Math.abs(this.vx));
          this.boostT = BOOST_DECAY;
          this.facing = d;
        }
      }
    }

    if (control && inp.pulsePressed && this.pulseCD <= 0) {
      this.pulseCD = PULSE_COOLDOWN;
      this.pulseAnim = 0.28;
      emit('pulse', { x: this.x, y: this.centerY });
    }

    // Look down (camera) after holding Down briefly on solid ground.
    this.downT = control && inp.down && this.onGround && Math.abs(this.vx) < 0.5 ? this.downT + dt : 0;

    this.animate(dt, emit);
  }

  standingOnOneWay(lv) {
    if (this.riding) return true;
    if (this.groundRow < 0) return false;
    const under = tilesUnderfoot(lv, this, this.groundRow);
    // Only when nothing under the feet is solid, or Down would drop through rock.
    return under.every((u) => u.code === T.ONEWAY || u.code === T.CRUMBLE || u.code === T.EMPTY || u.code === T.UPDRAFT || u.code === T.FALSE)
      && under.some((u) => u.code === T.ONEWAY || u.code === T.CRUMBLE);
  }

  updraftAt(lv) {
    for (const z of lv.updrafts) {
      if (this.x >= z.x0 - 0.15 && this.x < z.x1 + 0.15 && this.y > z.liftTop - 1 && this.y <= z.bottom + 0.6) return z;
    }
    return null;
  }

  animate(dt, emit) {
    let s;
    if (!this.alive || this.lock > 0) s = 'hurt';
    else if (this.pulseAnim > 0) s = 'pulse';
    else if (this.onGround) s = this.skidding ? 'skid' : Math.abs(this.vx) > 0.4 ? 'run' : 'idle';
    else if (this.gliding) s = 'glide';
    else s = this.vy < 0 ? 'jump' : 'fall';
    if (s !== this.state) {
      this.state = s;
      this.animT = 0;
    } else this.animT += dt;
    if (s === 'run') {
      const before = Math.floor(this.runPhase * 2);
      this.runPhase = (this.runPhase + dt * (0.8 + Math.abs(this.vx) * 0.13)) % 1;
      const after = Math.floor(this.runPhase * 2);
      if (before !== after && Math.abs(this.vx) > 5) emit('step', { x: this.x, y: this.y, dir: Math.sign(this.vx) });
    }
    if (s === 'skid' && Math.random() < dt * 30) emit('skid', { x: this.x, y: this.y, dir: Math.sign(this.vx) });
    const k = Math.min(1, dt * 12);
    this.sx += (1 - this.sx) * k;
    this.sy += (1 - this.sy) * k;
  }
}
