/**
 * player.js
 * =========
 * Defines the player character: lane movement, jumping, sliding, and rendering.
 *
 * Lane system:
 *   LANE_COUNT = 3  →  LANES = { LEFT:0, CENTER:1, RIGHT:2 }
 *   player.lane        = committed integer lane (used for collision)
 *   player.visualLane  = fractional lane for smooth animation
 *
 * Physics:
 *   Jump:  initial velocity = JUMP_FORCE (px/s upward), gravity = GRAVITY (px/s²)
 *   Slide: lowers effective height to 50% for SLIDE_DURATION seconds
 *
 * Coordinate system:
 *   player.groundY = screen Y of the player's feet at rest (set by onResize)
 *   player.jumpHeight = current pixels above groundY (positive = up)
 *
 * Rendering:
 *   Player is drawn at screen position derived from visualLane, groundY,
 *   and jumpHeight. The exact screen X comes from laneX[] passed to render().
 *   Neon-cyan colour with glow shadow; slide pose flattens the rectangle.
 *
 * Connects to:
 *   - gameManager.js  — creates Player; calls update(dt), render(ctx, laneX),
 *                       getCollisionState(); sets groundY, w, h on resize.
 *   - obstacle.js     — reads getCollisionState() to test collisions.
 */

// ── Lane Constants (referenced by obstacle.js and gameManager.js) ────────────
const LANE_COUNT = 3;
const LANES = Object.freeze({ LEFT: 0, CENTER: 1, RIGHT: 2 });

