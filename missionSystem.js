/**
 * missionSystem.js  [NEW v4]
 * ==========================
 * Manages daily and achievement missions.
 *
 * Two categories:
 *   daily       — reset each calendar day. Always 3 active missions drawn from
 *                 DAILY_POOL. Completion rewards: Shards + Quantum Fragments.
 *   achievement — permanent, never reset. Milestone completions unlock once.
 *
 * Progress is stored in SaveSystem.missions so it persists across sessions.
 * MissionSystem is created by GameManager and receives event calls from the
 * game loop via the public `notifyXxx` methods.
 *
 * Integration points in GameManager:
 *   - After each run end: notifyRunComplete(distance, shards, duration)
 *   - On shard collect:   notifyShardsCollected(count)
 *   - On game init:       checkDailyReset()
 *
 * Extending:
 *   - Add new mission types to DAILY_POOL or ACHIEVEMENTS.
 *   - Add new event types and a matching notifyXxx method.
 *   - For seasonal missions: add a SEASONAL_POOL and activate on date range.
 *
 * Connects to:
 *   - saveSystem.js    — all state reads/writes
 *   - gameManager.js   — calls notify* methods; opens mission UI
 */

class MissionSystem {

  // ---------------------------------------------------------------------------
  // Static Definitions
  // ---------------------------------------------------------------------------

  /**
   * Pool of possible daily missions. Each day, 3 are pseudo-randomly selected
   * based on the calendar date (deterministic — same 3 for all players on a day).
   *
   * Fields:
   *   id      : unique string key (matches SaveSystem missions.daily key)
   *   label   : display name
   *   desc    : one-line description shown on mission card
   *   target  : numeric goal
   *   rewards : { shards, quantumFragments }
   *   type    : event type the mission listens to
   */
  static DAILY_POOL = [
    { id:'daily_shards_50',   label:'Shard Hunter',    desc:'Collect 50 shards in a single run',     target:50,   rewards:{ shards:100, qf:2 },  type:'run_shards'   },
    { id:'daily_shards_100',  label:'Data Hoarder',    desc:'Collect 100 shards in a single run',    target:100,  rewards:{ shards:200, qf:5 },  type:'run_shards'   },
    { id:'daily_dist_500',    label:'Sprint',          desc:'Travel 500m in a single run',            target:500,  rewards:{ shards:150, qf:3 },  type:'run_distance' },
    { id:'daily_dist_1000',   label:'Long Haul',       desc:'Travel 1000m in a single run',          target:1000, rewards:{ shards:300, qf:6 },  type:'run_distance' },
    { id:'daily_runs_3',      label:'Committed',       desc:'Complete 3 runs today',                  target:3,    rewards:{ shards:120, qf:2 },  type:'runs'         },
    { id:'daily_survive_30',  label:'Survivor',        desc:'Survive for 30 seconds in a run',        target:30,   rewards:{ shards:180, qf:4 },  type:'run_duration' },
    { id:'daily_survive_60',  label:'Iron Runner',     desc:'Survive for 60 seconds in a run',        target:60,   rewards:{ shards:350, qf:8 },  type:'run_duration' },
    { id:'daily_world2',      label:'Cyber Explorer',  desc:'Complete a run in Cyber District (W3)',   target:1,    rewards:{ shards:250, qf:5 },  type:'world_run',   worldIndex:2 },
    { id:'daily_total_shards',label:'Collector',       desc:'Collect 200 total shards in any runs',   target:200,  rewards:{ shards:400, qf:10 }, type:'total_shards' },
  ];

