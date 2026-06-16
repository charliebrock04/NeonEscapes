/**
 * relicSystem.js  [NEW v4]
 * ========================
 * Defines collectible relics that provide passive stat bonuses.
 *
 * Up to 3 relics can be equipped simultaneously (via relic slots in SaveSystem).
 * Relic effects are computed once at run start (GameManager.startGame calls
 * relicSystem.getRunBonuses()) and stored as multipliers/addons for that run.
 *
 * Rarities (displayed with colour-coded borders in the UI):
 *   Common → Rare → Epic → Legendary → Mythic
 *
 * Effect types (consumed by GameManager):
 *   shardGain      : multiplier applied to shard count (e.g. 1.05 = +5%)
 *   moveSpeed      : multiplier on BASE_SPEED (e.g. 1.03 = +3%)
 *   magnetRange    : additive magnetLevel bonus (e.g. 1 = +1 level)
 *   surviveChance  : probability [0,1] of surviving an otherwise-fatal collision
 *   shieldDuration : additive seconds added to Phase Shield upgrade
 *   shardSpawnRate : multiplier on shard spawn interval (lower = more shards;
 *                    e.g. 0.9 = 10% faster spawns)
 *
 * Integration with GameManager.startGame():
 *   const bonuses = this.relics.getRunBonuses();
 *   // bonuses.shardGain, bonuses.moveSpeed, bonuses.surviveChance, etc.
 *   this.BASE_SPEED  *= bonuses.moveSpeed;
 *   this.shardGainMult = bonuses.shardGain;
 *   this.surviveChance = bonuses.surviveChance;
 *   this.shards.magnetLevel = Math.min(3, this.shards.magnetLevel + bonuses.magnetRange);
 *
 * Extending:
 *   - Add new relics to RELICS.
 *   - Add new effect keys and handle them in GameManager.
 *   - Relic upgrades: add level field to SaveSystem relic entries; getRunBonuses
 *     checks the level to scale the bonus.
 *
 * Connects to:
 *   - saveSystem.js  — reads/writes owned+equipped relics
 *   - gameManager.js — creates RelicSystem; calls getRunBonuses() at run start
 */

class RelicSystem {

  // ---------------------------------------------------------------------------
  // Static Definitions
  // ---------------------------------------------------------------------------

  /** Rarity tiers — ordered from weakest to strongest. */
  static RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'];

