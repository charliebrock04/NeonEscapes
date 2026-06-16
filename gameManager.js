/**
 * gameManager.js  [MODIFIED v4 — long-term progression]
 * =======================================================
 * Central coordinator for Neon Escape.
 *
 * Changes from v3:
 *
 * constructor()
 *   [NEW] this.powerups    — PowerupManager instance
 *   [NEW] this.missions    — MissionSystem instance
 *   [NEW] this.skins       — SkinSystem instance
 *   [NEW] this.relics      — RelicSystem instance
 *   [NEW] this.dailyRewards— DailyRewardSystem instance
 *   [NEW] this.shardGainMult    — per-run shard gain multiplier (relics/powerups)
 *   [NEW] this.surviveChance    — per-run survive-collision probability (relics)
 *   [NEW] this._runDuration     — seconds elapsed in current run (for missions)
 *
 * startGame(worldIndex)
 *   [NEW] Computes relic bonuses and applies them (speed, magnet, shards).
 *   [NEW] Resets powerups, _runDuration.
 *   [NEW] Sets initial player.shield from Phase Shield upgrade.
 *
 * update(dt)
 *   [NEW] Calls powerups.update(); applies active powerup effects:
 *         - SHIELD/DASH active → set player.shield = true
 *         - DOUBLE_SHARDS active → shardGainMult becomes 2 (stacks with relics)
 *         - SLOW_MOTION active → halves effective speed for shard/obstacle advance
 *         - MAGNET active → forces shards.magnetLevel to max
 *   [NEW] Collision check: if surviveChance > 0 roll before triggerGameOver.
 *   [NEW] Increments _runDuration each frame.
 *
 * render()
 *   [NEW] Calls powerups.render(ctx) after shards.render().
 *   [NEW] Passes skinDef to player.render() for skin colours.
 *   [NEW] Calls _renderPowerupHUD() to draw active effect timers.
 *
 * triggerGameOver()
 *   [NEW] Calls missions.notifyRunEnd() with full run stats.
 *   [NEW] Shows quantum fragment display.
 *
 * abandonRun()
 *   [NEW] Also notifies missions.
 *
 * NEW screens/overlays
 *   _openDailyReward() / _closeDailyReward()
 *   _openMissions()    / _closeMissions()
 *   _openSkinSelect()  / _closeSkinSelect()
 *   _openRelicEquip()  / _closeRelicEquip()
 *   _buildDailyRewardUI()
 *   _buildMissionUI()
 *   _buildSkinUI()
 *   _buildRelicUI()
 *   _renderPowerupHUD()
 *
 * Unchanged from v3 (abbreviated):
 *   onResize, _renderBackground, _renderTrack, _renderVignette, _drawRail,
 *   _generateStars, _openWorldSelect, _closeWorldSelect, _buildWorldCards,
 *   _applyWorldTheme, _showIngameNav, _hideIngameNav, _openShop, _closeShop,
 *   _openStats, _closeStats, _refreshShopUI, _refreshStatsUI
 *
 * Connects to: (all previous + new)
 *   powerupManager.js, missionSystem.js, skinSystem.js,
 *   relicSystem.js, dailyRewardSystem.js
 */

const GAME_STATES = Object.freeze({
  IDLE:         'IDLE',
  WORLD_SELECT: 'WORLD_SELECT',
  PLAYING:      'PLAYING',
  GAME_OVER:    'GAME_OVER',
});

class GameManager {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx    = ctx;
    this.state  = GAME_STATES.IDLE;

    // ── Core systems ─────────────────────────────────────────────────────
    this.input     = new InputManager(canvas);
    this.player    = new Player();
    this.obstacles = new ObstacleManager();
    this.save      = new SaveSystem();
    this.shards    = new ShardManager();

    // ── [NEW v4] Progression systems ──────────────────────────────────────
    this.powerups     = new PowerupManager();
    this.skins        = new SkinSystem(this.save);
    this.relics       = new RelicSystem(this.save);
    this.missions     = new MissionSystem(this.save);
    this.dailyRewards = new DailyRewardSystem(this.save, this.skins);

    // ── Game progress ────────────────────────────────────────────────────
    this.score    = 0;
    this.distance = 0;
    this.speed    = 0;

    this.BASE_SPEED = 1.1;
    this.MAX_SPEED  = 3.5;
    this.SPEED_RAMP = 0.07;

    // ── Per-run accumulators ──────────────────────────────────────────────
    this.sessionShards   = 0;
    this.sessionDistance = 0;

    // ── [NEW v4] Per-run modifiers (computed at run start from relics/powerups) ─
    /** Multiplier applied to every shard collected (relics + Double Shards powerup) */
    this.shardGainMult  = 1;
    /** Probability [0,1] of surviving an otherwise-fatal collision (Ghost Protocol relic) */
    this.surviveChance  = 0;
    /** Seconds survived in the current run — used for mission tracking */
    this._runDuration   = 0;
    /** Cached relic bonuses for the current run. Safe default before first run. */
    this._relicBonuses  = { shardGain:1, moveSpeed:1, magnetRange:0, surviveChance:0, shardSpawnRate:1 };
    /** Phase Shield timer in seconds (countdown from upgrade duration) */
    this._shieldTimer   = 0;

    // ── Overlay / input guard ─────────────────────────────────────────────
    this.overlayOpen = false;

    // ── World tracking ────────────────────────────────────────────────────
    this.currentWorld    = 0;
    this.currentWorldDef = WorldSystem.WORLDS[0];
    this._theme          = WorldSystem.WORLDS[0].theme;

    // ── Background animation ─────────────────────────────────────────────
    this.gridScroll = 0;
    this.starOffset = 0;
    this._stars     = [];

    // ── Layout ───────────────────────────────────────────────────────────
    this.layout = { vpX: 0, vpY: 0, playerY: 0, laneX: [0, 0, 0] };