class Player {
  constructor() {
    // ── Lane state ────────────────────────────────────────────────
    this.lane       = LANES.CENTER;   // committed integer lane
    this.prevLane   = LANES.CENTER;   // lane we're animating from
    this.visualLane = LANES.CENTER;   // fractional, drives render X
    /** 0 = at prevLane, 1 = at lane (fully arrived) */
    this.laneT      = 1;
    /** Lane animation speed in lane-units per second */
    this.LANE_SPEED = 9;

    // ── Physics ───────────────────────────────────────────────────
    this.jumpHeight   = 0;     // pixels above ground (positive = up)
    this.jumpVelocity = 0;     // px/s (negative = moving up in screen space = positive height)
    this.isJumping    = false;
    this.isSliding    = false;
    this.slideTimer   = 0;

    /** Initial jump velocity (px/s, applied upward) */
    this.JUMP_FORCE     = 900;
    /** Gravitational acceleration (px/s²) */
    this.GRAVITY        = 2000;
    /** Slide pose duration in seconds */
    this.SLIDE_DURATION = 0.75;

    // ── Dimensions (set by GameManager.onResize) ──────────────────
    this.w       = 52;   // logical width  (px at z=1)
    this.h       = 78;   // logical height (px at z=1)
    this.groundY = 0;    // screen Y of feet when standing

    // ── Visual state ──────────────────────────────────────────────
    this.shield = false;   // Phase Shield (stub, set by GameManager when upgrading)
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Shifts the player one lane left (-1) or right (+1).
   * Clamps to valid range. Ignored if already animating to that lane.
   * @param {number} dir - -1 for left, +1 for right
   */
  changeLane(dir) {
    const target = Math.max(0, Math.min(LANE_COUNT - 1, this.lane + dir));
    if (target === this.lane) return;
    this.prevLane = this.lane;
    this.lane     = target;
    this.laneT    = 0;
  }

  /**
   * Initiates a jump. Ignored if already in the air.
   */
  jump() {
    if (this.isJumping) return;
    this.isJumping    = true;
    this.isSliding    = false;
    this.slideTimer   = 0;
    this.jumpVelocity = this.JUMP_FORCE;
  }

  /**
   * Initiates a slide. Ignored if in the air.
   * Cancels any active slide and resets the timer.
   */
  slide() {
    if (this.isJumping) return;
    this.isSliding  = true;
    this.slideTimer = 0;
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  /**
   * Advances player physics and animation for one frame.
   * @param {number} dt - Delta time in seconds
   */
  update(dt) {
    // ── Lane animation (ease-in-out) ────────────────────────────────
    if (this.laneT < 1) {
      this.laneT = Math.min(1, this.laneT + dt * this.LANE_SPEED);
      // Smooth step ease
      const t = this.laneT * this.laneT * (3 - 2 * this.laneT);
      this.visualLane = this.prevLane + (this.lane - this.prevLane) * t;
    } else {
      this.visualLane = this.lane;
    }

    // ── Jump physics ────────────────────────────────────────────────
    if (this.isJumping) {
      this.jumpHeight   += this.jumpVelocity * dt;
      this.jumpVelocity -= this.GRAVITY * dt;
      if (this.jumpHeight <= 0) {
        this.jumpHeight   = 0;
        this.jumpVelocity = 0;
        this.isJumping    = false;
      }
    }

    // ── Slide timer ─────────────────────────────────────────────────
    if (this.isSliding) {
      this.slideTimer += dt;
      if (this.slideTimer >= this.SLIDE_DURATION) {
        this.isSliding  = false;
        this.slideTimer = 0;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Collision State
  // ---------------------------------------------------------------------------

  /**
   * Returns the minimal state needed for collision testing.
   * Called by GameManager every frame and passed to ObstacleManager / ShardManager.
   *
   * @returns {{
   *   lane:       number,   // committed integer lane (0|1|2)
   *   jumpHeight: number,   // pixels above ground (positive up)
   *   isSliding:  boolean,
   *   h:          number,   // standing height (px at z=1)
   * }}
   */
  getCollisionState() {
    return {
      lane:       this.lane,
      jumpHeight: this.jumpHeight,
      isSliding:  this.isSliding,
      h:          this.h,
    };
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  /**
   * Draws the player at the correct screen position.
   *
   * The player is always at z=1 (full scale), so no depth projection needed.
   * Y position: groundY minus jumpHeight (upward means smaller screen Y).
   * X position: interpolated from laneX using the fractional visualLane.
   *
   * Slide pose: height halved, rect dropped to stay grounded.
   * Shield visual: additional glow ring when shield is active.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number[]}                 laneX - Screen X per lane at z=1
   */
  render(ctx, laneX) {
    // Interpolate X for smooth lane animation
    const lo  = Math.floor(this.visualLane);
    const hi  = Math.min(LANE_COUNT - 1, lo + 1);
    const t   = this.visualLane - lo;
    const x   = laneX[lo] + (laneX[hi] - laneX[lo]) * t;

    const activeH = this.isSliding ? this.h * 0.5 : this.h;
    const y       = this.groundY - this.jumpHeight - activeH;

    ctx.save();

    // ── Shield glow ring ────────────────────────────────────────────
    if (this.shield) {
      ctx.shadowColor = '#ff00ff';
      ctx.shadowBlur  = 28;
      ctx.strokeStyle = 'rgba(255,0,255,0.55)';
      ctx.lineWidth   = 3;
      ctx.beginPath();
      ctx.arc(x, y + activeH / 2, this.w * 0.78, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ── Body glow ───────────────────────────────────────────────────
    ctx.shadowColor = '#00ffff';
    ctx.shadowBlur  = 22;

    // Body gradient
    const grad = ctx.createLinearGradient(x - this.w / 2, y, x + this.w / 2, y + activeH);
    grad.addColorStop(0, '#00ffff');
    grad.addColorStop(1, '#0066cc');
    ctx.fillStyle = grad;

    // Rounded-rect body
    const rx = 6;
    const bx = x - this.w / 2;
    const by = y;
    const bw = this.w;
    const bh = activeH;
    ctx.beginPath();
    ctx.moveTo(bx + rx, by);
    ctx.lineTo(bx + bw - rx, by);
    ctx.arcTo(bx + bw, by,      bx + bw, by + rx, rx);
    ctx.lineTo(bx + bw, by + bh - rx);
    ctx.arcTo(bx + bw, by + bh, bx + bw - rx, by + bh, rx);
    ctx.lineTo(bx + rx, by + bh);
    ctx.arcTo(bx,       by + bh, bx, by + bh - rx, rx);
    ctx.lineTo(bx, by + rx);
    ctx.arcTo(bx, by, bx + rx, by, rx);
    ctx.closePath();
    ctx.fill();

    // ── Edge highlight ──────────────────────────────────────────────
    ctx.shadowBlur  = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // ── Visor / eye strip ───────────────────────────────────────────
    if (!this.isSliding) {
      const visorY = y + activeH * 0.22;
      const visorH = activeH * 0.14;
      ctx.fillStyle   = 'rgba(0,255,255,0.85)';
      ctx.shadowColor = '#00ffff';
      ctx.shadowBlur  = 10;
      ctx.fillRect(bx + 6, visorY, bw - 12, visorH);
    }

    ctx.restore();
  }
}
