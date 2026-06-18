/**
 * saveSystem.js  [NEW FILE]
 * =========================
 * The single source of truth for all persistent data in Neon Escape.
 * Every localStorage read/write goes through this class — nothing else
 * calls localStorage directly.
 *
 * Owns:
 *   - currency      : spendable Data Shard balance
 *   - stats         : lifetime run statistics
 *   - upgrades      : purchased upgrade levels
 *
 * Design principles:
 *   - Deep-merge on load: new schema keys added in future updates are always
 *     present with their default values (no "undefined" surprises).
 *   - Every mutating method calls _save() immediately.
 *   - Static UPGRADES object is the single definition of all upgrade metadata
 *     (costs, perk text, icons) — imported by gameManager for the shop UI.
 *
 * Extending:
 *   - Add new stats: put defaults in DEFAULTS.stats, call updateStats() with
 *     the new field name.
 *   - Add new upgrade: add an entry to UPGRADES and DEFAULTS.upgrades.
 *   - Add daily rewards / missions: add DEFAULTS.dailyReward / DEFAULTS.missions
 *     and corresponding get/set methods below.
 *
 * Connects to:
 *   - gameManager.js  — instantiates SaveSystem; reads/writes on run events
 *   - index.html      — loaded first in <script> order (no dependencies)
 */

class SaveSystem {

  /** Key used for localStorage. Bump version suffix on breaking schema changes. */
  static KEY = 'neonEscape_v2';

  // ---------------------------------------------------------------------------
  // Upgrade Definitions
  // ---------------------------------------------------------------------------
  /**
   * Single source of truth for every purchasable upgrade.
   * gameManager._refreshShopUI() iterates this to build the shop UI.
   *
   * Fields per entry:
   *   label       : display name
   *   icon        : single unicode glyph shown on the card
   *   description : one-line card subtitle
   *   maxLevel    : how many times this upgrade can be purchased
   *   costs[]     : shard cost for each level (index = current level before purchase)
   *   perks[]     : description of each level's effect (shown on the card)
   *
   * To add a new upgrade:
   *   1. Add entry here.
   *   2. Add matching key to DEFAULTS.upgrades with value 0.
   *   3. Handle it in GameManager.startGame() (apply the effect).
   *   4. Add the card HTML to index.html (the shop UI reads ids like `levels-{key}`).
   */
  static UPGRADES = {
    magnet: {
      label:       'Data Magnet',
      icon:        '⦿',
      description: 'Attract nearby shards automatically',
      maxLevel:    3,
      costs:       [50, 150, 350],
      perks:       [
        'Pulls shards from adjacent lane',
        'Pulls shards from any lane',
        'Pulls shards twice as fast',
      ],
    },
    startingSpeed: {
      label:       'Overdrive Core',
      icon:        '⚡',
      description: 'Begin each run at higher speed',
      maxLevel:    3,
      costs:       [75, 200, 500],
      perks:       [
        '+15% starting speed',
        '+30% starting speed',
        '+50% starting speed',
      ],
    },
    shieldDuration: {
      label:       'Phase Shield',
      icon:        '◈',
      description: 'Temporary invincibility at run start',
      maxLevel:    3,
      costs:       [100, 250, 600],
      perks:       [
        '2 seconds of invincibility',
        '4 seconds of invincibility',
        '6 seconds of invincibility',
      ],
    },
  };

  // ---------------------------------------------------------------------------
  // Schema Defaults
  // ---------------------------------------------------------------------------
  /**
   * Every key in DEFAULTS is guaranteed to exist after _load().
   * Adding a key here means existing saves gain it automatically on next load.
   */
  static DEFAULTS = {
    currency: 0,
    stats: {
      bestScore:     0,
      totalDistance: 0,
      totalShards:   0,
      totalRuns:     0,
    },
    upgrades: {
      magnet:         0,
      startingSpeed:  0,
      shieldDuration: 0,
    },

    // ── Future expansion stubs ──────────────────────────────────────────────
    // All keys are safe to add — _deepMerge will inject them into old saves.

    // Rebirth / prestige system (referenced by WorldSystem.isUnlocked)
    rebirth: {
      count:            0,   // number of times the player has rebirthed
      prestigeCurrency: 0,   // special currency earned on rebirth
    },

    // Uncomment when implementing these features:
    // dailyReward: { lastClaimDate: null, streak: 0 },
    // missions:    {},   // e.g. run_500m: { progress: 0, completed: false }
    // achievements:{},   // e.g. first_shard: false
    // legendaryUpgrades: {},
    // equippedSkin: 'default',
  };

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor() {
    this._data = this._load();
    // Write back immediately so the v2 key exists even if there was no prior save
    this._save();
  }

  // ---------------------------------------------------------------------------
  // Private — Load / Save
  // ---------------------------------------------------------------------------