  /**
   * Permanent achievement missions. Completed once and never reset.
   * These represent long-term goals.
   */
  static ACHIEVEMENTS = [
    { id:'ach_first_run',     label:'First Step',      desc:'Complete your first run',                target:1,    rewards:{ shards:50,  qf:1  }, type:'runs'         },
    { id:'ach_runs_10',       label:'Regular',         desc:'Complete 10 runs',                        target:10,   rewards:{ shards:100, qf:2  }, type:'runs'         },
    { id:'ach_runs_50',       label:'Veteran',         desc:'Complete 50 runs',                        target:50,   rewards:{ shards:300, qf:10 }, type:'runs'         },
    { id:'ach_dist_5000',     label:'Marathon',        desc:'Run a total of 5,000m',                   target:5000, rewards:{ shards:250, qf:5  }, type:'total_dist'   },
    { id:'ach_dist_25000',    label:'Ultra Runner',    desc:'Run a total of 25,000m',                  target:25000,rewards:{ shards:750, qf:25 }, type:'total_dist'   },
    { id:'ach_shards_500',    label:'Shard Magnate',   desc:'Collect 500 total shards',                target:500,  rewards:{ shards:200, qf:5  }, type:'total_shards' },
    { id:'ach_shards_5000',   label:'Data Baron',      desc:'Collect 5,000 total shards',              target:5000, rewards:{ shards:1000,qf:30 }, type:'total_shards' },
    { id:'ach_survive_120',   label:'Ironclad',        desc:'Survive 120 seconds in one run',          target:120,  rewards:{ shards:500, qf:15 }, type:'run_duration' },
    { id:'ach_world5',        label:'Core Breach',     desc:'Complete a run in Core Matrix (W5)',       target:1,    rewards:{ shards:1000,qf:50 }, type:'world_run',   worldIndex:4 },
    { id:'ach_score_10000',   label:'Score God',       desc:'Reach a score of 10,000',                 target:10000,rewards:{ shards:500, qf:20 }, type:'run_score'    },
  ];

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * @param {SaveSystem} save
   */
  constructor(save) {
    this.save = save;

    /**
     * The 3 daily missions active today.
     * Populated by checkDailyReset() on construction and on each new day.
     * @type {Array}
     */
    this.activeDailies = [];

    this.checkDailyReset();
  }

  // ---------------------------------------------------------------------------
  // Daily Reset
  // ---------------------------------------------------------------------------

  /**
   * Selects today's 3 daily missions and resets progress if the date has
   * changed since last call. Safe to call on every game init.
   */
  checkDailyReset() {
    const today = this._todayStr();
    const dr    = this.save.dailyReward; // piggyback on dailyReward for date tracking

    // Use a separate key in missions storage for last-reset date
    const state = this.save.getMissionState('daily', '_meta');
    const lastReset = state.progress ? String(state.progress) : null;

    if (lastReset !== today) {
      this.save.resetDailyMissions();
      // Store today's date as progress on the _meta key (encoded as number won't work
      // for dates, so store in completed field as string via a workaround)
      const metaState = this.save.getMissionState('daily', '_meta');
      metaState.progress  = 0;
      metaState.completed = false;
      // We use a custom _lastReset field by directly accessing the bucket
      // (SaveSystem exposes this through getMissionState reference)
      metaState._lastReset = today;
    }

    this.activeDailies = this._selectDailies(today);
  }

  // ---------------------------------------------------------------------------
  // Notify Methods — called by GameManager during/after runs
  // ---------------------------------------------------------------------------

  /**
   * Called when a run ends (game over or abandoned).
   * @param {object} p
   * @param {number} p.distance   - meters traveled
   * @param {number} p.shards     - shards collected this run
   * @param {number} p.duration   - seconds survived
   * @param {number} p.score      - final score
   * @param {number} p.worldIndex - world that was played
   */
  notifyRunEnd({ distance, shards, duration, score, worldIndex }) {
    // Accumulate totals for achievement checks
    const totalDist   = this.save.stats.totalDistance;
    const totalShards = this.save.stats.totalShards;
    const totalRuns   = this.save.stats.totalRuns;

    this._progressAll('runs',        1,         totalRuns);
    this._progressAll('total_dist',  distance,  totalDist);
    this._progressAll('total_shards',shards,    totalShards);
    this._progressAll('run_distance',distance,  distance,   true);  // single-run
    this._progressAll('run_shards',  shards,    shards,     true);  // single-run
    this._progressAll('run_duration',duration,  duration,   true);  // single-run
    this._progressAll('run_score',   score,     score,      true);  // single-run

    if (worldIndex !== undefined) {
      this._progressAll('world_run', 1, 1, true, worldIndex);
    }
  }

