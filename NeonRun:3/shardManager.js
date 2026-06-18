/**
 * shardManager.js  [NEW FILE]
 * ===========================
 * Manages Data Shard collectibles — the game's currency pickups.
 *
 * Uses the exact same perspective depth (z) system as ObstacleManager:
 *   z = 0  → at horizon (tiny, just spawned)
 *   z = 1  → at player level (full size, collection zone)
 *
 * Shard visual: glowing cyan diamond with pulsing outer ring.
 * Collection animation: expanding ring that fades out + particle burst.
 *
 * Magnet upgrade levels:
 *   0 = off
 *   1 = pulls shards in the adjacent lane only
 *   2 = pulls shards from any lane
 *   3 = any lane at 2× pull speed
 *
 * Connects to:
 *   - gameManager.js  — creates ShardManager; calls update/render/reset/setLayout;
 *                       sets magnetLevel before each run; reads return value of
 *                       update() to accumulate session shards.
 *   - player.js       — reads playerState.lane (integer) for collection.
 *                       LANE_COUNT constant must be defined (player.js loads first).
 *
 * Extension notes:
 *   - Add BONUS_SHARD type (worth 5×, different colour) by subclassing Shard.
 *   - For missions: inject an onCollect(count) callback from GameManager.
 *   - For powerup shards: add a `powerupType` field; handle in GameManager.update().
 *   - Object pooling: replace `new Shard()` with a free-list (_pool[]) to
 *     eliminate GC pressure at high spawn rates.
 */

// ─────────────────────────────────────────────
// Shard  (data object)
// ─────────────────────────────────────────────

class Shard {
  /**
   * @param {number} lane - Integer spawn lane (0, 1, or 2)
   */
  constructor(lane) {
    /** Original spawn lane — used by magnet to measure distance */
    this.lane       = lane;
    /**
     * Visual/collection lane — may be fractional when magnet is pulling.
     * Collection check rounds this to the nearest integer.
     */
    this.visualLane = lane;
    /** Depth: 0 = horizon, 1 = player level */
    this.z          = 0;
    this.active     = true;
    this.collected  = false;
    /** Collection animation progress 0→1 */
    this.collectT   = 0;
  }
}

// ─────────────────────────────────────────────
// ShardParticle  (burst effect on collect)
// ─────────────────────────────────────────────

class ShardParticle {
  constructor(x, y) {
    this.x    = x;
    this.y    = y;
    this.vx   = (Math.random() - 0.5) * 160;
    this.vy   = (Math.random() - 0.5) * 160 - 55;
    /** Life 1.0 → 0.0 */
    this.life = 1.0;
    this.r    = Math.random() * 2.5 + 0.6;
  }
}

// ─────────────────────────────────────────────
// ShardManager
// ─────────────────────────────────────────────

