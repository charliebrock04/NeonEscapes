/**
 * worldSystem.js  [NEW FILE]
 * ==========================
 * Single source of truth for every world: speed curves, obstacle difficulty,
 * shard spawn rates, visual themes, and unlock requirements.
 *
 * Adding a new world:
 *   1. Push a WorldDef object onto WORLDS.
 *   2. If the unlock type is new, add a `case` in isUnlocked() and
 *      getUnlockProgress().
 *   3. Add a card in index.html — or, since _buildWorldCards() is dynamic,
 *      no HTML changes are needed at all.
 *
 * Adding a new unlock type (e.g. rebirth, prestige):
 *   1. Add the field to SaveSystem.DEFAULTS (already has `rebirth` stub).
 *   2. Add a `case` in isUnlocked() and getUnlockProgress().
 *
 * Connects to:
 *   - gameManager.js — reads WORLDS[id] in startGame() and _buildWorldCards();
 *                      calls isUnlocked() / getUnlockProgress() for the UI.
 *   - saveSystem.js  — isUnlocked() reads stats and upgrade levels.
 *
 * NOTE: "World 4: Firewall Zone" requires magnet level 10. The current upgrade
 * cap is 3, so this world is intentionally locked until the shop is expanded
 * with higher-tier legendary upgrades. The unlock condition is correct as-is;
 * only the shop data needs updating when that feature lands.
 */

class WorldSystem {

  /**
   * All world definitions in ascending difficulty order.
   * Index 0 = World 1 (always unlocked); index 4 = World 5 (hardest).
   *
   * @type {Array<{
   *   id:             number,
   *   name:           string,
   *   subtitle:       string,
   *   difficulty:     string,
   *   shardMultiplier:number,
   *   baseSpeed:      number,
   *   maxSpeed:       number,
   *   speedRamp:      number,
   *   spawnIntervalMin: number,
   *   spawnIntervalMax: number,
   *   typeWeights:    {BARRIER:number, LOW:number, HIGH:number},
   *   multiSpawnChance: number,
   *   shardSpawnMin:  number,
   *   shardSpawnRange:number,
   *   unlock:         null|{type,value?,key?,label},
   *   theme:          WorldTheme,
   * }>}
   */
  static WORLDS = [

    // ── World 1: City Streets ────────────────────────────────────────────────
    {
      id:             0,
      name:           'City Streets',
      subtitle:       'Where it all begins',
      difficulty:     'Easy',
      shardMultiplier: 1,

      baseSpeed:   1.1,
      maxSpeed:    3.5,
      speedRamp:   0.07,

      spawnIntervalMin: 1.1,
      spawnIntervalMax: 2.8,

      // BARRIER-heavy: player learns lane-switching first
      typeWeights:      { BARRIER: 3, LOW: 1, HIGH: 1 },
      multiSpawnChance: 0,

      shardSpawnMin:   1.0,
      shardSpawnRange: 1.1,

      unlock: null,  // always available

      theme: {
        accent:      '#00ffff',
        skyTop:      '#030310',
        skyBottom:   '#0a0820',
        groundTop:   '#060420',
        groundBottom:'#020210',
        gridColor:   'rgba(0,255,136,0.18)',
        horizonColor:'rgba(0,255,136,0.12)',
        railOuter:   'rgba(0,255,255,0.35)',
        railDivider: 'rgba(0,255,255,0.15)',
        railGuide:   'rgba(0,255,255,0.08)',
      },
    },

    // ── World 2: Neon Highway ────────────────────────────────────────────────
    {
      id:             1,
      name:           'Neon Highway',
      subtitle:       'The open circuit opens up',
      difficulty:     'Medium',
      shardMultiplier: 2,

      baseSpeed:   1.4,
      maxSpeed:    4.2,
      speedRamp:   0.09,

      spawnIntervalMin: 0.9,
      spawnIntervalMax: 2.4,

      // Equal BARRIER + LOW, some HIGH; multi-spawn starts
      typeWeights:      { BARRIER: 2, LOW: 2, HIGH: 1 },
      multiSpawnChance: 0.1,

      shardSpawnMin:   0.85,
      shardSpawnRange: 1.0,

      unlock: {
        type:  'distance',
        value: 5000,
        label: '5,000 total distance',
      },

      theme: {
        accent:      '#ff00ff',
        skyTop:      '#0d0120',
        skyBottom:   '#1a0030',
        groundTop:   '#0f0020',
        groundBottom:'#060010',
        gridColor:   'rgba(255,0,255,0.18)',
        horizonColor:'rgba(255,0,255,0.12)',
        railOuter:   'rgba(255,0,255,0.35)',
        railDivider: 'rgba(255,0,255,0.15)',
        railGuide:   'rgba(255,0,255,0.08)',
      },
    },

    // ── World 3: Cyber District ──────────────────────────────────────────────
    {
      id:             2,
      name:           'Cyber District',
      subtitle:       'The sprawl never sleeps',
      difficulty:     'Hard',
      shardMultiplier: 4,

      baseSpeed:   1.7,
      maxSpeed:    5.0,
      speedRamp:   0.11,

      spawnIntervalMin: 0.75,
      spawnIntervalMax: 2.0,

      // Even mix; jump and slide are equally required
      typeWeights:      { BARRIER: 2, LOW: 2, HIGH: 2 },
      multiSpawnChance: 0.2,

      shardSpawnMin:   0.75,
      shardSpawnRange: 0.9,

      unlock: {
        type:  'shards',
        value: 2000,
        label: '2,000 shards collected',
      },

      theme: {
        accent:      '#ffcc00',
        skyTop:      '#0a0800',
        skyBottom:   '#1a1200',
        groundTop:   '#120a00',
        groundBottom:'#060400',
        gridColor:   'rgba(255,200,0,0.18)',
        horizonColor:'rgba(255,200,0,0.12)',
        railOuter:   'rgba(255,200,0,0.35)',
        railDivider: 'rgba(255,200,0,0.15)',
        railGuide:   'rgba(255,200,0,0.08)',
      },
    },

    // ── World 4: Firewall Zone ───────────────────────────────────────────────
    {
      id:             3,
      name:           'Firewall Zone',
      subtitle:       'The system fights back',
      difficulty:     'Expert',
      shardMultiplier: 8,

      baseSpeed:   2.1,
      maxSpeed:    5.8,
      speedRamp:   0.14,

      spawnIntervalMin: 0.6,
      spawnIntervalMax: 1.7,

      // Skill-heavy; BARRIER is rare — mostly dodges that require jump/slide
      typeWeights:      { BARRIER: 1, LOW: 2, HIGH: 2 },
      multiSpawnChance: 0.35,

      shardSpawnMin:   0.65,
      shardSpawnRange: 0.8,

      // Requires legendary-tier magnet (future shop expansion — see NOTE above)
      unlock: {
        type:  'upgrade',
        key:   'magnet',
        value: 10,
        label: 'Magnet upgrade level 10',
      },

      theme: {
        accent:      '#ff4400',
        skyTop:      '#0f0000',
        skyBottom:   '#200800',
        groundTop:   '#180200',
        groundBottom:'#080000',
        gridColor:   'rgba(255,68,0,0.18)',
        horizonColor:'rgba(255,68,0,0.12)',
        railOuter:   'rgba(255,68,0,0.35)',
        railDivider: 'rgba(255,68,0,0.15)',
        railGuide:   'rgba(255,68,0,0.08)',
      },
    },

    // ── World 5: Core Matrix ─────────────────────────────────────────────────
    {
      id:             4,
      name:           'Core Matrix',
      subtitle:       'The heart of everything',
      difficulty:     'Nightmare',
      shardMultiplier: 15,

      baseSpeed:   2.6,
      maxSpeed:    6.5,
      speedRamp:   0.18,

      spawnIntervalMin: 0.5,
      spawnIntervalMax: 1.4,

      // HIGH-dominant; half the time two obstacles spawn simultaneously
      typeWeights:      { BARRIER: 1, LOW: 2, HIGH: 3 },
      multiSpawnChance: 0.5,

      shardSpawnMin:   0.55,
      shardSpawnRange: 0.7,

      unlock: {
        type:  'totalShards',
        value: 10000,
        label: '10,000 lifetime shards',
      },

      theme: {
        accent:      '#00ff66',
        skyTop:      '#000a02',
        skyBottom:   '#001008',
        groundTop:   '#000c04',
        groundBottom:'#000400',
        gridColor:   'rgba(0,255,102,0.22)',
        horizonColor:'rgba(0,255,102,0.15)',
        railOuter:   'rgba(0,255,102,0.40)',
        railDivider: 'rgba(0,255,102,0.18)',
        railGuide:   'rgba(0,255,102,0.10)',
      },
    },

  ];

