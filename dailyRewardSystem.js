/**
 * dailyRewardSystem.js  [NEW v4]
 * ==============================
 * Manages the 7-day login reward cycle.
 *
 * Reward cycle (1-indexed day 1–7, then repeats):
 *   Day 1: 100 shards
 *   Day 2: 200 shards
 *   Day 3: 5 Quantum Fragments
 *   Day 4: 300 shards
 *   Day 5: 10 Quantum Fragments
 *   Day 6: 500 shards + 5 QF
 *   Day 7: Exclusive skin unlock + 20 QF (jackpot day)
 *
 * Streak rules:
 *   - Player must claim within the same calendar day.
 *   - If a day is skipped, streak resets to 1 on next claim.
 *   - Streak cycles: after day 7 it wraps back to day 1.
 *
 * GameManager integration:
 *   1. Create: this.dailyRewards = new DailyRewardSystem(this.save, this.skins);
 *   2. On IDLE entry: if (this.dailyRewards.hasUnclaimed()) this._openDailyReward();
 *   3. Claim button: this.dailyRewards.claim() → returns reward object or null.
 *
 * Extends:
 *   - Add new reward types to REWARDS (e.g. relic grants, QF multipliers).
 *   - For special event days: check date range before returning default reward.
 *
 * Connects to:
 *   - saveSystem.js  — reads/writes dailyReward state
 *   - skinSystem.js  — grants exclusive skins on day 7
 */

class DailyRewardSystem {

  // ---------------------------------------------------------------------------
  // Reward Definitions (1-indexed, length 7)
  // ---------------------------------------------------------------------------

  /**
   * 7-day cycle rewards. Index 0 = Day 1, index 6 = Day 7.
   *
   * Fields:
   *   label        : display text for the day
   *   shards       : Data Shards awarded
   *   qf           : Quantum Fragments awarded
   *   skinId       : optional skin to unlock
   *   description  : short flavour text
   */
  static REWARDS = [
    { label:'Day 1', shards: 100, qf: 0,  skinId: null,          description: 'Welcome back, Runner!' },
    { label:'Day 2', shards: 200, qf: 0,  skinId: null,          description: 'Keep the streak alive!' },
    { label:'Day 3', shards:   0, qf: 5,  skinId: null,          description: 'Quantum Fragments earned!' },
    { label:'Day 4', shards: 300, qf: 0,  skinId: null,          description: 'Four days strong!' },
    { label:'Day 5', shards:   0, qf: 10, skinId: null,          description: 'Premium currency incoming!' },
    { label:'Day 6', shards: 500, qf: 5,  skinId: null,          description: 'Almost at the jackpot!' },
    { label:'Day 7', shards:   0, qf: 20, skinId: 'cyber_ninja', description: '🎉 Jackpot! Exclusive skin unlocked!' },
  ];

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * @param {SaveSystem} save
   * @param {SkinSystem} skins
   */
  constructor(save, skins) {
    this.save  = save;
    this.skins = skins;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the player hasn't claimed today's reward yet.
   * @returns {boolean}
   */
  hasUnclaimed() {
    const { lastClaimDate } = this.save.dailyReward;
    return lastClaimDate !== this._todayStr();
  }

  /**
   * Returns which streak day (1–7) the player is on for their NEXT claim.
   * If they missed a day, this returns 1 (streak reset).
   * @returns {number}
   */
  getNextDay() {
    const { lastClaimDate, streak } = this.save.dailyReward;
    const yesterday = this._yesterdayStr();

    // No previous claim or missed a day → reset to day 1
    if (!lastClaimDate || lastClaimDate < yesterday) return 1;

    // Consecutive claim → advance (wrap 7 → 1)
    return (streak % 7) + 1;
  }

  /**
   * Returns the reward definition for the next unclaimed day.
   * @returns {object} Entry from REWARDS (0-indexed by nextDay - 1)
   */
  getNextReward() {
    const day = this.getNextDay();
    return DailyRewardSystem.REWARDS[day - 1];
  }

  /**
   * Returns all 7 reward definitions with claimed/active status for the UI.
   * @returns {Array<{ reward, day, isToday, isClaimed }>}
   */
  getAllRewardData() {
    const nextDay    = this.getNextDay();
    const claimed    = !this.hasUnclaimed();
    const { streak } = this.save.dailyReward;

    return DailyRewardSystem.REWARDS.map((reward, i) => {
      const day       = i + 1;
      const isToday   = day === nextDay;
      const isClaimed = day <= streak && (!isToday || claimed);
      return { reward, day, isToday, isClaimed };
    });
  }

  // ---------------------------------------------------------------------------
  // Claim
  // ---------------------------------------------------------------------------

  /**
   * Claims today's reward. Returns the reward given, or null if already claimed.
   * @returns {{ shards: number, qf: number, skinId: string|null }|null}
   */
  claim() {
    if (!this.hasUnclaimed()) return null;

    const nextDay     = this.getNextDay();
    const streakBroken = nextDay === 1 && this.save.dailyReward.streak > 0;
    const reward      = DailyRewardSystem.REWARDS[nextDay - 1];

    // Apply rewards
    if (reward.shards > 0) this.save.addCurrency(reward.shards);
    if (reward.qf > 0)     this.save.addQuantumFragments(reward.qf);
    if (reward.skinId)     this.skins.save.unlockSkin(reward.skinId);

    // Record the claim
    this.save.claimDailyReward(this._todayStr(), streakBroken);

    return { shards: reward.shards, qf: reward.qf, skinId: reward.skinId };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  _todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  _yesterdayStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
}
