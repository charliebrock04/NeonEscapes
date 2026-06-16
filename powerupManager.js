/**
 * powerupManager.js  [NEW v4]
 * ===========================
 * Manages collectible in-game powerup capsules and their active effects.
 *
 * Uses the same pseudo-3D z-depth system as obstacle.js and shardManager.js:
 *   z = 0  → at horizon (just spawned, tiny)
 *   z = 1  → at player level (full size, collection zone)
 *
 * Powerup types (POWERUP_TYPE):
 *   MAGNET       — pulls ALL shards toward player, ignoring upgrade level
 *   SHIELD       — blocks one collision (player flashes; obstacle is ignored)
 *   DOUBLE_SHARDS— shards count as 2× while active
 *   SLOW_MOTION  — halves current speed (speed ramp still applies but slower)
 *   DASH         — adds brief invincibility + slight speed boost
 *
 * Active effects are stored in this.active (map of type → remaining seconds).
 * GameManager reads this.active each frame to apply effects:
 *   - SHIELD:        suppress triggerGameOver() on collision
 *   - DOUBLE_SHARDS: multiply sessionShards increment by 2
 *   - SLOW_MOTION:   multiply speed by 0.5 (applied in GameManager.update)
 *   - DASH:          player flashes; suppress triggerGameOver() for duration
 *   - MAGNET:        override shards.magnetLevel to 3
 *
 * Connecting to GameManager (see gameManager.js v4 changes):
 *   powerups.update(dt, speed, playerState)  — called each frame
 *   powerups.render(ctx)                     — called after shards.render()
 *   powerups.reset()                         — called at startGame()
 *   powerups.setLayout(laneX, vpX, vpY, playerY)
 *   powerups.active                          — map read by GameManager
 *
 * Extending:
 *   - Add new type to POWERUP_TYPE + POWERUP_DEF.
 *   - Add case to GameManager for the new effect.
 *   - For upgrade support: add `level` field to active entries.
 */

const POWERUP_TYPE = Object.freeze({
  MAGNET:        'MAGNET',
  SHIELD:        'SHIELD',
  DOUBLE_SHARDS: 'DOUBLE_SHARDS',
  SLOW_MOTION:   'SLOW_MOTION',
  DASH:          'DASH',
});

/**
 * Visual and timing definition per powerup type.
 */
const POWERUP_DEF = {
  [POWERUP_TYPE.MAGNET]:        { label:'MAGNET',       icon:'⦿', color:'#00ffff', glowColor:'rgba(0,255,255,0.6)',  duration:8  },
  [POWERUP_TYPE.SHIELD]:        { label:'SHIELD',       icon:'◈', color:'#00aaff', glowColor:'rgba(0,170,255,0.6)',  duration:6  },
  [POWERUP_TYPE.DOUBLE_SHARDS]: { label:'2× SHARDS',   icon:'◆', color:'#ffdd00', glowColor:'rgba(255,221,0,0.6)',   duration:10 },
  [POWERUP_TYPE.SLOW_MOTION]:   { label:'SLOW-MO',     icon:'◎', color:'#cc44ff', glowColor:'rgba(204,68,255,0.6)', duration:7  },
  [POWERUP_TYPE.DASH]:          { label:'DASH',         icon:'▶', color:'#ff6600', glowColor:'rgba(255,102,0,0.6)',  duration:5  },
};

// ─────────────────────────────────────────────
// PowerupCapsule  (data object)
// ─────────────────────────────────────────────

class PowerupCapsule {
  /** @param {string} type - POWERUP_TYPE value @param {number} lane */
  constructor(type, lane) {
    this.type      = type;
    this.lane      = lane;
    this.z         = 0;
    this.active    = true;
    this.collected = false;
    this.collectT  = 0;  // animation 0→1
  }
}

// ─────────────────────────────────────────────
// PowerupManager
// ─────────────────────────────────────────────