  // ---------------------------------------------------------------------------
  // Unlock Queries
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the player has met the unlock requirement for this world.
   *
   * @param {number}     worldIndex - 0-based index into WORLDS
   * @param {SaveSystem} save
   * @returns {boolean}
   */
  static isUnlocked(worldIndex, save) {
    const world = WorldSystem.WORLDS[worldIndex];
    if (!world)         return false;
    if (!world.unlock)  return true;   // World 1: always available

    const { type, value, key } = world.unlock;
    const stats = save.stats;

    switch (type) {
      case 'distance':
        return stats.totalDistance >= value;

      case 'shards':
      case 'totalShards':
        return stats.totalShards >= value;

      case 'upgrade':
        return save.getUpgradeLevel(key) >= value;

      // ── Future unlock types ─────────────────────────────────────────────────
      // case 'rebirth':
      //   return (save.rebirth?.count ?? 0) >= value;
      // case 'prestige':
      //   return (save.rebirth?.prestigeCurrency ?? 0) >= value;
      // case 'legendary':
      //   return save.getLegendaryLevel(key) >= value;
      // case 'achievement':
      //   return save.hasAchievement(key);

      default:
        return false;
    }
  }

  /**
   * Returns a human-readable progress string for locked world cards.
   * Shows current / required so the player knows how close they are.
   *
   * @param {number}     worldIndex
   * @param {SaveSystem} save
   * @returns {string}  e.g. "1,234 / 5,000 distance"
   */
  static getUnlockProgress(worldIndex, save) {
    const world = WorldSystem.WORLDS[worldIndex];
    if (!world || !world.unlock) return '';

    const { type, value, key } = world.unlock;
    const stats = save.stats;
    const fmt   = n => Math.floor(n).toLocaleString();

    switch (type) {
      case 'distance':
        return `${fmt(Math.min(stats.totalDistance, value))} / ${fmt(value)} distance`;

      case 'shards':
      case 'totalShards':
        return `${fmt(Math.min(stats.totalShards, value))} / ${fmt(value)} shards`;

      case 'upgrade': {
        const cur = save.getUpgradeLevel(key);
        return `${key} level ${cur} / ${value}`;
      }

      default:
        return world.unlock.label ?? '???';
    }
  }
}