class ShardManager {
  constructor() {
    /** @type {Shard[]} */
    this.shards    = [];
    /** @type {ShardParticle[]} */
    this.particles = [];

    // ── Spawn timing ──────────────────────────────
    this.spawnTimer = 1.8;  // seconds before first shard appears
    /**
     * Configurable spawn interval (set per-world by GameManager before each run).
     * Actual interval = spawnMin + Math.random() * spawnRange  (~1.0–2.1s default)
     */
    this.spawnMin   = 1.0;
    this.spawnRange = 1.1;

    // ── Depth thresholds (mirrors ObstacleManager) ─
    this.COLLISION_Z = 0.90;
    this.DESPAWN_Z   = 1.15;

    // ── Magnet ────────────────────────────────────
    /** Set by GameManager from SaveSystem upgrade level before each run */
    this.magnetLevel       = 0;
    /** Depth at which the magnet begins attracting */
    this.MAGNET_ACTIVATE_Z = 0.42;
    /** Base lerp speed (lane units/sec) */
    this.MAGNET_SPEED      = 4.5;

    // ── Layout (set by GameManager.onResize → setLayout) ─
    this.laneXPositions = [0, 0, 0];
    this.vpX            = 0;
    this.vpY            = 0;
    this.playerY        = 0;

    // ── Visual ────────────────────────────────────
    this.BASE_RADIUS = 9;   // diamond half-size at z=1 (px)
    this._pulseT     = 0;   // global pulse timer (drives glow animation)
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  /**
   * Called by GameManager every time the canvas resizes.
   * Must match the values passed to ObstacleManager.setLayout() exactly
   * so shards and obstacles use the same coordinate system.
   *
   * @param {number[]} laneXPositions - Screen X for each lane at z=1
   * @param {number}   vpX            - Vanishing point X
   * @param {number}   vpY            - Vanishing point Y
   * @param {number}   playerY        - Ground Y (player's feet)
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
   * Advances all shards, applies magnet, handles collection.
   * Called once per frame by GameManager during PLAYING state.
   *
   * @param {number} dt          - Delta time in seconds
   * @param {number} speed       - Current game speed (z units/sec)
   * @param {object} playerState - From player.getCollisionState()
   * @returns {number} Shards collected this frame (add to session total)
   */
  update(dt, speed, playerState) {
    this._pulseT = (this._pulseT + dt * 2.8) % (Math.PI * 2);

    // ── Spawn ──────────────────────────────────────
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this._spawnShard();
      // Interval driven by per-world spawnMin/spawnRange (set in GameManager.startGame)
      this.spawnTimer = this.spawnMin + Math.random() * this.spawnRange;
    }

    let collected = 0;

    // ── Move and test each shard ───────────────────
    for (const s of this.shards) {
      if (!s.active) continue;

      // Collection animation plays out after pickup
      if (s.collected) {
        s.collectT += dt * 3.5;
        if (s.collectT >= 1) s.active = false;
        continue;
      }

      s.z += speed * dt;

      // Magnet: pull visualLane toward player
      if (this.magnetLevel > 0 && s.z > this.MAGNET_ACTIVATE_Z) {
        this._applyMagnet(s, playerState, dt);
      }

      // Collection: z in window AND rounded visualLane matches player
      if (s.z >= this.COLLISION_Z && s.z < this.DESPAWN_Z) {
        if (Math.round(s.visualLane) === playerState.lane) {
          s.collected = true;
          s.collectT  = 0;
          collected++;
          this._burstParticles(s);
        }
      }

      // Missed — scroll off screen
      if (s.z >= this.DESPAWN_Z) {
        s.active = false;
      }
    }

    // ── Update particles ───────────────────────────
    for (const p of this.particles) {
      p.x    += p.vx * dt;
      p.y    += p.vy * dt;
      p.vy   += 90 * dt;   // weak gravity
      p.life -= dt * 2.4;
    }

    // ── Cleanup ────────────────────────────────────
    this.shards    = this.shards.filter(s => s.active);
    this.particles = this.particles.filter(p => p.life > 0);

    return collected;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  /**
   * Draws all shards and particles.
   * Must be called AFTER obstacle.render() and BEFORE player.render() so
   * that the player character always appears on top.
   *
   * @param {CanvasRenderingContext2D} ctx
   */
  render(ctx) {
    const pulse = Math.sin(this._pulseT) * 0.25 + 0.75; // 0.50 → 1.00

    // Back-to-front so closer shards overlap further ones
    const sorted = [...this.shards].sort((a, b) => a.z - b.z);

    for (const s of sorted) {
      if (!s.active || s.z < 0.04) continue; // skip near-invisible horizon shards
      s.collected ? this._drawCollected(ctx, s) : this._drawShard(ctx, s, pulse);
    }

    // Particles (always on top of shards)
    for (const p of this.particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life * 0.9);
      ctx.shadowColor = '#00ffcc';
      ctx.shadowBlur  = 6;
      ctx.fillStyle   = '#00ffcc';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  /**
   * Clears all shards and particles and resets the spawn timer.
   * Called at the start of each run.
   */
  reset() {
    this.shards     = [];
    this.particles  = [];
    this.spawnTimer = 1.8;
    this._pulseT    = 0;
  }

  // ---------------------------------------------------------------------------
  // Private — Spawn
  // ---------------------------------------------------------------------------

  /** Spawns a new shard in a random lane. */
  _spawnShard() {
    const lane = Math.floor(Math.random() * LANE_COUNT);
    this.shards.push(new Shard(lane));
  }

  // ---------------------------------------------------------------------------
  // Private — Magnet
  // ---------------------------------------------------------------------------

  /**
   * Lerps a shard's visualLane toward the player's lane.
   *
   * Level 1: only attracts if shard spawned in an adjacent lane
   * Level 2: attracts from any spawn lane
   * Level 3: same as 2 but at double speed
   *
   * @param {Shard}  shard
   * @param {object} playerState
   * @param {number} dt
   * @private
   */
  _applyMagnet(shard, playerState, dt) {
    const spawnDist = Math.abs(shard.lane - playerState.lane);
    if (this.magnetLevel === 1 && spawnDist > 1) return; // too far for level 1

    const pullSpeed = this.magnetLevel >= 3
      ? this.MAGNET_SPEED * 2
      : this.MAGNET_SPEED;

    shard.visualLane += (playerState.lane - shard.visualLane) * dt * pullSpeed;
  }

  // ---------------------------------------------------------------------------
  // Private — Particles
  // ---------------------------------------------------------------------------

  /**
   * Emits a particle burst at the shard's screen position on collection.
   * @private
   */
  _burstParticles(shard) {
    const z = Math.min(shard.z, 1);
    const x = this._projX(shard.visualLane, z);
    const y = this._projY(z) - this.BASE_RADIUS * z;
    for (let i = 0; i < 9; i++) {
      this.particles.push(new ShardParticle(x, y));
    }
  }

  // ---------------------------------------------------------------------------
  // Private — Rendering
  // ---------------------------------------------------------------------------

  /**
   * Draws a shard as a glowing cyan diamond with a pulsing outer ring.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {Shard}  shard
   * @param {number} pulse - Current pulse value (0.5→1.0)
   * @private
   */
  _drawShard(ctx, shard, pulse) {
    const z = Math.min(shard.z, 1);
    const s = z;                                         // scale factor
    const x = this._projX(shard.visualLane, z);
    const y = this._projY(z) - this.BASE_RADIUS * s;    // hover slightly above ground
    const r = this.BASE_RADIUS * s;

    ctx.save();

    // ── Pulsing outer ring ──────────────────────────
    ctx.shadowColor = '#00ffcc';
    ctx.shadowBlur  = 18 * s * pulse;
    ctx.strokeStyle = `rgba(0,255,204,${0.3 * pulse})`;
    ctx.lineWidth   = 1.5 * s;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.9, 0, Math.PI * 2);
    ctx.stroke();

    // ── Diamond body ────────────────────────────────
    ctx.shadowBlur = 14 * s;
    ctx.fillStyle  = '#00ffcc';
    ctx.beginPath();
    ctx.moveTo(x,     y - r);   // top
    ctx.lineTo(x + r, y);       // right
    ctx.lineTo(x,     y + r);   // bottom
    ctx.lineTo(x - r, y);       // left
    ctx.closePath();
    ctx.fill();

    // ── Inner highlight facet ────────────────────────
    ctx.shadowBlur = 0;
    ctx.fillStyle  = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.moveTo(x,              y - r * 0.55);  // top-left facet
    ctx.lineTo(x + r * 0.45,  y +  r * 0.05);
    ctx.lineTo(x,              y - r * 0.1);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  /**
   * Draws the expanding ring that plays after a shard is collected.
   * Fades from full opacity to transparent as `collectT` goes 0→1.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {Shard} shard
   * @private
   */
  _drawCollected(ctx, shard) {
    const z  = Math.min(shard.z, 1);
    const t  = shard.collectT;
    const x  = this._projX(shard.visualLane, z);
    const y  = this._projY(z) - this.BASE_RADIUS * z;
    const r  = this.BASE_RADIUS * z * (1 + t * 2.8);

    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.shadowColor = '#00ffcc';
    ctx.shadowBlur  = 22 * (1 - t);
    ctx.strokeStyle = '#00ffcc';
    ctx.lineWidth   = Math.max(0.5, 3 * z * (1 - t));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Private — Projection (identical to ObstacleManager)
  // ---------------------------------------------------------------------------

  /**
   * Projects a (possibly fractional) lane + depth to screen X.
   * Handles the magnet's intermediate visualLane values smoothly.
   *
   * @param {number} fracLane - Lane index, may be fractional (0.0 – 2.0)
   * @param {number} z        - Depth [0,1]
   * @returns {number} Screen X
   * @private
   */
  _projX(fracLane, z) {
    const clamped = Math.max(0, Math.min(LANE_COUNT - 1, fracLane));
    const lo  = Math.floor(clamped);
    const hi  = Math.min(LANE_COUNT - 1, lo + 1);
    const t   = clamped - lo;
    const lxA = this.laneXPositions[lo];
    const lxB = this.laneXPositions[hi];
    const lx  = lxA + (lxB - lxA) * t;
    return this.vpX + (lx - this.vpX) * z;
  }

  /**
   * Projects depth z to the screen Y of the ground line at that depth.
   * At z=0 the ground is at vpY; at z=1 it is at playerY.
   *
   * @param {number} z - Depth [0,1]
   * @returns {number} Screen Y
   * @private
   */
  _projY(z) {
    return this.vpY + (this.playerY - this.vpY) * z;
  }
}
