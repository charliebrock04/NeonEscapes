/**
 * obstacle.js
 * ===========
 * Manages the pool of obstacles that the player must dodge.
 *
 * Obstacle types:
 *   BARRIER — full-height wall in one lane; player must change lane.
 *   LOW     — short obstacle; player must jump (jumpHeight ≥ JUMP_CLEAR_HEIGHT).
 *   HIGH    — tall obstacle with a gap at the bottom; player must slide.
 *
 * Depth system (z):
 *   z = 0  → at the vanishing point (horizon); objects are tiny.
 *   z = 1  → at the player (ground level); objects are full size.
 *   Objects spawn at z=0 and travel toward z=1 each frame.
 *
 * Perspective projection:
 *   screenX = vpX + (laneX - vpX) * z
 *   screenY = vpY + (playerY - vpY) * z
 *   scale   = z
 *
 * Collision:
 *   Tested only when z is in [COLLISION_Z, DESPAWN_Z).
 *   Committed player.lane (integer) compared to obstacle.lane.
 *   Jump/slide checked against obstacle type and player state.
 *
 * Connects to:
 *   - gameManager.js — creates ObstacleManager; calls setLayout, update, render,
 *                      reset; sets BASE_W, BASE_H_*, HIGH_GAP, JUMP_CLEAR_HEIGHT
 *                      after each resize.
 *   - player.js      — reads playerState.{lane, jumpHeight, isSliding, h}
 *                      for collision testing.
 */

// ── Obstacle type identifiers ─────────────────────────────────────────────────
const OBS_TYPE = Object.freeze({
  BARRIER: 'BARRIER',
  LOW:     'LOW',
  HIGH:    'HIGH',
});

// ── Single Obstacle ───────────────────────────────────────────────────────────

class Obstacle {
  /**
   * @param {string} type - OBS_TYPE value
   * @param {number} lane - Integer lane index
   */
  constructor(type, lane) {
    this.type   = type;
    this.lane   = lane;
    this.z      = 0;       // depth: 0=horizon, 1=player
    this.active = true;
  }
}

// ── ObstacleManager ───────────────────────────────────────────────────────────