  /**
   * Called immediately when shards are collected mid-run.
   * Useful for daily missions tracking cumulative shards across the day.
   * @param {number} count
   */
  notifyShardsCollected(count) {
    this._progressDailiesOfType('total_shards', count, 9999);
  }

  // ---------------------------------------------------------------------------
  // Claim
  // ---------------------------------------------------------------------------

  /**
   * Claims the reward for a completed mission.
   * @param {'daily'|'achievement'} category
   * @param {string} id
   * @returns {{ shards: number, qf: number }|null} Reward given, or null if failed
   */
  claim(category, id) {
    const success = this.save.claimMission(category, id);
    if (!success) return null;

    const def = category === 'daily'
      ? MissionSystem.DAILY_POOL.find(m => m.id === id)
      : MissionSystem.ACHIEVEMENTS.find(m => m.id === id);

    if (!def) return null;

    const { shards, qf } = def.rewards;
    if (shards > 0) this.save.addCurrency(shards);
    if (qf > 0)     this.save.addQuantumFragments(qf);

    return { shards, qf };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Returns display data for all active daily missions.
   * @returns {Array<{ def, state }>}
   */
  getDailyMissionData() {
    return this.activeDailies.map(def => ({
      def,
      state: this.save.getMissionState('daily', def.id),
    }));
  }

  /**
   * Returns display data for all achievement missions.
   * @returns {Array<{ def, state }>}
   */
  getAchievementData() {
    return MissionSystem.ACHIEVEMENTS.map(def => ({
      def,
      state: this.save.getMissionState('achievement', def.id),
    }));
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Selects 3 daily missions from the pool deterministically for a given date.
   * Same date → same 3 missions for every player.
   */
  _selectDailies(dateStr) {
    // Simple hash of the date string as a seed
    let seed = 0;
    for (let i = 0; i < dateStr.length; i++) {
      seed = (seed * 31 + dateStr.charCodeAt(i)) >>> 0;
    }

    const pool    = [...MissionSystem.DAILY_POOL];
    const chosen  = [];
    let   current = seed;

    while (chosen.length < 3 && pool.length > 0) {
      current  = (current * 1664525 + 1013904223) >>> 0;
      const idx = current % pool.length;
      chosen.push(pool.splice(idx, 1)[0]);
    }

    return chosen;
  }

  /**
   * Increments progress for all daily and achievement missions of a given type.
   * @param {string}  type
   * @param {number}  delta       - Amount to add this event
   * @param {number}  totalValue  - Absolute total (for total_* types)
   * @param {boolean} singleRun   - If true, use delta as the single-run max
   * @param {number}  [worldIndex]- For world_run type filtering
   */
  _progressAll(type, delta, totalValue, singleRun = false, worldIndex = undefined) {
    const allMissions = [
      ...this.activeDailies.map(d => ({ cat: 'daily', def: d })),
      ...MissionSystem.ACHIEVEMENTS.map(a => ({ cat: 'achievement', def: a })),
    ];

    for (const { cat, def } of allMissions) {
      if (def.type !== type) continue;
      if (worldIndex !== undefined && def.worldIndex !== worldIndex) continue;

      const state = this.save.getMissionState(cat, def.id);
      if (state.completed) continue;

      // Single-run missions use the per-run value directly (max of best run)
      const newProgress = singleRun
        ? Math.max(state.progress, delta)
        : totalValue;

      this.save.incrementMission(cat, def.id,
        newProgress - state.progress, def.target);
    }
  }

  /** Increments only daily missions of a given type (for mid-run updates). */
  _progressDailiesOfType(type, delta, target) {
    for (const def of this.activeDailies) {
      if (def.type !== type) continue;
      const state = this.save.getMissionState('daily', def.id);
      if (state.completed) continue;
      this.save.incrementMission('daily', def.id, delta, target);
    }
  }

  /** Returns today's ISO date string 'YYYY-MM-DD'. */
  _todayStr() {
    return new Date().toISOString().slice(0, 10);
  }
}