    // ── Extension Hooks ──────────────────────────────────────────────────
    this.hooks = {
      onScoreUpdate:       null,
      onGameOver:          null,
      onLaneChange:        null,
      onJump:              null,
      onSlide:             null,
      onShardCollect:      null,
      onWorldChange:       null,
      onMissionProgress:   null,
      onAchievementUnlock: null,
      onPowerUpActivate:   null,
      // Future stubs:
      // onRebirthReady:  null,
      // onSeasonEvent:   null,
      // onBossSpawn:     null,
    };

    this._bindInput();
    this._bindUI();
    this._refreshMenuUI();
    this._applyWorldTheme(WorldSystem.WORLDS[0]);

    // [NEW v4] Show daily reward modal if there's an unclaimed reward
    // Defer slightly so the canvas has time to render first
    setTimeout(() => {
      if (this.state === GAME_STATES.IDLE && this.dailyRewards.hasUnclaimed()) {
        this._openDailyReward();
      }
    }, 400);
  }

  // ---------------------------------------------------------------------------
  // Resize
  // ---------------------------------------------------------------------------

  onResize(w, h) {
    const vpX     = w / 2;
    const vpY     = h * 0.32;
    const playerY = h * 0.78;
    const spread  = w * 0.27;
    const laneX   = [vpX - spread, vpX, vpX + spread];

    this.layout = { vpX, vpY, playerY, laneX };

    this.player.groundY = playerY;
    this.player.w       = Math.min(52, w * 0.115);
    this.player.h       = Math.min(78, h * 0.10);

    this.obstacles.setLayout(laneX, vpX, vpY, playerY);
    this.obstacles.BASE_W         = Math.min(68, w * 0.155);
    this.obstacles.BASE_H_BARRIER = Math.min(108, h * 0.135);
    this.obstacles.BASE_H_LOW     = Math.min(48, h * 0.065);
    this.obstacles.BASE_H_HIGH    = Math.min(62, h * 0.085);
    this.obstacles.HIGH_GAP          = this.player.h * 0.58;
    this.obstacles.JUMP_CLEAR_HEIGHT = this.obstacles.BASE_H_LOW * this.obstacles.COLLISION_Z;

    this.shards.setLayout(laneX, vpX, vpY, playerY);
    this.powerups.setLayout(laneX, vpX, vpY, playerY);  // [NEW v4]
    this._stars = this._generateStars(60);
  }

  // ---------------------------------------------------------------------------
  // State Transitions
  // ---------------------------------------------------------------------------

  startGame(worldIndex = this.currentWorld) {
    // ── World setup ──────────────────────────────────────────────────────
    this.currentWorld    = worldIndex;
    this.currentWorldDef = WorldSystem.WORLDS[worldIndex];
    const worldDef       = this.currentWorldDef;

    this.BASE_SPEED = worldDef.baseSpeed;
    this.MAX_SPEED  = worldDef.maxSpeed;
    this.SPEED_RAMP = worldDef.speedRamp;

    this.obstacles.MIN_INTERVAL     = worldDef.spawnIntervalMin;
    this.obstacles.MAX_INTERVAL     = worldDef.spawnIntervalMax;
    this.obstacles.typeWeights       = { ...worldDef.typeWeights };
    this.obstacles.multiSpawnChance  = worldDef.multiSpawnChance;

    this.shards.spawnMin   = worldDef.shardSpawnMin;
    this.shards.spawnRange = worldDef.shardSpawnRange;

    this._applyWorldTheme(worldDef);

    // ── [NEW v4] Relic bonuses — computed once per run, cached ───────────
    /** @type {{ shardGain, moveSpeed, magnetRange, surviveChance, shardSpawnRate }} */
    this._relicBonuses  = this.relics.getRunBonuses();
    this.shardGainMult  = this._relicBonuses.shardGain;
    this.surviveChance  = this._relicBonuses.surviveChance;
    this.BASE_SPEED    *= this._relicBonuses.moveSpeed;
    this.shards.spawnMin   *= this._relicBonuses.shardSpawnRate;
    this.shards.spawnRange *= this._relicBonuses.shardSpawnRate;

    // ── Upgrade: starting speed ───────────────────────────────────────────
    const speedLevel = this.save.getUpgradeLevel('startingSpeed');
    this.speed       = this.BASE_SPEED * (1 + 0.15 * speedLevel);

    // ── Upgrade: magnet (+ relic bonus) ──────────────────────────────────
    const basemagnet = this.save.getUpgradeLevel('magnet');
    this.shards.magnetLevel = Math.min(3, basemagnet + bonuses.magnetRange);

    // ── Upgrade: Phase Shield ──────────────────────────────────────────────
    const shieldLevel  = this.save.getUpgradeLevel('shieldDuration');
    this.player.shield = shieldLevel > 0;
    if (shieldLevel > 0) {
      // Shield expires after upgrade-defined seconds
      const durations = [0, 2, 4, 6];
      this._shieldTimer = durations[shieldLevel];
    } else {
      this._shieldTimer = 0;
    }

    // ── State reset ──────────────────────────────────────────────────────
    this.state    = GAME_STATES.PLAYING;
    this.score    = 0;
    this.distance = 0;
    this.gridScroll    = 0;
    this.sessionShards   = 0;
    this.sessionDistance = 0;
    this._runDuration    = 0;  // [NEW v4]

    this.player.lane         = LANES.CENTER;
    this.player.prevLane     = LANES.CENTER;
    this.player.laneT        = 1;
    this.player.jumpHeight   = 0;
    this.player.jumpVelocity = 0;
    this.player.isJumping    = false;
    this.player.isSliding    = false;

    this.obstacles.reset();
    this.shards.reset();
    this.powerups.reset();  // [NEW v4]

    // ── HUD ──────────────────────────────────────────────────────────────
    document.getElementById('score').textContent = '0';
    const shardEl = document.getElementById('hud-shards');
    if (shardEl) shardEl.textContent = '0';

    const worldEl = document.getElementById('hud-world');
    if (worldEl) worldEl.textContent = `W${worldIndex + 1}`;

    // ── Screen visibility ─────────────────────────────────────────────────
    document.getElementById('start-screen').classList.add('hidden');
    document.getElementById('gameover-screen').classList.add('hidden');
    document.getElementById('world-select-screen').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    this._showIngameNav();
  }

  triggerGameOver() {
    if (this.state !== GAME_STATES.PLAYING) return;
    this.state = GAME_STATES.GAME_OVER;

    this._hideIngameNav();

    const multiplier   = this.currentWorldDef.shardMultiplier;
    const totalAwarded = Math.floor(this.sessionShards * multiplier);

    this.save.addCurrency(totalAwarded);
    this.save.updateStats({
      distance: this.distance,
      shards:   this.sessionShards,
      runs:     1,
      score:    this.score,
    });

    // [NEW v4] Notify missions
    this.missions.notifyRunEnd({
      distance:   this.distance,
      shards:     this.sessionShards,
      duration:   this._runDuration,
      score:      this.score,
      worldIndex: this.currentWorld,
    });

    const best = this.save.stats.bestScore;
    document.getElementById('final-score').textContent = this.score;
    document.getElementById('final-best').textContent  = best;

    const goShards = document.getElementById('gameover-shards');
    if (goShards) goShards.textContent = this.sessionShards;

    const multRow  = document.getElementById('gameover-multiplier-row');
    const multText = document.getElementById('gameover-multiplier-text');
    if (multRow && multText) {
      if (multiplier > 1) {
        multText.textContent = `×${multiplier} = ${totalAwarded.toLocaleString()} ◆ awarded`;
        multRow.classList.remove('hidden');
      } else {
        multRow.classList.add('hidden');
      }
    }

    document.getElementById('gameover-screen').classList.remove('hidden');
    this._refreshMenuUI();

    if (this.hooks.onGameOver) this.hooks.onGameOver(this.score, best);
  }

  abandonRun() {
    if (this.state !== GAME_STATES.PLAYING) return;

    const multiplier   = this.currentWorldDef.shardMultiplier;
    const totalAwarded = Math.floor(this.sessionShards * multiplier);

    this.save.addCurrency(totalAwarded);
    this.save.updateStats({
      distance: this.distance,
      shards:   this.sessionShards,
      runs:     1,
      score:    this.score,
    });

    // [NEW v4] Notify missions on abandon too
    this.missions.notifyRunEnd({
      distance:   this.distance,
      shards:     this.sessionShards,
      duration:   this._runDuration,
      score:      this.score,
      worldIndex: this.currentWorld,
    });

    this._hideIngameNav();
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('start-screen').classList.remove('hidden');
    this.state = GAME_STATES.IDLE;
    this._refreshMenuUI();
  }

  returnToMenu() {
    document.getElementById('gameover-screen').classList.add('hidden');
    document.getElementById('start-screen').classList.remove('hidden');
    this.state = GAME_STATES.IDLE;
    this._refreshMenuUI();
  }

  // ---------------------------------------------------------------------------
  // World Select (unchanged from v3)
  // ---------------------------------------------------------------------------

  _openWorldSelect() {
    this.state = GAME_STATES.WORLD_SELECT;
    document.getElementById('start-screen').classList.add('hidden');
    document.getElementById('gameover-screen').classList.add('hidden');
    this._buildWorldCards();
    document.getElementById('world-select-screen').classList.remove('hidden');
  }

  _closeWorldSelect() {
    this.state = GAME_STATES.IDLE;
    document.getElementById('world-select-screen').classList.add('hidden');
    document.getElementById('start-screen').classList.remove('hidden');
    this._refreshMenuUI();
  }

  _buildWorldCards() {
    const container = document.getElementById('world-list');
    if (!container) return;
    container.innerHTML = '';

    WorldSystem.WORLDS.forEach((world, i) => {
      const unlocked = WorldSystem.isUnlocked(i, this.save);
      const progress = unlocked ? world.subtitle
                                : WorldSystem.getUnlockProgress(i, this.save);

      const card      = document.createElement('div');
      const isCurrent = i === this.currentWorld;
      card.className  = `world-card ${unlocked ? 'unlocked' : 'locked'}${isCurrent ? ' current-world' : ''}`;
      card.dataset.worldId = i;

      if (unlocked) {
        card.style.setProperty('--card-accent', world.theme.accent);
        card.style.borderColor = world.theme.accent;
      }

      card.innerHTML = `
        <div class="world-card-header">
          <span class="world-number">W${i + 1}</span>
          <span class="world-name">${world.name}</span>
          <span class="world-mult">${world.shardMultiplier}×</span>
        </div>
        <div class="world-card-body">
          <span class="world-diff diff-${world.difficulty.toLowerCase()}">${world.difficulty}</span>
          <span class="${unlocked ? 'world-subtitle' : 'world-lock'}">
            ${unlocked ? '' : '🔒 '}${progress}
          </span>
        </div>`;

      if (unlocked) {
        card.addEventListener('click', () => {
          this._closeWorldSelect();
          this.startGame(i);
        });
      }

      container.appendChild(card);
    });
  }

  _applyWorldTheme(worldDef) {
    this._theme = worldDef.theme;
    document.documentElement.style.setProperty('--world-accent', worldDef.theme.accent);
  }

  // ---------------------------------------------------------------------------
  // In-game Navigation (unchanged from v3)
  // ---------------------------------------------------------------------------

  _showIngameNav() {
    const nav = document.getElementById('ingame-nav');
    if (nav) nav.classList.remove('hidden');
  }

  _hideIngameNav() {
    const nav = document.getElementById('ingame-nav');
    if (nav) nav.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // Main Update  [MODIFIED v4]
  // ---------------------------------------------------------------------------

  update(dt) {
    if (this.state !== GAME_STATES.PLAYING) return;
    if (this.overlayOpen) return;

    this._runDuration += dt;  // [NEW v4]

    // ── [NEW v4] Phase Shield timer ────────────────────────────────────────
    if (this._shieldTimer > 0) {
      this._shieldTimer -= dt;
      this.player.shield = this._shieldTimer > 0;
    }

    // ── [NEW v4] Apply active powerup overrides ────────────────────────────
    const pa = this.powerups.active;

    // Magnet powerup → force magnet to level 3
    if (pa.has(POWERUP_TYPE.MAGNET)) {
      this.shards.magnetLevel = 3;
    } else {
      // Restore base magnet (upgrade + relic bonus, capped at 3)
      const baseM  = this.save.getUpgradeLevel('magnet');
      const relicB = this._relicBonuses.magnetRange;
      this.shards.magnetLevel = Math.min(3, baseM + relicB);
    }

    // Double Shards powerup → shardGainMult = 2 × relic bonus
    const baseShardMult = this._relicBonuses.shardGain;
    this.shardGainMult = pa.has(POWERUP_TYPE.DOUBLE_SHARDS) ? baseShardMult * 2 : baseShardMult;

    // Shield/Dash powerup → player shield visual
    if (pa.has(POWERUP_TYPE.SHIELD) || pa.has(POWERUP_TYPE.DASH)) {
      this.player.shield = true;
    }

    // Slow Motion → apply half speed to advance calculations only
    const effectiveSpeed = pa.has(POWERUP_TYPE.SLOW_MOTION)
      ? this.speed * 0.5
      : this.speed;

    // ── Speed ramp ────────────────────────────────────────────────────────
    this.speed = Math.min(this.MAX_SPEED, this.speed + this.SPEED_RAMP * dt);

    this.distance += effectiveSpeed * dt * 60;
    this.score     = Math.floor(this.distance);
    document.getElementById('score').textContent = this.score;

    if (this.hooks.onScoreUpdate) this.hooks.onScoreUpdate(this.score);

    this.gridScroll = (this.gridScroll + effectiveSpeed * dt * 0.55) % 1;
    this.starOffset = (this.starOffset + dt * 0.015) % 1;

    this.player.update(dt);

    const playerState = this.player.getCollisionState();

    // ── Obstacle update + collision ────────────────────────────────────────
    const hit = this.obstacles.update(dt, effectiveSpeed, playerState);
    if (hit) {
      // [NEW v4] Ghost Protocol relic: chance to survive
      const shieldActive = pa.has(POWERUP_TYPE.SHIELD) || pa.has(POWERUP_TYPE.DASH);
      if (shieldActive) {
        // Consume shield-type powerup after surviving one hit
        pa.delete(POWERUP_TYPE.SHIELD);
        pa.delete(POWERUP_TYPE.DASH);
        this.player.shield = this._shieldTimer > 0;
      } else if (this.surviveChance > 0 && Math.random() < this.surviveChance) {
        // Relic survive chance — do nothing (obstacle is ignored)
      } else {
        this.triggerGameOver();
        return;
      }
    }

    // ── Shard update ───────────────────────────────────────────────────────
    const rawCollected = this.shards.update(dt, effectiveSpeed, playerState);
    if (rawCollected > 0) {
      const gained = Math.round(rawCollected * this.shardGainMult);
      this.sessionShards += gained;
      const shardEl = document.getElementById('hud-shards');
      if (shardEl) shardEl.textContent = this.sessionShards;
      if (this.hooks.onShardCollect) this.hooks.onShardCollect(gained);

      // Notify missions for mid-run cumulative tracking
      this.missions.notifyShardsCollected(gained);
    }

    // ── [NEW v4] Powerup update ────────────────────────────────────────────
    const pickedUp = this.powerups.update(dt, effectiveSpeed, playerState);
    if (pickedUp && this.hooks.onPowerUpActivate) {
      this.hooks.onPowerUpActivate(pickedUp);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering Pipeline  [MODIFIED v4]
  // ---------------------------------------------------------------------------

  render() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    this._renderBackground();
    this._renderTrack();

    if (this.state !== GAME_STATES.IDLE && this.state !== GAME_STATES.WORLD_SELECT) {
      this.obstacles.render(ctx);
      this.shards.render(ctx);
      this.powerups.render(ctx);  // [NEW v4] — between shards and player

      // [NEW v4] Pass active skin definition to player render
      const skinDef = this.skins.getActiveSkinDef();
      this.player.render(ctx, this.layout.laneX, skinDef);
    }

    this._renderVignette();

    // [NEW v4] Powerup HUD overlays (timers for active effects)
    if (this.state === GAME_STATES.PLAYING && !this.overlayOpen) {
      this._renderPowerupHUD();
    }
  }

  // ---------------------------------------------------------------------------
  // [NEW v4] Powerup HUD
  // ---------------------------------------------------------------------------

  /**
   * Draws active powerup duration bars in the top-right of the canvas.
   * Each active powerup shows its icon and a shrinking time bar.
   */
  _renderPowerupHUD() {
    const { ctx, canvas } = this;
    const pa = this.powerups.active;
    if (pa.size === 0) return;

    const barW  = Math.min(120, canvas.width * 0.28);
    const barH  = 18;
    const pad   = 8;
    const startX = canvas.width - barW - 12;
    let   y      = 60;  // below ingame-nav buttons

    for (const [type, remaining] of pa) {
      const def      = POWERUP_DEF[type];
      const fraction = remaining / def.duration;

      ctx.save();

      // Icon
      ctx.font        = `bold ${barH - 2}px monospace`;
      ctx.fillStyle   = def.color;
      ctx.textAlign   = 'right';
      ctx.textBaseline= 'middle';
      ctx.shadowColor = def.color;
      ctx.shadowBlur  = 8;
      ctx.fillText(def.icon, startX - 6, y + barH / 2);

      // Bar background
      ctx.shadowBlur = 0;
      ctx.fillStyle  = 'rgba(0,0,0,0.5)';
      ctx.fillRect(startX, y, barW, barH);

      // Bar fill
      ctx.fillStyle = def.color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(startX, y, barW * fraction, barH);
      ctx.globalAlpha = 1;

      // Label
      ctx.fillStyle   = '#ffffff';
      ctx.font        = `bold 10px monospace`;
      ctx.textAlign   = 'left';
      ctx.textBaseline= 'middle';
      ctx.fillText(def.label, startX + 4, y + barH / 2);

      ctx.restore();

      y += barH + pad;
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering Helpers (unchanged from v3)
  // ---------------------------------------------------------------------------

  _renderBackground() {
    const { ctx, canvas } = this;
    const { vpX, vpY }    = this.layout;
    const t               = this._theme;

    const sky = ctx.createLinearGradient(0, 0, 0, vpY);
    sky.addColorStop(0, t.skyTop);
    sky.addColorStop(1, t.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, canvas.width, vpY);

    ctx.save();
    for (const star of this._stars) {
      const dy = (star.y + this.starOffset * canvas.height * 0.3) % vpY;
      ctx.globalAlpha = star.alpha;
      ctx.fillStyle   = '#ffffff';
      ctx.beginPath();
      ctx.arc(star.x, dy, star.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    const ground = ctx.createLinearGradient(0, vpY, 0, canvas.height);
    ground.addColorStop(0, t.groundTop);
    ground.addColorStop(1, t.groundBottom);
    ctx.fillStyle = ground;
    ctx.fillRect(0, vpY, canvas.width, canvas.height - vpY);

    ctx.save();
    ctx.strokeStyle = t.gridColor;
    ctx.lineWidth   = 1;

    const lineCount = 14;
    const playerY   = this.layout.playerY;
    for (let i = 0; i < lineCount; i++) {
      const rawFrac = ((i / lineCount) + this.gridScroll) % 1;
      const z       = rawFrac * rawFrac;
      if (z < 0.01) continue;
      const y     = vpY + (playerY + 40 - vpY) * z;
      const halfW = (canvas.width * 0.46) * z;
      ctx.globalAlpha = z * 0.7;
      ctx.beginPath();
      ctx.moveTo(vpX - halfW, y);
      ctx.lineTo(vpX + halfW, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    const horizonMid  = t.horizonColor;
    const horizonEdge = horizonMid.replace(/[\d.]+\)$/, '0)');
    const horizonGrad = ctx.createLinearGradient(0, vpY - 12, 0, vpY + 12);
    horizonGrad.addColorStop(0,   horizonEdge);
    horizonGrad.addColorStop(0.5, horizonMid);
    horizonGrad.addColorStop(1,   horizonEdge);
    ctx.fillStyle = horizonGrad;
    ctx.fillRect(0, vpY - 12, canvas.width, 24);
  }

  _renderTrack() {
    const { ctx, canvas }     = this;
    const { vpX, vpY, laneX } = this.layout;
    const h = canvas.height;
    const t = this._theme;

    ctx.save();

    ctx.strokeStyle = t.railOuter;
    ctx.lineWidth   = 1.5;
    this._drawRail(ctx, vpX, vpY, canvas.width * 0.04, h + 20);
    this._drawRail(ctx, vpX, vpY, canvas.width * 0.96, h + 20);

    const outerLeft  = canvas.width * 0.04;
    const outerRight = canvas.width * 0.96;

    for (let i = 0; i <= LANE_COUNT; i++) {
      const frac = i / LANE_COUNT;
      const botX = outerLeft + frac * (outerRight - outerLeft);
      ctx.strokeStyle = t.railDivider;
      ctx.lineWidth   = 1;
      this._drawRail(ctx, vpX, vpY, botX, h + 10);
    }

    for (const lx of laneX) {
      ctx.strokeStyle = t.railGuide;
      ctx.lineWidth   = 2;
      this._drawRail(ctx, vpX, vpY, lx, h + 10);
    }

    ctx.restore();
  }

  _renderVignette() {
    const { ctx, canvas } = this;
    const grad = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, canvas.height * 0.25,
      canvas.width / 2, canvas.height / 2, canvas.width * 0.85
    );
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.60)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  _drawRail(ctx, vpX, vpY, botX, botY) {
    ctx.beginPath();
    ctx.moveTo(vpX, vpY);
    ctx.lineTo(botX, botY);
    ctx.stroke();
  }

  _generateStars(count) {
    const vpY = this.canvas.height * 0.32;
    return Array.from({ length: count }, () => ({
      x:     Math.random() * this.canvas.width,
      y:     Math.random() * vpY,
      r:     Math.random() * 1.2 + 0.3,
      alpha: Math.random() * 0.6 + 0.2,
    }));
  }

  // ---------------------------------------------------------------------------
  // Input Binding (unchanged from v3)
  // ---------------------------------------------------------------------------

  _bindInput() {
    this.input.on('onSwipeLeft', () => {
      if (this.overlayOpen || this.state !== GAME_STATES.PLAYING) return;
      this.player.changeLane(-1);
      if (this.hooks.onLaneChange) this.hooks.onLaneChange(this.player.lane);
    });

    this.input.on('onSwipeRight', () => {
      if (this.overlayOpen || this.state !== GAME_STATES.PLAYING) return;
      this.player.changeLane(1);
      if (this.hooks.onLaneChange) this.hooks.onLaneChange(this.player.lane);
    });

    this.input.on('onSwipeUp', () => {
      if (this.overlayOpen || this.state !== GAME_STATES.PLAYING) return;
      this.player.jump();
      if (this.hooks.onJump) this.hooks.onJump();
    });

    this.input.on('onSwipeDown', () => {
      if (this.overlayOpen || this.state !== GAME_STATES.PLAYING) return;
      this.player.slide();
      if (this.hooks.onSlide) this.hooks.onSlide();
    });

    this.input.on('onTap', () => {
      if (this.overlayOpen) return;
      if (this.state === GAME_STATES.IDLE) {
        this._openWorldSelect();
      } else if (this.state === GAME_STATES.GAME_OVER) {
        this.startGame(this.currentWorld);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // UI Binding  [MODIFIED v4]
  // ---------------------------------------------------------------------------

  _bindUI() {
    document.getElementById('start-btn')
      .addEventListener('click', () => this._openWorldSelect());

    document.getElementById('restart-btn')
      .addEventListener('click', () => this.startGame(this.currentWorld));

    document.getElementById('world-select-back-btn')
      .addEventListener('click', () => this._closeWorldSelect());

    document.getElementById('ingame-menu-btn')
      .addEventListener('click', () => this.abandonRun());
    document.getElementById('ingame-shop-btn')
      .addEventListener('click', () => this._openShop());

    document.getElementById('gameover-world-btn')
      .addEventListener('click', () => this._openWorldSelect());
    document.getElementById('gameover-menu-btn')
      .addEventListener('click', () => this.returnToMenu());

    document.getElementById('shop-btn').addEventListener('click',        () => this._openShop());
    document.getElementById('stats-btn').addEventListener('click',       () => this._openStats());
    document.getElementById('shop-close-btn').addEventListener('click',  () => this._closeShop());
    document.getElementById('stats-close-btn').addEventListener('click', () => this._closeStats());

    // [NEW v4] Main menu new buttons
    const missionsBtn = document.getElementById('missions-btn');
    if (missionsBtn) missionsBtn.addEventListener('click', () => this._openMissions());

    const skinsBtn = document.getElementById('skins-btn');
    if (skinsBtn) skinsBtn.addEventListener('click', () => this._openSkinSelect());

    const relicsBtn = document.getElementById('relics-btn');
    if (relicsBtn) relicsBtn.addEventListener('click', () => this._openRelicEquip());

    // [NEW v4] Close buttons for new screens
    const missionClose = document.getElementById('missions-close-btn');
    if (missionClose) missionClose.addEventListener('click', () => this._closeMissions());

    const skinClose = document.getElementById('skins-close-btn');
    if (skinClose) skinClose.addEventListener('click', () => this._closeSkinSelect());

    const relicClose = document.getElementById('relics-close-btn');
    if (relicClose) relicClose.addEventListener('click', () => this._closeRelicEquip());

    const dailyClose = document.getElementById('daily-reward-close-btn');
    if (dailyClose) dailyClose.addEventListener('click', () => this._closeDailyReward());

    const dailyClaim = document.getElementById('daily-reward-claim-btn');
    if (dailyClaim) dailyClaim.addEventListener('click', () => this._claimDailyReward());

    // Upgrade purchases
    document.querySelectorAll('.upgrade-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const success = this.save.purchaseUpgrade(btn.dataset.upgrade);
        if (success) {
          this._refreshShopUI();
          this._refreshMenuUI();
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Shop / Stats / Existing Overlays (unchanged from v3)
  // ---------------------------------------------------------------------------

  _openShop() {
    this.overlayOpen = true;
    this._refreshShopUI();
    document.getElementById('shop-screen').classList.remove('hidden');
  }

  _closeShop() {
    this.overlayOpen = false;
    document.getElementById('shop-screen').classList.add('hidden');
  }

  _openStats() {
    this.overlayOpen = true;
    this._refreshStatsUI();
    document.getElementById('stats-screen').classList.remove('hidden');
  }

  _closeStats() {
    this.overlayOpen = false;
    document.getElementById('stats-screen').classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // [NEW v4] Daily Reward Overlay
  // ---------------------------------------------------------------------------

  _openDailyReward() {
    this.overlayOpen = true;
    this._buildDailyRewardUI();
    const el = document.getElementById('daily-reward-screen');
    if (el) el.classList.remove('hidden');
  }

  _closeDailyReward() {
    this.overlayOpen = false;
    const el = document.getElementById('daily-reward-screen');
    if (el) el.classList.add('hidden');
  }

  _claimDailyReward() {
    const result = this.dailyRewards.claim();
    if (!result) { this._closeDailyReward(); return; }

    this._refreshMenuUI();

    // Rebuild UI to show claimed state
    this._buildDailyRewardUI();

    // Disable claim button after claim
    const btn = document.getElementById('daily-reward-claim-btn');
    if (btn) {
      btn.textContent = 'CLAIMED ✓';
      btn.disabled    = true;
    }
  }

  _buildDailyRewardUI() {
    const data    = this.dailyRewards.getAllRewardData();
    const grid    = document.getElementById('daily-reward-grid');
    const nextDay = this.dailyRewards.getNextDay();
    const hasClaimed = !this.dailyRewards.hasUnclaimed();

    if (grid) {
      grid.innerHTML = '';
      data.forEach(({ reward, day, isToday, isClaimed }) => {
        const card = document.createElement('div');
        card.className = `daily-card${isClaimed ? ' claimed' : ''}${isToday ? ' today' : ''}`;

        let content = '';
        if (reward.skinId) content = '👤';
        else if (reward.qf > 0 && reward.shards > 0) content = `${reward.shards}◆ +${reward.qf}QF`;
        else if (reward.qf > 0) content = `${reward.qf} QF`;
        else content = `${reward.shards} ◆`;

        card.innerHTML = `
          <div class="daily-card-label">${reward.label}</div>
          <div class="daily-card-content">${content}</div>
          ${isClaimed ? '<div class="daily-card-check">✓</div>' : ''}`;
        grid.appendChild(card);
      });
    }

    // Claim button state
    const btn = document.getElementById('daily-reward-claim-btn');
    if (btn) {
      if (hasClaimed) {
        btn.textContent = 'COME BACK TOMORROW';
        btn.disabled    = true;
      } else {
        const r = this.dailyRewards.getNextReward();
        btn.textContent = `CLAIM DAY ${nextDay}`;
        btn.disabled    = false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // [NEW v4] Missions Screen
  // ---------------------------------------------------------------------------

  _openMissions() {
    this.overlayOpen = true;
    this._buildMissionUI();
    const el = document.getElementById('missions-screen');
    if (el) el.classList.remove('hidden');
  }

  _closeMissions() {
    this.overlayOpen = false;
    const el = document.getElementById('missions-screen');
    if (el) el.classList.add('hidden');
  }

  _buildMissionUI() {
    const dailyList = document.getElementById('daily-mission-list');
    const achList   = document.getElementById('achievement-list');

    if (dailyList) {
      dailyList.innerHTML = '';
      this.missions.getDailyMissionData().forEach(({ def, state }) => {
        dailyList.appendChild(this._makeMissionCard('daily', def, state));
      });
    }

    if (achList) {
      achList.innerHTML = '';
      this.missions.getAchievementData().forEach(({ def, state }) => {
        achList.appendChild(this._makeMissionCard('achievement', def, state));
      });
    }
  }

  _makeMissionCard(category, def, state) {
    const card = document.createElement('div');
    const pct  = Math.min(1, state.progress / def.target);
    const canClaim = state.completed && !state.claimed;

    card.className = `mission-card${state.claimed ? ' claimed' : ''}${state.completed ? ' completed' : ''}`;
    card.innerHTML = `
      <div class="mission-header">
        <span class="mission-label">${def.label}</span>
        <span class="mission-reward">+${def.rewards.shards}◆${def.rewards.qf > 0 ? ` +${def.rewards.qf}QF` : ''}</span>
      </div>
      <div class="mission-desc">${def.desc}</div>
      <div class="mission-progress-bar"><div class="mission-progress-fill" style="width:${Math.round(pct*100)}%"></div></div>
      <div class="mission-progress-text">${state.progress.toLocaleString()} / ${def.target.toLocaleString()}</div>
      ${canClaim ? `<button class="mission-claim-btn neon-btn-secondary" data-cat="${category}" data-id="${def.id}">CLAIM</button>` : ''}
      ${state.claimed ? '<div class="mission-claimed-label">✓ CLAIMED</div>' : ''}`;

    const claimBtn = card.querySelector('.mission-claim-btn');
    if (claimBtn) {
      claimBtn.addEventListener('click', () => {
        this.missions.claim(category, def.id);
        this._refreshMenuUI();
        this._buildMissionUI();
      });
    }

    return card;
  }

  // ---------------------------------------------------------------------------
  // [NEW v4] Skin Select Screen
  // ---------------------------------------------------------------------------

  _openSkinSelect() {
    this.overlayOpen = true;
    this._buildSkinUI();
    const el = document.getElementById('skins-screen');
    if (el) el.classList.remove('hidden');
  }

  _closeSkinSelect() {
    this.overlayOpen = false;
    const el = document.getElementById('skins-screen');
    if (el) el.classList.add('hidden');
  }

  _buildSkinUI() {
    const list = document.getElementById('skin-list');
    if (!list) return;
    list.innerHTML = '';

    this.skins.getAllSkinData().forEach(({ def, owned, equipped }) => {
      const card = document.createElement('div');
      card.className = `skin-card${equipped ? ' equipped' : ''}${owned ? ' owned' : ' locked'}`;

      let unlockText = '';
      if (!owned) {
        const u = def.unlock;
        if (u.type === 'shards')      unlockText = `${u.cost} ◆`;
        else if (u.type === 'qf')     unlockText = `${u.cost} QF`;
        else if (u.type === 'achievement') unlockText = 'Achievement';
        else if (u.type === 'daily')  unlockText = 'Login Reward';
      }

      card.innerHTML = `
        <div class="skin-preview" style="background:${def.bodyColor};box-shadow:0 0 12px ${def.glowColor}"></div>
        <div class="skin-info">
          <div class="skin-name">${def.name}</div>
          <div class="skin-desc">${def.desc}</div>
          ${equipped ? '<div class="skin-status equipped-label">EQUIPPED</div>' : ''}
          ${owned && !equipped ? '<button class="skin-equip-btn neon-btn-secondary" data-id="'+def.id+'">EQUIP</button>' : ''}
          ${!owned ? `<button class="skin-unlock-btn neon-btn-secondary" data-id="${def.id}">UNLOCK ${unlockText}</button>` : ''}
        </div>`;

      const equipBtn  = card.querySelector('.skin-equip-btn');
      const unlockBtn = card.querySelector('.skin-unlock-btn');

      if (equipBtn) {
        equipBtn.addEventListener('click', () => {
          this.skins.equip(def.id);
          this._buildSkinUI();
        });
      }
      if (unlockBtn) {
        unlockBtn.addEventListener('click', () => {
          const ok = this.skins.unlock(def.id);
          if (ok) { this._refreshMenuUI(); this._buildSkinUI(); }
        });
      }

      list.appendChild(card);
    });
  }

  // ---------------------------------------------------------------------------
  // [NEW v4] Relic Equip Screen
  // ---------------------------------------------------------------------------

  _openRelicEquip() {
    this.overlayOpen = true;
    this._buildRelicUI();
    const el = document.getElementById('relics-screen');
    if (el) el.classList.remove('hidden');
  }

  _closeRelicEquip() {
    this.overlayOpen = false;
    const el = document.getElementById('relics-screen');
    if (el) el.classList.add('hidden');
  }

  _buildRelicUI() {
    const list = document.getElementById('relic-list');
    if (!list) return;
    list.innerHTML = '';

    this.relics.getAllRelicData().forEach(({ def, owned, equippedSlot }) => {
      const card = document.createElement('div');
      const rarityClass = `rarity-${def.rarity}`;
      card.className = `relic-card ${rarityClass}${!owned ? ' locked' : ''}`;

      const isEquipped = equippedSlot >= 0;
      let actionHTML = '';

      if (def.unlock.type === 'future') {
        actionHTML = '<span class="relic-future">Coming Soon</span>';
      } else if (!owned) {
        const cost = def.unlock.type === 'shop' ? `${def.unlock.cost} ◆` : 'Achievement';
        actionHTML = `<button class="relic-buy-btn neon-btn-secondary" data-id="${def.id}">${def.unlock.type === 'shop' ? 'BUY ' + cost : cost}</button>`;
      } else if (isEquipped) {
        actionHTML = `<button class="relic-unequip-btn neon-btn-secondary" data-slot="${equippedSlot}">UNEQUIP</button>`;
      } else {
        // Find the first empty slot
        const equipped = this.save.equippedRelics;
        const emptySlot = equipped.indexOf(null);
        if (emptySlot >= 0) {
          actionHTML = `<button class="relic-equip-btn neon-btn-secondary" data-id="${def.id}" data-slot="${emptySlot}">EQUIP</button>`;
        } else {
          actionHTML = '<span class="relic-no-slot">Slots full</span>';
        }
      }

      card.innerHTML = `
        <div class="relic-header">
          <span class="relic-name">${def.name}</span>
          <span class="relic-rarity ${rarityClass}-label">${def.rarity.toUpperCase()}</span>
        </div>
        <div class="relic-desc">${def.desc}</div>
        ${isEquipped ? `<div class="relic-slot-badge">SLOT ${equippedSlot + 1}</div>` : ''}
        ${actionHTML}`;

      const buyBtn     = card.querySelector('.relic-buy-btn');
      const equipBtn   = card.querySelector('.relic-equip-btn');
      const unequipBtn = card.querySelector('.relic-unequip-btn');

      if (buyBtn) {
        buyBtn.addEventListener('click', () => {
          const ok = this.relics.purchase(def.id);
          if (ok) { this._refreshMenuUI(); this._buildRelicUI(); }
        });
      }
      if (equipBtn) {
        const slot = parseInt(equipBtn.dataset.slot, 10);
        equipBtn.addEventListener('click', () => {
          this.relics.equip(def.id, slot);
          this._buildRelicUI();
        });
      }
      if (unequipBtn) {
        const slot = parseInt(unequipBtn.dataset.slot, 10);
        unequipBtn.addEventListener('click', () => {
          this.relics.unequip(slot);
          this._buildRelicUI();
        });
      }

      list.appendChild(card);
    });

    // Equipped slots summary
    const slotsEl = document.getElementById('relic-slots-display');
    if (slotsEl) {
      const eq = this.save.equippedRelics;
      slotsEl.innerHTML = eq.map((id, i) => {
        const def = id ? this.relics.getDef(id) : null;
        return `<div class="relic-slot${def ? ' filled' : ''}">
          SLOT ${i+1}: ${def ? def.name : '— Empty —'}
        </div>`;
      }).join('');
    }
  }

  // ---------------------------------------------------------------------------
  // UI Refresh Helpers
  // ---------------------------------------------------------------------------

  _refreshShopUI() {
    const balance = this.save.currency;
    const balEl   = document.getElementById('shop-balance');
    if (balEl) balEl.textContent = balance;

    for (const [key, def] of Object.entries(SaveSystem.UPGRADES)) {
      const level = this.save.getUpgradeLevel(key);

      const dotsContainer = document.getElementById(`levels-${key}`);
      if (dotsContainer) {
        dotsContainer.querySelectorAll('.lvl-dot').forEach((dot, i) => {
          dot.classList.toggle('filled', i < level);
        });
      }

      const perkEl = document.getElementById(`perk-${key}`);
      if (perkEl) {
        perkEl.textContent = level < def.maxLevel
          ? def.perks[level]
          : 'Fully upgraded!';
      }

      const costEl = document.getElementById(`cost-${key}`);
      const btn    = document.querySelector(`.upgrade-btn[data-upgrade="${key}"]`);

      if (level >= def.maxLevel) {
        if (costEl) costEl.textContent = 'MAX';
        if (btn)   { btn.textContent = 'MAXED'; btn.disabled = true; }
      } else {
        const cost = def.costs[level];
        if (costEl) costEl.textContent = cost;
        if (btn)   { btn.textContent = 'BUY'; btn.disabled = balance < cost; }
      }
    }
  }

  _refreshStatsUI() {
    const stats = this.save.stats;
    const set   = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set('stat-best',     stats.bestScore.toLocaleString());
    set('stat-distance', stats.totalDistance.toLocaleString());
    set('stat-shards',   stats.totalShards.toLocaleString());
    set('stat-runs',     stats.totalRuns.toLocaleString());
  }

  _refreshMenuUI() {
    const stats    = this.save.stats;
    const currency = this.save.currency;
    const qf       = this.save.quantumFragments;  // [NEW v4]
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set('menu-currency', currency.toLocaleString());
    set('menu-qf',       qf);          // [NEW v4]
    set('menu-best',     stats.bestScore);
    set('best',          stats.bestScore);
  }
}