class PowerupManager {
  constructor() {
    /** @type {PowerupCapsule[]} */
    this.capsules = [];

    // ── Depth thresholds (mirrors ObstacleManager) ─
    this.COLLISION_Z = 0.90;
    this.DESPAWN_Z   = 1.15;

    // ── Spawn timing ──────────────────────────────
    /** Seconds until next powerup spawns. Longer interval than shards — powerups are rare. */
    this.spawnTimer = 12 + Math.random() * 8;
    /** Base interval between powerup spawns (seconds). Set per-world in GameManager. */
    this.spawnIntervalMin = 12;
    this.spawnIntervalMax = 20;

    // ── Active effects ─────────────────────────────
    /**
     * Map of currently active effects: type → remaining seconds.
     * GameManager reads this each frame to apply effects.
     * @type {Map<string, number>}
     */
    this.active = new Map();

    // ── Layout (set by GameManager via setLayout) ─
    this.laneXPositions = [0, 0, 0];
    this.vpX            = 0;
    this.vpY            = 0;
    this.playerY        = 0;

    // ── Visual ────────────────────────────────────
    this.BASE_RADIUS = 14;  // capsule half-size at z=1
    this._pulseT     = 0;

    // ── Screen-space HUD positions (set on resize) ─
    this.hudX = 0;
    this.hudY = 0;
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  /** Mirrors ShardManager.setLayout signature. */
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
   * Advances all capsules, checks collection, ticks active effect timers.
   * @param {number} dt          - Delta time in seconds
   * @param {number} speed       - Current game speed
   * @param {object} playerState - From player.getCollisionState()
   * @returns {string|null} Type of powerup just collected this frame, or null
   */
  update(dt, speed, playerState) {
    this._pulseT = (this._pulseT + dt * 2.2) % (Math.PI * 2);

    // ── Spawn ──────────────────────────────────────
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this._spawnCapsule();
      this.spawnTimer = this.spawnIntervalMin
        + Math.random() * (this.spawnIntervalMax - this.spawnIntervalMin);
    }

    // ── Tick active effects ────────────────────────
    for (const [type, remaining] of this.active) {
      const next = remaining - dt;
      if (next <= 0) {
        this.active.delete(type);
      } else {
        this.active.set(type, next);
      }
    }

    // ── Move capsules ──────────────────────────────
    let collected = null;

    for (const cap of this.capsules) {
      if (!cap.active) continue;

      if (cap.collected) {
        cap.collectT += dt * 3.0;
        if (cap.collectT >= 1) cap.active = false;
        continue;
      }

      cap.z += speed * dt;

      // Collection check
      if (cap.z >= this.COLLISION_Z && cap.z < this.DESPAWN_Z) {
        if (cap.lane === playerState.lane) {
          cap.collected = true;
          cap.collectT  = 0;
          collected     = cap.type;
          this._activatePowerup(cap.type);
        }
      }

      if (cap.z >= this.DESPAWN_Z) cap.active = false;
    }

    this.capsules = this.capsules.filter(c => c.active);

    return collected;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  /**
   * Draws all capsules.
   * Call AFTER shards.render() and BEFORE player.render().
   * @param {CanvasRenderingContext2D} ctx
   */
  render(ctx) {
    const pulse = Math.sin(this._pulseT) * 0.3 + 0.7;
    const sorted = [...this.capsules].sort((a, b) => a.z - b.z);

    for (const cap of sorted) {
      if (!cap.active || cap.z < 0.04) continue;
      cap.collected
        ? this._drawCollected(ctx, cap)
        : this._drawCapsule(ctx, cap, pulse);
    }
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  /** Called at the start of each run. */
  reset() {
    this.capsules   = [];
    this.active     = new Map();
    this.spawnTimer = this.spawnIntervalMin + Math.random() * (this.spawnIntervalMax - this.spawnIntervalMin);
    this._pulseT    = 0;
  }

  // ---------------------------------------------------------------------------
  // Private — Spawn
  // ---------------------------------------------------------------------------

  _spawnCapsule() {
    const types = Object.values(POWERUP_TYPE);
    const type  = types[Math.floor(Math.random() * types.length)];
    const lane  = Math.floor(Math.random() * LANE_COUNT);
    this.capsules.push(new PowerupCapsule(type, lane));
  }

  _activatePowerup(type) {
    const def = POWERUP_DEF[type];
    this.active.set(type, def.duration);
  }

  // ---------------------------------------------------------------------------
  // Private — Rendering
  // ---------------------------------------------------------------------------

  _drawCapsule(ctx, cap, pulse) {
    const z   = Math.min(cap.z, 1);
    const s   = z;
    const x   = this._projX(cap.lane, z);
    const y   = this._projY(z) - this.BASE_RADIUS * s * 1.1;
    const r   = this.BASE_RADIUS * s;
    const def = POWERUP_DEF[cap.type];

    ctx.save();

    // Outer glow ring
    ctx.shadowColor = def.color;
    ctx.shadowBlur  = 24 * s * pulse;
    ctx.strokeStyle = def.glowColor;
    ctx.lineWidth   = 2 * s;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.7, 0, Math.PI * 2);
    ctx.stroke();

    // Capsule body — rounded rectangle
    ctx.shadowBlur  = 16 * s;
    ctx.fillStyle   = def.color;
    const hw = r * 1.1, hh = r * 0.75;
    this._roundRect(ctx, x - hw, y - hh, hw * 2, hh * 2, r * 0.4);
    ctx.fill();

    // Icon
    ctx.shadowBlur  = 0;
    ctx.fillStyle   = 'rgba(0,0,0,0.75)';
    ctx.font        = `bold ${Math.max(8, r * 1.1)}px monospace`;
    ctx.textAlign   = 'center';
    ctx.textBaseline= 'middle';
    ctx.fillText(def.icon, x, y);

    ctx.restore();
  }

  _drawCollected(ctx, cap) {
    const z  = Math.min(cap.z, 1);
    const t  = cap.collectT;
    const x  = this._projX(cap.lane, z);
    const y  = this._projY(z) - this.BASE_RADIUS * z * 1.1;
    const r  = this.BASE_RADIUS * z * (1 + t * 3);
    const def= POWERUP_DEF[cap.type];

    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.shadowColor = def.color;
    ctx.shadowBlur  = 28 * (1 - t);
    ctx.strokeStyle = def.color;
    ctx.lineWidth   = Math.max(0.5, 3.5 * z * (1 - t));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Private — Helpers
  // ---------------------------------------------------------------------------

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  _projX(lane, z) {
    const lx = this.laneXPositions[Math.max(0, Math.min(LANE_COUNT - 1, lane))];
    return this.vpX + (lx - this.vpX) * z;
  }

  _projY(z) {
    return this.vpY + (this.playerY - this.vpY) * z;
  }
}
