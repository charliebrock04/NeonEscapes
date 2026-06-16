/**
 * skinSystem.js  [NEW v4]
 * =======================
 * Defines all unlockable player skins and manages equip state.
 *
 * A skin overrides the visual appearance of the player character on the canvas.
 * The Player class's render() method accepts an optional `skinDef` parameter;
 * when provided, it uses the skin's colors/style instead of defaults.
 *
 * Skin unlock types:
 *   'default'    — owned from the start
 *   'shards'     — spend shards to unlock
 *   'qf'         — spend Quantum Fragments to unlock
 *   'achievement'— unlocked by completing a specific achievement mission
 *   'daily'      — unlocked via daily login rewards (handled by DailyRewardSystem)
 *
 * Integration:
 *   - SkinSystem is created by GameManager (after SaveSystem).
 *   - GameManager reads skinSystem.getActiveSkinDef() each frame
 *     and passes it to player.render(ctx, laneX, skinDef).
 *   - The skin-select UI calls skinSystem.unlock() and skinSystem.equip().
 *
 * Extending:
 *   - Add new skins to SKINS. The UI and save integration pick them up automatically.
 *   - For seasonal skins: add unlock type 'seasonal' and handle in GameManager.
 *
 * Connects to:
 *   - saveSystem.js  — reads/writes owned+equipped skin state
 *   - player.js      — render() receives skinDef parameter (Player must read it)
 *   - gameManager.js — creates SkinSystem; passes skinDef to player.render()
 */

class SkinSystem {

  // ---------------------------------------------------------------------------
  // Static Definitions
  // ---------------------------------------------------------------------------

  /**
   * All available skins.
   *
   * Fields:
   *   id          : unique string key
   *   name        : display name
   *   desc        : one-line description shown in skin select
   *   unlock      : { type, cost } — how to unlock (see types above)
   *   bodyColor   : main player body fill color
   *   glowColor   : shadow/glow color
   *   visorColor  : visor strip color
   *   trailColor  : motion trail tint (future)
   *   accentColor : secondary highlight (inner facet)
   */
  static SKINS = [
    {
      id:          'neon_runner',
      name:        'Neon Runner',
      desc:        'The classic cyber athlete',
      unlock:      { type: 'default' },
      bodyColor:   '#00ccff',
      glowColor:   '#00ffff',
      visorColor:  '#ff00ff',
      accentColor: 'rgba(255,255,255,0.6)',
    },
    {
      id:          'cyber_ninja',
      name:        'Cyber Ninja',
      desc:        'Silent and deadly in the digital realm',
      unlock:      { type: 'shards', cost: 500 },
      bodyColor:   '#330033',
      glowColor:   '#ff00ff',
      visorColor:  '#ff0066',
      accentColor: 'rgba(255,0,255,0.5)',
    },
    {
      id:          'quantum_ghost',
      name:        'Quantum Ghost',
      desc:        'Phase-shifted through the data stream',
      unlock:      { type: 'shards', cost: 1000 },
      bodyColor:   'rgba(200,255,255,0.35)',
      glowColor:   '#aaffff',
      visorColor:  '#ffffff',
      accentColor: 'rgba(255,255,255,0.8)',
    },
    {
      id:          'matrix_hacker',
      name:        'Matrix Hacker',
      desc:        'The code made flesh',
      unlock:      { type: 'qf', cost: 20 },
      bodyColor:   '#001a00',
      glowColor:   '#00ff44',
      visorColor:  '#00ff00',
      accentColor: 'rgba(0,255,0,0.7)',
    },
    {
      id:          'void_walker',
      name:        'Void Walker',
      desc:        'Born from the space between servers',
      unlock:      { type: 'achievement', achievementId: 'ach_runs_50' },
      bodyColor:   '#1a0033',
      glowColor:   '#9900ff',
      visorColor:  '#cc00ff',
      accentColor: 'rgba(150,0,255,0.6)',
    },
  ];

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /** @param {SaveSystem} save */
  constructor(save) {
    this.save = save;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Returns the definition for a skin by id.
   * @param {string} id
   * @returns {object|null}
   */
  getDef(id) {
    return SkinSystem.SKINS.find(s => s.id === id) ?? null;
  }

  /**
   * Returns the definition for the currently equipped skin.
   * Falls back to neon_runner if data is corrupt.
   * @returns {object}
   */
  getActiveSkinDef() {
    const id  = this.save.equippedSkin;
    return this.getDef(id) ?? SkinSystem.SKINS[0];
  }

  /**
   * Returns all skin definitions with their unlock/owned status.
   * @returns {Array<{ def, owned, equipped }>}
   */
  getAllSkinData() {
    const ownedSkins = this.save.ownedSkins;
    const equipped   = this.save.equippedSkin;
    return SkinSystem.SKINS.map(def => ({
      def,
      owned:    ownedSkins.includes(def.id),
      equipped: def.id === equipped,
    }));
  }

  /**
   * Checks whether a skin can be unlocked right now (correct unlock type +
   * enough resources).
   * @param {string} id
   * @returns {{ canUnlock: boolean, reason: string|null }}
   */
  canUnlock(id) {
    const def = this.getDef(id);
    if (!def)                               return { canUnlock: false, reason: 'Unknown skin' };
    if (this.save.ownedSkins.includes(id)) return { canUnlock: false, reason: 'Already owned' };

    const { type, cost, achievementId } = def.unlock;
    if (type === 'default')               return { canUnlock: false, reason: 'Already owned' };
    if (type === 'shards')  return { canUnlock: this.save.currency >= cost,           reason: `Need ${cost} ◆` };
    if (type === 'qf')      return { canUnlock: this.save.quantumFragments >= cost,   reason: `Need ${cost} QF` };
    if (type === 'achievement') {
      const state = this.save.getMissionState('achievement', achievementId);
      return { canUnlock: state.completed, reason: 'Complete the achievement first' };
    }
    return { canUnlock: false, reason: 'Locked' };
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /**
   * Attempts to unlock and purchase a skin.
   * @param {string} id
   * @returns {boolean} true if newly unlocked
   */
  unlock(id) {
    const def = this.getDef(id);
    if (!def) return false;
    if (this.save.ownedSkins.includes(id)) return false;

    const { type, cost } = def.unlock;
    if (type === 'shards') {
      if (!this.save.spendCurrency(cost)) return false;
    } else if (type === 'qf') {
      if (!this.save.spendQuantumFragments(cost)) return false;
    } else if (type === 'achievement') {
      const { canUnlock } = this.canUnlock(id);
      if (!canUnlock) return false;
    } else if (type === 'daily') {
      // daily skins are granted externally by DailyRewardSystem; just register
    } else {
      return false; // unknown type
    }

    return this.save.unlockSkin(id);
  }

  /**
   * Equips a skin (must be owned).
   * @param {string} id
   * @returns {boolean}
   */
  equip(id) {
    return this.save.equipSkin(id);
  }
}
