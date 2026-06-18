/**
 * gameManager.js  [MODIFIED v3 — world progression]
 * ==================================================
 * Central coordinator for Neon Escape.
 *
 * Changes from v2:
 *
 * GAME_STATES
 *   [NEW] WORLD_SELECT added. The flow is now:
 *     IDLE → WORLD_SELECT → PLAYING → GAME_OVER → WORLD_SELECT or IDLE
 *
 * constructor()
 *   [NEW] this.currentWorld (int) and this.currentWorldDef (object)
 *         Track the active world; default to World 1 on first load.
 *   [CHANGED] start-btn now opens world select instead of starting directly.
 *
 * startGame(worldIndex)
 *   [NEW] Accepts a world index. Applies world difficulty (speed, obstacle
 *         weights, multi-spawn, shard spawn rate) and theme (CSS vars +
 *         internal _theme reference for canvas rendering).
 *   [CHANGED] BASE_SPEED / MAX_SPEED / SPEED_RAMP overwritten from world def.
 *
 * triggerGameOver()
 *   [CHANGED] Applies shardMultiplier from current world before calling
 *             save.addCurrency(). Shows multiplier row on game-over screen.
 *
 * update()
 *   [CHANGED] Returns early when this.overlayOpen is true, effectively
 *             pausing physics while any overlay (shop/stats/etc.) is open.
 *
 * _renderBackground() / _renderTrack()
 *   [CHANGED] All hardcoded colours replaced with this.currentWorldDef.theme.*
 *
 * _bindInput()
 *   [CHANGED] onTap in IDLE opens world select; in GAME_OVER restarts same world.
 *
 * _bindUI()
 *   [CHANGED] start-btn → _openWorldSelect().
 *   [NEW] world-select-back-btn, ingame-menu-btn, ingame-shop-btn,
 *         gameover-world-btn, gameover-menu-btn.
 *
 * NEW methods
 *   _openWorldSelect()  / _closeWorldSelect()
 *   _buildWorldCards()  — dynamic DOM generation from WorldSystem.WORLDS
 *   _applyWorldTheme()  — sets --world-accent CSS variable + stores theme
 *   abandonRun()        — saves partial progress, returns to main menu
 *   returnToMenu()      — from game-over screen, no double-save
 *   _showIngameNav()    / _hideIngameNav()
 *
 * Unchanged
 *   onResize(), render(), _renderVignette(), _drawRail(), _generateStars(),
 *   _openShop(), _closeShop(), _openStats(), _closeStats(),
 *   _refreshShopUI(), _refreshStatsUI(), _refreshMenuUI()
 *
 * Connects to:
 *   worldSystem.js  — WorldSystem.WORLDS, isUnlocked(), getUnlockProgress()
 *   saveSystem.js   — SaveSystem (persistence)
 *   shardManager.js — ShardManager
 *   player.js       — Player, LANE_COUNT, LANES
 *   obstacle.js     — ObstacleManager
 *   input.js        — InputManager
 *   index.html      — all DOM element IDs listed below
 *   style.css       — --world-accent CSS variable
 */