  /**
   * All available relics.
   *
   * Fields:
   *   id       : unique string key
   *   name     : display name
   *   desc     : one-line description
   *   rarity   : one of RARITIES
   *   effect   : { type, value } — the passive bonus this relic provides
   *   unlock   : { type, ... } — how to obtain it
   */
  static RELICS = [
    {
      id:     'data_crown',
      name:   'Data Crown',
      desc:   '+5% shard gain per run',
      rarity: 'common',
      effect: { type: 'shardGain', value: 1.05 },
      unlock: { type: 'shop', cost: 300 },
    },
    {
      id:     'neural_chip',
      name:   'Neural Chip',
      desc:   '+3% movement speed',
      rarity: 'common',
      effect: { type: 'moveSpeed', value: 1.03 },
      unlock: { type: 'shop', cost: 300 },
    },
    {
      id:     'quantum_battery',
      name:   'Quantum Battery',
      desc:   '+1 magnet range level while equipped',
      rarity: 'rare',
      effect: { type: 'magnetRange', value: 1 },
      unlock: { type: 'shop', cost: 600 },
    },
    {
      id:     'ghost_protocol',
      name:   'Ghost Protocol',
      desc:   '15% chance to survive a collision',
      rarity: 'rare',
      effect: { type: 'surviveChance', value: 0.15 },
      unlock: { type: 'shop', cost: 750 },
    },
    {
      id:     'overclock_core',
      name:   'Overclock Core',
      desc:   'Shards spawn 10% faster',
      rarity: 'epic',
      effect: { type: 'shardSpawnRate', value: 0.9 },
      unlock: { type: 'achievement', achievementId: 'ach_dist_5000' },
    },

    // ── Future/Placeholder Relics (not yet obtainable) ─────────────────────
    {
      id:     'void_heart',
      name:   'Void Heart',
      desc:   '+10% shard gain, +5% move speed',
      rarity: 'legendary',
      effect: { type: 'composite', effects: [
        { type: 'shardGain', value: 1.10 },
        { type: 'moveSpeed', value: 1.05 },
      ]},
      unlock: { type: 'future' },
    },
    {
      id:     'singularity_gem',
      name:   'Singularity Gem',
      desc:   '30% survive chance + double shards',
      rarity: 'mythic',
      effect: { type: 'composite', effects: [
        { type: 'surviveChance', value: 0.30 },
        { type: 'shardGain',    value: 2.0  },
      ]},
      unlock: { type: 'future' },
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

  /** @param {string} id @returns {object|null} */
  getDef(id) {
    return RelicSystem.RELICS.find(r => r.id === id) ?? null;
  }

  /**
   * Returns all relic definitions with their owned/equipped status.
   * @returns {Array<{ def, owned, equippedSlot }>}
   */
  getAllRelicData() {
    const owned    = this.save.ownedRelics;
    const equipped = this.save.equippedRelics;
    return RelicSystem.RELICS.map(def => ({
      def,
      owned:       owned.includes(def.id),
      equippedSlot: equipped.indexOf(def.id),  // -1 if not equipped
    }));
  }

  /**
   * Computes the aggregate passive bonuses from all currently equipped relics.
   * Called once at the start of each run.
   *
   * @returns {{
   *   shardGain:      number,   // multiplier (default 1.0)
   *   moveSpeed:      number,   // multiplier (default 1.0)
   *   magnetRange:    number,   // additive integer bonus (default 0)
   *   surviveChance:  number,   // probability [0,1] (default 0)
   *   shardSpawnRate: number,   // multiplier (default 1.0, lower = faster)
   * }}
   */
  getRunBonuses() {
    const bonuses = {
      shardGain:      1.0,
      moveSpeed:      1.0,
      magnetRange:    0,
      surviveChance:  0,
      shardSpawnRate: 1.0,
    };

    const equipped = this.save.equippedRelics;
    for (const relicId of equipped) {
      if (!relicId) continue;
      const def = this.getDef(relicId);
      if (!def) continue;
      this._applyEffect(def.effect, bonuses);
    }

    return bonuses;
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /**
   * Purchases and adds a relic to the player's collection.
   * @param {string} id
   * @returns {boolean}
   */
  purchase(id) {
    const def = this.getDef(id);
    if (!def) return false;
    if (def.unlock.type !== 'shop') return false;

    if (!this.save.spendCurrency(def.unlock.cost)) return false;
    this.save.addRelic(id);
    return true;
  }

  /**
   * Grants a relic without payment (used by DailyRewardSystem, achievements).
   * @param {string} id
   */
  grant(id) {
    if (!this.getDef(id)) return;
    this.save.addRelic(id);
  }

  /** @param {string} id @param {number} slot */
  equip(id, slot)  { return this.save.equipRelic(id, slot); }
  /** @param {number} slot */
  unequip(slot)    { this.save.unequipRelic(slot); }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  _applyEffect(effect, bonuses) {
    if (effect.type === 'composite') {
      for (const sub of effect.effects) {
        this._applyEffect(sub, bonuses);
      }
      return;
    }

    switch (effect.type) {
      case 'shardGain':      bonuses.shardGain      *= effect.value; break;
      case 'moveSpeed':      bonuses.moveSpeed      *= effect.value; break;
      case 'magnetRange':    bonuses.magnetRange    += effect.value; break;
      case 'surviveChance':  bonuses.surviveChance   = Math.min(1, bonuses.surviveChance + effect.value); break;
      case 'shardSpawnRate': bonuses.shardSpawnRate *= effect.value; break;
    }
  }
}