class ObstacleManager {
  constructor() {
    /** @type {Obstacle[]} */
    this.obstacles = [];

    // ── Spawn timing ──────────────────────────────────────────────
    this.spawnTimer     = 2.2;  // delay before first obstacle
    this.MIN_INTERVAL   = 1.1;
    this.MAX_INTERVAL   = 2.8;

    // ── Depth thresholds ──────────────────────────────────────────
    this.COLLISION_Z = 0.90;  // when to test collision
    this.DESPAWN_Z   = 1.15;  // when to remove from scene

    // ── Base dimensions (set by GameManager.onResize) ─────────────
    this.BASE_W         = 68;
    this.BASE_H_BARRIER = 108;
    this.BASE_H_LOW     = 48;
    this.BASE_H_HIGH    = 62;

    // ── Physics thresholds (set by GameManager.onResize) ──────────
    /** Minimum jumpHeight to clear a LOW obstacle at COLLISION_Z */
    this.JUMP_CLEAR_HEIGHT = 44;
    /** Gap at the bottom of a HIGH obstacle; must be less than player.h */
    this.HIGH_GAP = 45;

    // ── Difficulty (set by GameManager.startGame from WorldSystem) ─
    /**
     * Weighted probability for each obstacle type.
     * GameManager sets this from WorldSystem.WORLDS[id].typeWeights before
     * each run. Defaults mirror the original hand-tuned World 1 distribution.
     * @type {{ BARRIER:number, LOW:number, HIGH:number }}
     */
    this.typeWeights = { BARRIER: 2, LOW: 1, HIGH: 1 };
    /**
     * Probability [0, 1] that a second obstacle is spawned immediately after
     * the first during the same spawn tick. Creates "double" patterns in
     * harder worlds. Set to 0 to disable.
     */
    this.multiSpawnChance = 0;

    // ── Layout (set by setLayout / onResize) ──────────────────────
    this.laneXPositions = [0, 0, 0];
    this.vpX            = 0;
    this.vpY            = 0;
    this.playerY        = 0;
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  /**
   * Receives layout values from GameManager after every resize.
   * Must be called before the first update().
   *
   * @param {number[]} laneXPositions - Screen X for each lane at z=1
   * @param {number}   vpX
   * @param {number}   vpY
   * @param {number}   playerY
   */
  setLayout(laneXPositions, vpX, vpY, playerY) {
    this.laneXPositions = laneXPositions;
    this.vpX            = vpX;
    this.vpY            = vpY;
    this.playerY        = playerY;
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  /**
   * Advances all obstacles, tests collision, prunes inactive.
   *
   * @param {number} dt          - Delta time in seconds
   * @param {number} speed       - Current game speed (z units/sec)
   * @param {object} playerState - From Player.getCollisionState()
   * @returns {boolean} true if the player has hit an obstacle (game over)
   */
  update(dt, speed, playerState) {
    // ── Spawn ─────────────────────────────────────────────────────
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this._spawnObstacle();
      this.spawnTimer = this.MIN_INTERVAL +
        Math.random() * (this.MAX_INTERVAL - this.MIN_INTERVAL);
    }

    // ── Move + collide ────────────────────────────────────────────
    let hit = false;
    for (const obs of this.obstacles) {
      if (!obs.active) continue;
      obs.z += speed * dt;

      if (obs.z >= this.COLLISION_Z && obs.z < this.DESPAWN_Z) {
        if (this._testCollision(obs, playerState)) {
          hit = true;
        }
      }

      if (obs.z >= this.DESPAWN_Z) {
        obs.active = false;
      }
    }

    // ── Prune ─────────────────────────────────────────────────────
    this.obstacles = this.obstacles.filter(o => o.active);

    return hit;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  /**
   * Draws all active obstacles, sorted back-to-front.
   * @param {CanvasRenderingContext2D} ctx
   */
  render(ctx) {
    const sorted = [...this.obstacles]
      .filter(o => o.active && o.z > 0.04)
      .sort((a, b) => a.z - b.z);

    for (const obs of sorted) {
      this._drawObstacle(ctx, obs);
    }
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  /**
   * Clears all obstacles and resets the spawn timer.
   * Called at the start of every run.
   */
  reset() {
    this.obstacles  = [];
    this.spawnTimer = 2.2;
  }

  // ---------------------------------------------------------------------------
  // Private — Spawn
  // ---------------------------------------------------------------------------

  /**
   * Primary spawn entry-point. Spawns one obstacle, then optionally a second
   * based on this.multiSpawnChance (set per-world by GameManager).
   * @private
   */
  _spawnObstacle() {
    this._spawnOne();
    if (this.multiSpawnChance > 0 && Math.random() < this.multiSpawnChance) {
      this._spawnOne();
    }
  }

  /**
   * Picks a weighted random type and a random lane, then pushes an Obstacle.
   * The type distribution is driven by this.typeWeights, allowing each world
   * to favour different obstacle patterns without changing this method.
   * @private
   */
  _spawnOne() {
    const type = this._weightedType();
    const lane = Math.floor(Math.random() * LANE_COUNT);
    this.obstacles.push(new Obstacle(type, lane));
  }

  /**
   * Selects an obstacle type via weighted random selection.
   * Weights need not sum to any particular value — only ratios matter.
   * @returns {string} OBS_TYPE constant
   * @private
   */
  _weightedType() {
    const { BARRIER, LOW, HIGH } = this.typeWeights;
    const total = BARRIER + LOW + HIGH;
    const r     = Math.random() * total;
    if (r < BARRIER)            return OBS_TYPE.BARRIER;
    if (r < BARRIER + LOW)      return OBS_TYPE.LOW;
    return OBS_TYPE.HIGH;
  }

  // ---------------------------------------------------------------------------
  // Private — Collision
  // ---------------------------------------------------------------------------

  /**
   * Tests whether a single obstacle has hit the player.
   *
   * BARRIER: same lane and not a phase-shield bypass.
   * LOW:     same lane and not jumped high enough.
   * HIGH:    same lane and not sliding (slide pose height must fit under gap).
   *
   * @param {Obstacle} obs
   * @param {object}   ps  - playerState
   * @returns {boolean}
   * @private
   */
  _testCollision(obs, ps) {
    if (obs.lane !== ps.lane) return false;
    if (ps.shield) return false;   // Phase Shield: pass through (stub)

    switch (obs.type) {
      case OBS_TYPE.BARRIER:
        return true;

      case OBS_TYPE.LOW:
        // jumpHeight at collision zone must exceed the scaled obstacle height
        return ps.jumpHeight < this.JUMP_CLEAR_HEIGHT;

      case OBS_TYPE.HIGH: {
        // Sliding: effective height is ps.h * 0.5; it must fit under HIGH_GAP.
        // If not sliding, the player's full height doesn't fit — collision.
        const slideH = ps.h * 0.5;
        if (ps.isSliding && slideH < this.HIGH_GAP) return false;
        return true;
      }

      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — Rendering
  // ---------------------------------------------------------------------------

  /**
   * Draws one obstacle using its z-depth for perspective scaling and position.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {Obstacle} obs
   * @private
   */
  _drawObstacle(ctx, obs) {
    const z  = Math.min(obs.z, 1);
    const s  = z;                          // uniform scale at depth z
    const cx = this._projX(obs.lane, z);   // centre X
    const gy = this._projY(z);             // ground Y at this depth

    ctx.save();

    switch (obs.type) {

      case OBS_TYPE.BARRIER: {
        const w = this.BASE_W  * s;
        const h = this.BASE_H_BARRIER * s;
        const x = cx - w / 2;
        const y = gy - h;

        // Glow
        ctx.shadowColor = '#ff2266';
        ctx.shadowBlur  = 18 * s;

        const grad = ctx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, '#ff2266');
        grad.addColorStop(1, '#880033');
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);

        // Bright scan line
        ctx.shadowBlur  = 0;
        ctx.fillStyle   = 'rgba(255,80,120,0.55)';
        ctx.fillRect(x, y + h * 0.12, w, Math.max(1, h * 0.06));
        break;
      }

      case OBS_TYPE.LOW: {
        const w = this.BASE_W  * s;
        const h = this.BASE_H_LOW * s;
        const x = cx - w / 2;
        const y = gy - h;

        ctx.shadowColor = '#ff8800';
        ctx.shadowBlur  = 14 * s;

        const grad = ctx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, '#ffaa00');
        grad.addColorStop(1, '#993300');
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);

        // Warning chevrons
        ctx.shadowBlur = 0;
        ctx.fillStyle  = 'rgba(255,200,0,0.4)';
        const stripeW  = w * 0.25;
        for (let i = 0; i < 3; i++) {
          ctx.fillRect(x + i * stripeW + stripeW * 0.15, y,
                       stripeW * 0.5, h);
        }
        break;
      }

      case OBS_TYPE.HIGH: {
        const w   = this.BASE_W * s;
        const h   = this.BASE_H_HIGH * s;
        const gap = this.HIGH_GAP * s;
        const x   = cx - w / 2;

        // Upper block (above the gap)
        const upperH = h - gap;
        const upperY = gy - h;

        ctx.shadowColor = '#aa00ff';
        ctx.shadowBlur  = 16 * s;

        const gradU = ctx.createLinearGradient(x, upperY, x, upperY + upperH);
        gradU.addColorStop(0, '#cc44ff');
        gradU.addColorStop(1, '#660099');
        ctx.fillStyle = gradU;
        ctx.fillRect(x, upperY, w, upperH);

        // Energy arc in the gap
        ctx.shadowBlur  = 8 * s;
        ctx.strokeStyle = `rgba(200,80,255,${0.45 * s})`;
        ctx.lineWidth   = Math.max(1, 2 * s);
        ctx.beginPath();
        ctx.moveTo(x,     gy - gap);
        ctx.lineTo(x + w, gy - gap);
        ctx.stroke();
        break;
      }
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Private — Projection
  // ---------------------------------------------------------------------------

  /**
   * Projects an integer lane index + depth z to screen X.
   *
   * @param {number} lane - Integer (0, 1, or 2)
   * @param {number} z    - Depth [0,1]
   * @returns {number} Screen X
   * @private
   */
  _projX(lane, z) {
    const lx = this.laneXPositions[lane];
    return this.vpX + (lx - this.vpX) * z;
  }

  /**
   * Projects depth z to screen Y (ground line at that depth).
   *
   * @param {number} z - Depth [0,1]
   * @returns {number} Screen Y
   * @private
   */
  _projY(z) {
    return this.vpY + (this.playerY - this.vpY) * z;
  }
}