// [CHANGED v3] Added WORLD_SELECT
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

    // ── Game progress ────────────────────────────────────────────────────
    this.score    = 0;
    this.distance = 0;
    this.speed    = 0;

    // These are overwritten from WorldSystem.WORLDS[id] in startGame()
    this.BASE_SPEED = 1.1;
    this.MAX_SPEED  = 3.5;
    this.SPEED_RAMP = 0.07;

    // ── Per-run accumulators ──────────────────────────────────────────────
    this.sessionShards   = 0;
    this.sessionDistance = 0;

    // ── Overlay / input guard ─────────────────────────────────────────────
    this.overlayOpen = false;

    // ── [NEW v3] World tracking ───────────────────────────────────────────
    /** 0-based index of the world currently being played (or last played). */
    this.currentWorld    = 0;
    /** Full world definition object from WorldSystem.WORLDS. */
    this.currentWorldDef = WorldSystem.WORLDS[0];
    /**
     * Internal copy of the active visual theme (kept in sync with
     * currentWorldDef.theme via _applyWorldTheme). Used by _renderBackground
     * and _renderTrack without having to dereference currentWorldDef each frame.
     */
    this._theme = WorldSystem.WORLDS[0].theme;

    // ── Background animation ─────────────────────────────────────────────
    this.gridScroll = 0;
    this.starOffset = 0;
    this._stars     = [];

    // ── Layout ───────────────────────────────────────────────────────────
    this.layout = { vpX: 0, vpY: 0, playerY: 0, laneX: [0, 0, 0] };

    // ── Extension Hooks ──────────────────────────────────────────────────
    this.hooks = {
      onScoreUpdate:  null,
      onGameOver:     null,
      onLaneChange:   null,
      onJump:         null,
      onSlide:        null,
      onShardCollect: null,
      // Future:
      // onWorldChange:   null,
      // onMissionProgress: null,
      // onAchievementUnlock: null,
      // onPowerUpActivate: null,
    };

    this._bindInput();
    this._bindUI();
    this._refreshMenuUI();
    // Apply default theme so CSS variables are set before first render
    this._applyWorldTheme(WorldSystem.WORLDS[0]);
    // Attempt menu music — silently ignored if autoplay is blocked until first tap
    AudioManager.playMenu();
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
    this.obstacles.HIGH_GAP           = this.player.h * 0.58;
    this.obstacles.JUMP_CLEAR_HEIGHT  =
      this.obstacles.BASE_H_LOW * this.obstacles.COLLISION_Z;

    this.shards.setLayout(laneX, vpX, vpY, playerY);
    this._stars = this._generateStars(60);
  }

  // ---------------------------------------------------------------------------
  // State Transitions
  // ---------------------------------------------------------------------------

  /**
   * Begins a run in the specified world.
   * Applies all world-specific difficulty and visual settings before reset.
   *
   * @param {number} [worldIndex=this.currentWorld]
   */
  startGame(worldIndex = this.currentWorld) {
    // ── World setup [NEW v3] ─────────────────────────────────────────────
    this.currentWorld    = worldIndex;
    this.currentWorldDef = WorldSystem.WORLDS[worldIndex];
    const worldDef       = this.currentWorldDef;

    // Apply speed curve from world definition
    this.BASE_SPEED = worldDef.baseSpeed;
    this.MAX_SPEED  = worldDef.maxSpeed;
    this.SPEED_RAMP = worldDef.speedRamp;

    // Apply obstacle difficulty
    this.obstacles.MIN_INTERVAL    = worldDef.spawnIntervalMin;
    this.obstacles.MAX_INTERVAL    = worldDef.spawnIntervalMax;
    this.obstacles.typeWeights     = { ...worldDef.typeWeights };
    this.obstacles.multiSpawnChance = worldDef.multiSpawnChance;

    // Apply shard spawn rate
    this.shards.spawnMin   = worldDef.shardSpawnMin;
    this.shards.spawnRange = worldDef.shardSpawnRange;

    // Apply visual theme (CSS vars + internal _theme reference)
    this._applyWorldTheme(worldDef);

    // ── Music ─────────────────────────────────────────────────────────────
    if (worldIndex === 4) {
      AudioManager.playBoss();      // World 5: Core Matrix gets boss music
    } else {
      AudioManager.playGameplay();  // Worlds 1–4: standard gameplay music
    }

    // ── State reset ──────────────────────────────────────────────────────
    this.state    = GAME_STATES.PLAYING;
    this.score    = 0;
    this.distance = 0;
    this.gridScroll   = 0;
    this.sessionShards   = 0;
    this.sessionDistance = 0;

    // Upgrade: starting speed
    const speedLevel = this.save.getUpgradeLevel('startingSpeed');
    this.speed       = this.BASE_SPEED * (1 + 0.15 * speedLevel);

    // Upgrade: magnet
    this.shards.magnetLevel = this.save.getUpgradeLevel('magnet');

    // Reset player
    this.player.lane         = LANES.CENTER;
    this.player.prevLane     = LANES.CENTER;
    this.player.laneT        = 1;
    this.player.jumpHeight   = 0;
    this.player.jumpVelocity = 0;
    this.player.isJumping    = false;
    this.player.isSliding    = false;
    this.player.shield       = false;

    this.obstacles.reset();
    this.shards.reset();

    // ── HUD ──────────────────────────────────────────────────────────────
    document.getElementById('score').textContent = '0';
    const shardEl = document.getElementById('hud-shards');
    if (shardEl) shardEl.textContent = '0';

    // Show world name in HUD [NEW v3]
    const worldEl = document.getElementById('hud-world');
    if (worldEl) worldEl.textContent = `W${worldIndex + 1}`;

    // ── Screen visibility ─────────────────────────────────────────────────
    document.getElementById('start-screen').classList.add('hidden');
    document.getElementById('gameover-screen').classList.add('hidden');
    document.getElementById('world-select-screen').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    this._showIngameNav();
  }

  /**
   * Transitions to GAME_OVER. Applies shard multiplier, saves run data.
   * [CHANGED v3] Multiplier from currentWorldDef applied before addCurrency.
   */
  triggerGameOver() {
    if (this.state !== GAME_STATES.PLAYING) return;
    this.state = GAME_STATES.GAME_OVER;

    this._hideIngameNav();
    AudioManager.playMenu();

    // ── Shard multiplier [NEW v3] ─────────────────────────────────────────
    const multiplier   = this.currentWorldDef.shardMultiplier;
    const totalAwarded = this.sessionShards * multiplier;

    this.save.addCurrency(totalAwarded);
    // totalShards stat tracks raw pickups (not multiplied) for unlock thresholds
    this.save.updateStats({
      distance: this.distance,
      shards:   this.sessionShards,
      runs:     1,
      score:    this.score,
    });

    const best = this.save.stats.bestScore;
    document.getElementById('final-score').textContent = this.score;
    document.getElementById('final-best').textContent  = best;

    // Raw shard count
    const goShards = document.getElementById('gameover-shards');
    if (goShards) goShards.textContent = this.sessionShards;

    // Multiplier row (shown only when multiplier > 1) [NEW v3]
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

  /**
   * Abandons the current run mid-game and returns to the main menu.
   * Partial run stats (shards, distance) are saved so progress counts
   * toward unlock thresholds. Called by the in-game MENU button.
   * [NEW v3]
   */
  abandonRun() {
    if (this.state !== GAME_STATES.PLAYING) return;

    const multiplier   = this.currentWorldDef.shardMultiplier;
    const totalAwarded = this.sessionShards * multiplier;

    this.save.addCurrency(totalAwarded);
    this.save.updateStats({
      distance: this.distance,
      shards:   this.sessionShards,
      runs:     1,
      score:    this.score,
    });

    this._hideIngameNav();
    AudioManager.playMenu();
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('start-screen').classList.remove('hidden');
    this.state = GAME_STATES.IDLE;
    this._refreshMenuUI();
  }

  /**
   * Returns from the game-over screen to the main menu.
   * Does NOT re-save stats (triggerGameOver already did).
   * [NEW v3]
   */
  returnToMenu() {
    AudioManager.playMenu();
    document.getElementById('gameover-screen').classList.add('hidden');
    document.getElementById('start-screen').classList.remove('hidden');
    this.state = GAME_STATES.IDLE;
    this._refreshMenuUI();
  }

  // ---------------------------------------------------------------------------
  // World Select [NEW v3]
  // ---------------------------------------------------------------------------

  /**
   * Transitions to WORLD_SELECT state, hides other screens, builds world cards.
   */
  _openWorldSelect() {
    this.state = GAME_STATES.WORLD_SELECT;
    AudioManager.playMenu();  // ensures music starts after first user interaction
    document.getElementById('start-screen').classList.add('hidden');
    document.getElementById('gameover-screen').classList.add('hidden');
    this._buildWorldCards();
    document.getElementById('world-select-screen').classList.remove('hidden');
  }

  /**
   * Closes world select and returns to main menu (IDLE).
   */
  _closeWorldSelect() {
    this.state = GAME_STATES.IDLE;
    document.getElementById('world-select-screen').classList.add('hidden');
    document.getElementById('start-screen').classList.remove('hidden');
    this._refreshMenuUI();
  }

  /**
   * Dynamically builds world cards from WorldSystem.WORLDS and the current
   * save state. Clicking an unlocked card immediately starts that world.
   *
   * Each card exposes a CSS variable --card-accent for theming without
   * needing per-world CSS classes.
   */
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

  /**
   * Applies a world's visual theme:
   *   - Stores theme on this._theme for the canvas render methods.
   *   - Sets --world-accent CSS variable for DOM elements (HUD, buttons).
   *
   * @param {{ theme: object }} worldDef
   */
  _applyWorldTheme(worldDef) {
    this._theme = worldDef.theme;
    document.documentElement.style.setProperty('--world-accent', worldDef.theme.accent);
  }

  // ---------------------------------------------------------------------------
  // In-game Navigation [NEW v3]
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
  // Main Update
  // ---------------------------------------------------------------------------

  /**
   * [CHANGED v3] Returns early when overlayOpen is true, pausing all physics
   * while the shop, stats, or any future overlay is visible. This means the
   * player can open the shop mid-run without dying.
   */
  update(dt) {
    if (this.state !== GAME_STATES.PLAYING) return;
    if (this.overlayOpen) return;  // [NEW v3] pauses physics during overlays

    this.speed = Math.min(this.MAX_SPEED, this.speed + this.SPEED_RAMP * dt);

    this.distance += this.speed * dt * 60;
    this.score     = Math.floor(this.distance);
    document.getElementById('score').textContent = this.score;

    if (this.hooks.onScoreUpdate) this.hooks.onScoreUpdate(this.score);

    this.gridScroll = (this.gridScroll + this.speed * dt * 0.55) % 1;
    this.starOffset = (this.starOffset + dt * 0.015) % 1;

    this.player.update(dt);

    const playerState = this.player.getCollisionState();
    const hit = this.obstacles.update(dt, this.speed, playerState);
    if (hit) {
      this.triggerGameOver();
      return;
    }

    const collected = this.shards.update(dt, this.speed, playerState);
    if (collected > 0) {
      this.sessionShards += collected;
      const shardEl = document.getElementById('hud-shards');
      if (shardEl) shardEl.textContent = this.sessionShards;
      if (this.hooks.onShardCollect) this.hooks.onShardCollect(collected);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering Pipeline
  // ---------------------------------------------------------------------------

  render() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    this._renderBackground();
    this._renderTrack();

    if (this.state !== GAME_STATES.IDLE && this.state !== GAME_STATES.WORLD_SELECT) {
      this.obstacles.render(ctx);
      this.shards.render(ctx);
      this.player.render(ctx, this.layout.laneX);
    }

    this._renderVignette();
  }

  // ---------------------------------------------------------------------------
  // Rendering Helpers
  // [CHANGED v3] All colour literals replaced with this._theme.* so the
  // background changes automatically when a new world is selected.
  // ---------------------------------------------------------------------------

  _renderBackground() {
    const { ctx, canvas } = this;
    const { vpX, vpY }    = this.layout;
    const t               = this._theme;  // [NEW v3]

    const sky = ctx.createLinearGradient(0, 0, 0, vpY);
    sky.addColorStop(0, t.skyTop);      // [CHANGED v3]
    sky.addColorStop(1, t.skyBottom);   // [CHANGED v3]
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, canvas.width, vpY);

    // Stars
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
    ground.addColorStop(0, t.groundTop);     // [CHANGED v3]
    ground.addColorStop(1, t.groundBottom);  // [CHANGED v3]
    ctx.fillStyle = ground;
    ctx.fillRect(0, vpY, canvas.width, canvas.height - vpY);

    // Perspective grid
    ctx.save();
    ctx.strokeStyle = t.gridColor;  // [CHANGED v3]
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

    // Horizon glow — derive transparent edge from the mid colour string
    const horizonMid  = t.horizonColor;
    const horizonEdge = horizonMid.replace(/[\d.]+\)$/, '0)');
    const horizonGrad = ctx.createLinearGradient(0, vpY - 12, 0, vpY + 12);
    horizonGrad.addColorStop(0,   horizonEdge);
    horizonGrad.addColorStop(0.5, horizonMid);   // [CHANGED v3]
    horizonGrad.addColorStop(1,   horizonEdge);
    ctx.fillStyle = horizonGrad;
    ctx.fillRect(0, vpY - 12, canvas.width, 24);
  }

  _renderTrack() {
    const { ctx, canvas }     = this;
    const { vpX, vpY, laneX } = this.layout;
    const h = canvas.height;
    const t = this._theme;  // [NEW v3]

    ctx.save();

    // Outer rails
    ctx.strokeStyle = t.railOuter;    // [CHANGED v3]
    ctx.lineWidth   = 1.5;
    this._drawRail(ctx, vpX, vpY, canvas.width * 0.04, h + 20);
    this._drawRail(ctx, vpX, vpY, canvas.width * 0.96, h + 20);

    const outerLeft  = canvas.width * 0.04;
    const outerRight = canvas.width * 0.96;

    // Lane boundary lines
    for (let i = 0; i <= LANE_COUNT; i++) {
      const frac = i / LANE_COUNT;
      const botX = outerLeft + frac * (outerRight - outerLeft);
      ctx.strokeStyle = t.railDivider;  // [CHANGED v3]
      ctx.lineWidth   = 1;
      this._drawRail(ctx, vpX, vpY, botX, h + 10);
    }

    // Lane centre guide lines
    for (const lx of laneX) {
      ctx.strokeStyle = t.railGuide;  // [CHANGED v3]
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
  // Input Binding
  // [CHANGED v3] onTap in IDLE → world select; GAME_OVER → restart same world.
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
        this._openWorldSelect();                    // [CHANGED v3]
      } else if (this.state === GAME_STATES.GAME_OVER) {
        this.startGame(this.currentWorld);          // [CHANGED v3] restart same world
      }
    });
  }

  // ---------------------------------------------------------------------------
  // UI Binding
  // [CHANGED v3] start-btn → world select; new in-game and game-over buttons.
  // ---------------------------------------------------------------------------

  _bindUI() {
    // Main menu: PLAY now opens world select instead of starting directly
    document.getElementById('start-btn')
      .addEventListener('click', () => this._openWorldSelect());  // [CHANGED v3]

    // Restart (game-over screen): restart the same world
    document.getElementById('restart-btn')
      .addEventListener('click', () => this.startGame(this.currentWorld));

    // World select navigation [NEW v3]
    document.getElementById('world-select-back-btn')
      .addEventListener('click', () => this._closeWorldSelect());

    // In-game navigation [NEW v3]
    document.getElementById('ingame-menu-btn')
      .addEventListener('click', () => this.abandonRun());
    document.getElementById('ingame-shop-btn')
      .addEventListener('click', () => this._openShop());

    // Game-over extra navigation [NEW v3]
    document.getElementById('gameover-world-btn')
      .addEventListener('click', () => this._openWorldSelect());
    document.getElementById('gameover-menu-btn')
      .addEventListener('click', () => this.returnToMenu());

    // Mute button
    document.getElementById('mute-btn')
      .addEventListener('click', () => AudioManager.toggleMute());

    // Shop
    document.getElementById('shop-btn').addEventListener('click',       () => this._openShop());
    document.getElementById('stats-btn').addEventListener('click',      () => this._openStats());
    document.getElementById('shop-close-btn').addEventListener('click', () => this._closeShop());
    document.getElementById('stats-close-btn').addEventListener('click',() => this._closeStats());

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
  // Shop / Stats Overlays  (unchanged from v2)
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
  // UI Refresh Helpers  (unchanged from v2)
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
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set('menu-currency', currency);
    set('menu-best',     stats.bestScore);
    set('best',          stats.bestScore);
  }
}