  /**
   * Loads and deep-merges saved data with current defaults.
   * Automatically migrates the old `neonEscape_best` key from v1.
   * @private
   * @returns {object} Fully populated data object
   */
  _load() {
    let data;
    try {
      const raw = localStorage.getItem(SaveSystem.KEY);
      if (raw) {
        // Deep-merge: saved data wins, but default keys are always present
        data = this._deepMerge(
          JSON.parse(JSON.stringify(SaveSystem.DEFAULTS)),
          JSON.parse(raw)
        );
      } else {
        data = JSON.parse(JSON.stringify(SaveSystem.DEFAULTS));
      }
    } catch (e) {
      console.warn('SaveSystem: corrupt save, resetting.', e);
      data = JSON.parse(JSON.stringify(SaveSystem.DEFAULTS));
    }

    // ── v1 migration: pull bestScore from old separate key ──────────────────
    const oldBest = parseInt(localStorage.getItem('neonEscape_best') || '0', 10);
    if (oldBest > data.stats.bestScore) {
      data.stats.bestScore = oldBest;
    }

    return data;
  }

  /**
   * Serialises _data to localStorage. Silent on failure (private browsing etc.)
   * @private
   */
  _save() {
    try {
      localStorage.setItem(SaveSystem.KEY, JSON.stringify(this._data));
    } catch (e) {
      console.warn('SaveSystem: localStorage write failed.', e);
    }
  }

  /**
   * Recursively merges `src` into `dst` (in place).
   * - Objects: recurse
   * - Arrays / primitives: src overwrites dst
   * - Keys in dst but not src: preserved (safe schema evolution)
   * @private
   */
  _deepMerge(dst, src) {
    for (const key of Object.keys(src)) {
      if (
        typeof src[key] === 'object' && src[key] !== null &&
        !Array.isArray(src[key]) &&
        typeof dst[key] === 'object' && dst[key] !== null
      ) {
        this._deepMerge(dst[key], src[key]);
      } else {
        dst[key] = src[key];
      }
    }
    return dst;
  }

  // ---------------------------------------------------------------------------
  // Currency
  // ---------------------------------------------------------------------------

  /** Current Data Shard balance (read-only). */
  get currency() { return this._data.currency; }

  /**
   * Credits shards to the balance (called after a run ends).
   * @param {number} amount - Must be a positive integer
   */
  addCurrency(amount) {
    if (amount <= 0) return;
    this._data.currency += Math.floor(amount);
    this._save();
  }

  /**
   * Debits shards for a purchase.
   * @param   {number}  amount
   * @returns {boolean} true if successful; false if balance too low
   */
  spendCurrency(amount) {
    if (this._data.currency < amount) return false;
    this._data.currency -= amount;
    this._save();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  /** Returns a shallow copy of the current lifetime stats. */
  get stats() { return { ...this._data.stats }; }

  /**
   * Merges a completed run's results into lifetime stats.
   *
   * Numeric totals accumulate. bestScore is replaced only if the new value is
   * higher. Safe to call with partial objects — unused keys are ignored.
   *
   * @param {object} run
   * @param {number} [run.distance=0] - Raw distance (floored to int)
   * @param {number} [run.shards=0]   - Shards collected this run
   * @param {number} [run.runs=0]     - Pass 1 for each completed run
   * @param {number} [run.score=0]    - Final score (tested against bestScore)
   */
  updateStats({ distance = 0, shards = 0, runs = 0, score = 0 } = {}) {
    this._data.stats.totalDistance += Math.floor(distance);
    this._data.stats.totalShards   += shards;
    this._data.stats.totalRuns     += runs;
    if (score > this._data.stats.bestScore) {
      this._data.stats.bestScore = score;
    }
    this._save();
  }

  // ---------------------------------------------------------------------------
  // Upgrades
  // ---------------------------------------------------------------------------

  /**
   * Returns the purchased level of an upgrade (0 = not yet bought).
   * @param  {string} name - Key from SaveSystem.UPGRADES
   * @returns {number} 0 … maxLevel
   */
  getUpgradeLevel(name) {
    return this._data.upgrades[name] ?? 0;
  }

  /**
   * Attempts to purchase the next level of an upgrade.
   * Deducts the cost from currency on success.
   *
   * @param   {string}  name - Key from SaveSystem.UPGRADES
   * @returns {boolean} true if the purchase succeeded
   */
  purchaseUpgrade(name) {
    const def = SaveSystem.UPGRADES[name];
    if (!def) return false;

    const current = this.getUpgradeLevel(name);
    if (current >= def.maxLevel) return false;  // already maxed

    const cost = def.costs[current];
    if (!this.spendCurrency(cost)) return false; // insufficient funds

    this._data.upgrades[name] = current + 1;
    this._save();
    return true;
  }
}
