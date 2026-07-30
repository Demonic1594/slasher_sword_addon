/**
 * ============================================================================
 * SLASHER CONFIG
 * ============================================================================
 * Every gameplay-tunable number for the Slasher lives here: damage values,
 * dash/impulse strength, state timings, and status-effect amplifiers/durations.
 * Nothing in this file contains game logic — it's pure data — so you can
 * change balance without touching slasher.js or beam.js at all.
 *
 * Units: damage is in half-hearts (vanilla convention, e.g. 2 = 1 heart),
 * durations are in ticks (20 ticks = 1 second) unless stated otherwise.
 * ============================================================================
 */

// The Slasher's own displayed weapon-damage stat (items/slasher.item.json ->
// minecraft:damage.value). Every hand-dealt damage number below is defined
// as a multiple of this single source of truth instead of an unrelated
// magic number, so the tooltip stat and the actual damage dealt stay in the
// same ballpark and both move together if this is ever rebalanced.
const BASE_DAMAGE = 12;

export const CONFIG = {
  // See comment above — kept on CONFIG too so other modules can reference it
  // (e.g. anything that wants to scale off "the sword's damage") without a
  // second copy of the number.
  baseDamage: BASE_DAMAGE,

  // 1 heart = 2 HP (half-hearts), vanilla convention. Used anywhere a
  // gameplay number is more naturally stated "in hearts" (like the lock-on
  // escalation thresholds below) but the actual API calls need HP.
  hpPerHeart: 2,

  /**
   * Mace-style enchant scaling, inherent to the Slasher (not real enchantments
   * — these are baked-in multipliers that behave like the vanilla Mace's
   * Density and Breach enchantments).
   */
  enchantScaling: {
    // --- Density (ground pound / plunge-impact damage only) ---
    // Vanilla formula: +0.5 damage per block fallen, per level.
    densityLevel: 6, // "Density VI"
    densityDamagePerBlockPerLevel: 0.5,

    // --- Breach (applies to every damage type the Slasher deals) ---
    // Vanilla formula: reduces the target's effective armor points by 15%
    // per level, applied BEFORE the normal armor/toughness damage formula so
    // the final damage scales relative to the (now-weaker) armor.
    // Vanilla caps at level IV (60%); we go to "Breach VI" (90%, clamped at
    // 100% in calculateFinalDamage so this can never go negative).
    breachLevel: 6,
    breachArmorReductionPerLevel: 0.15,
  },

  /**
   * Item-cooldown durations (ticks) for every named cooldown id the Slasher
   * sets via `slasher.setCooldown(id, duration)`. These mostly gate animation
   * transitions/spam-prevention rather than being player-facing "ability on
   * cooldown" timers, but they're pulled out here so every tunable duration
   * in the addon lives in one place instead of being hardcoded at call sites.
   */
  cooldowns: {
    pick: 2, // slasher_pick — picking the item back up after charged/plunge attacks
    dash: 2, // slasher_dash
    chargingStart: 2, // slasher_charging_start
    chargedAtkStart: 2, // slasher_charged_atk_start
    chargedAtkContinue: 4, // slasher_charged_atk_continue
    chargedAtkHold: 2, // slasher_charged_atk_hold
    chargedAtkEnd: 2, // slasher_charged_atk_end
    plungeWindup: 2, // slasher_plunge_windup
    plungeFall: 2, // slasher_plunge_fall
    plungeImpact: 2, // slasher_plunge_impact
  },

  fastAtk: {
    // Half the sword's stated damage per swing, so a 2-hit fast-attack combo
    // lands roughly the sword's full BASE_DAMAGE across both hits.
    swingDamage: BASE_DAMAGE * 0.5, // 6
    swingHitboxMaxDistance: 2.2,
    stateLifespanMaxTicks: 15,
    preventChargeTick: 9,
    cooldownMaxTicks: 2,
    durabilityDamagePerHit: 1,
  },

  charging: {
    // Number of UI frames also defines how many ticks a full charge takes.
    chargeUiFrames: [">    X    <", ">   X   <", ">  X  <", "> X <", ">X<"],
  },

  dash: {
    // Impulse strength (blocks/tick of velocity change).
    airImpulseMagnitude: 2.2,
    groundImpulseMagnitude: 3.9,
    groundDashDurationTicks: 2,
    airDashDurationTicks: 4,

    // Resistance granted while airborne from a charged-attack dash, so
    // landing afterwards doesn't deal fall damage. Deliberately NOT a single
    // fixed duration calculated once at dash-time: the dash's own impulse
    // isn't a reliable predictor of total airtime, since the player can
    // already be falling before the dash (e.g. off a cliff edge, for however
    // many blocks that fall already covers) or carrying velocity forward
    // from an earlier dash in the same chain (each dash's impulse stacks
    // with whatever velocity the player already had). Either case can leave
    // the player airborne far longer than the dash impulse alone implies.
    //
    // Instead, the effect is refreshed every tick for as long as the player
    // hasn't landed (see Slasher.tickDashResistanceTracking in slasher.js),
    // with one final pulse the instant landing is detected. That makes it
    // self-correcting for any airtime, however it was gained, with no
    // up-front math required.
    resistanceAmplifier: 5,
    // Duration (ticks) granted on every refresh while still airborne. Only
    // needs to outlast one tick's worth of latency with a little headroom.
    resistanceRefreshTicks: 6,
    // Extra ticks added on top of resistanceRefreshTicks for the final pulse
    // applied the instant the player is detected on the ground, so the
    // landing tick itself (where fall damage is actually calculated) stays
    // safely covered.
    resistanceLandingBufferTicks: 5,
    // Hard safety cap: stop refreshing after this many ticks post-dash even
    // if the player never touches the ground (e.g. flies off into the
    // void), so this can never grant indefinite fall-damage immunity.
    resistanceMaxTrackedTicks: 200,
  },

  chargedAtk: {
    // A charged, wound-up hit should clearly outclass the sword's base
    // stat as a reward for the wind-up/commitment.
    damage: BASE_DAMAGE * 1.5, // 18
    damagingDurationTicks: 5,
    weaknessEffect: {
      everyNTicks: 2,
      durationTicks: 3,
      amplifier: 255,
    },
    durabilityDamagePerHit: 2,
  },

  lockonAtk: {
    // 10 (middle of the requested 8-14 range). At the starting interval
    // (4 ticks = 5 hits/sec) that's 50 HP/sec before any escalation bonus —
    // deliberately brutal, since the grab already costs full commitment
    // (target + user both frozen in place). Climbs further from there via
    // escalation.damageBonusPerThreshold the longer a single grab lasts.
    damagePerTick: 10,
    targetSlownessDurationTicks: 40,
    targetSlownessAmplifier: 0,

    // Resistance IV (amplifier is 0-indexed, so level IV = amplifier 3) applied
    // to the user for as long as they're actively chainsawing a target.
    // Reapplied every tick with a short duration so it decays on its own within
    // a few ticks if onTickChainsawing ever stops running for any reason (e.g.
    // an unexpected error), rather than sticking around indefinitely; also
    // explicitly removed the instant the target dies or the user lets go.
    userResistanceAmplifier: 3,
    userResistanceDurationTicks: 6,

    userWeaknessEveryNTicks: 2,
    userWeaknessDurationTicks: 3,
    userWeaknessAmplifier: 255,
    durabilityDamagePerTick: 1,

    /**
     * Escalation over the course of a single chainsaw grab, tracked as
     * cumulative HP dealt to that specific target since the grab started
     * (resets whenever a new lock-on begins). Thresholds are stated in
     * hearts and converted with CONFIG.hpPerHeart.
     *
     * Damage scaling is uncapped (same "keeps climbing" spirit as the
     * ground-pound/Density scaling elsewhere in this file): every
     * `thresholdHearts` worth of cumulative damage adds another
     * `damageBonusPerThreshold`.
     *
     * Speed scaling is capped, since a Minecraft tick (1/20s) is the fastest
     * anything can actually happen: it starts at `baseIntervalTicks` (one
     * hit every N ticks) and drops by 1 tick per threshold crossed, down to
     * `minIntervalTicks`.
     */
    escalation: {
      // Thresholds lowered by one 25-heart tier across the board (were
      // 50/75/100) — the original pacing felt too slow to actually reach
      // during a real grab.
      thresholdHearts: 25,
      damageBonusPerThreshold: 3,
      baseIntervalTicks: 4,
      minIntervalTicks: 1,

      // At 50 hearts cumulative: target gets Wither, user gets Regeneration.
      // Wither is reapplied every tick (see onTickChainsawing in slasher.js),
      // so witherDurationTicks only needs to outlast one tick with a little
      // headroom — it's not meant to persist on its own past the grab ending.
      witherThresholdHearts: 50,
      witherAmplifier: 1,
      witherDurationTicks: 4,
      userRegenAmplifier: 2,
      userRegenDurationTicks: 10,

      // At 75 hearts cumulative: Wither escalates, and the target's
      // healing (natural regen, the Regeneration effect, and Instant
      // Health) is suppressed for the rest of the grab.
      noHealThresholdHearts: 75,
      noHealWitherAmplifier: 2,
    },
  },

  plungeWindup: {
    durationTicks: 7,
    riseForce: { x: 0, y: 1.2, z: 0 },
    weaknessAmplifier: 255,
    weaknessExtraDurationTicks: 2, // added on top of durationTicks
    resistanceAmplifier: 255,
    resistanceExtraDurationTicks: 5, // added on top of durationTicks
  },

  plungeFall: {
    fallForce: { x: 0, y: -4.4, z: 0 },
    resistanceAmplifier: 255,
    resistanceDurationTicks: 6,
    weaknessAmplifier: 255,
    weaknessDurationTicks: 10,
    refreshEveryNTicks: 3,

    // Every `intervalBlocks` fallen during the plunge, an extra downward
    // impulse of `force` is applied on top of the initial fallForce, so the
    // plunge keeps noticeably accelerating the longer it falls instead of
    // settling at a single terminal-feeling speed. Uncapped — same
    // "nearly infinite height, nearly infinite scaling" spirit as the
    // ground-pound damage below, so a long enough drop keeps getting faster
    // the whole way down.
    speedBoost: {
      intervalBlocks: 75,
      force: { x: 0, y: -2.2, z: 0 },
    },
  },

  beam: {
    fastAtk: {
      entityTypeId: "lc:slasher_beam_fast_atk",
      shootForceMultiplier: 5.1, // was 4.62 — minor speed boost
      // Ranged/secondary component of the fast attack — deliberately weak
      // relative to the melee swing itself.
      directHitDamage: Math.round(BASE_DAMAGE * 0.25), // 3 (was 2)
    },
    chargedAtk: {
      entityTypeId: "lc:slasher_beam_charged_atk",
      shootForceMultiplier: 2.45, // was 2.23 — minor speed boost
      directHitDamage: Math.round(BASE_DAMAGE * 0.75), // 9 (was 8)
      targetSlownessDurationTicks: 50,
      targetSlownessAmplifier: 0,
    },
  },

  /**
   * Slasher kill-leaderboard (see slasher/leaderboard.js): tracks kills
   * credited to the Slasher on a scoreboard objective so server owners can
   * display/query it (e.g. `/scoreboard objectives setdisplay sidebar
   * lc_slasher_kills`) without building their own tracking.
   */
  leaderboard: {
    objectiveId: "lc_slasher_kills",
    objectiveDisplayName: "Slasher Kills",

    // A kill is only credited to the Slasher if the entity's last Slasher
    // hit (melee or beam) happened within this many ticks of it dying —
    // otherwise a target that gets grazed by a beam, wanders off, and dies
    // to lava five minutes later would incorrectly count as a Slasher kill.
    // 100 ticks (5s) mirrors vanilla's own "recently hit" windows (e.g. item
    // drop/XP credit).
    killCreditWindowTicks: 100,
  },

  /**
   * Fire Aspect debilitation interaction (see enchant_interactions.js):
   * duration of the Slowness applied to melee hits when the Slasher has
   * Fire Aspect I or II. Amplifier is derived from the enchant level, not
   * configured here.
   */
  fireAspectDebilitation: {
    durationTicks: 60, // 3 seconds
  },

  /**
   * Mending overcharge interaction (see enchant_interactions.js). Split into
   * two independent cadences so the (comparatively expensive) full-inventory
   * scan doesn't need to run as often as the (cheap) effect refresh:
   *   - applyIntervalTicks: how often eligible players get their
   *     Regeneration I pulse refreshed. Needs to be frequent relative to
   *     durationTicks so the effect never visibly flickers.
   *   - scanIntervalTicks: how often each player's *entire* inventory is
   *     actually re-scanned for a Mending Slasher. Whatever was found on the
   *     last scan is cached and reused for every apply tick in between —
   *     picking up or losing a qualifying sword only takes effect on the
   *     next scan, not the next apply tick (see the cache-invalidation hook
   *     in enchant_interactions.js for how pickup latency is minimized).
   */
  mendingOvercharge: {
    applyIntervalTicks: 20, // refresh the effect once per second
    scanIntervalTicks: 100, // re-scan the whole inventory once per 5 seconds
    durationTicks: 30,
  },

  plungeImpact: {
    minDepthConsideredHigh: 10,
    changeStateAllowedTick: 4,
    weaknessAmplifier: 255,
    weaknessDurationTicks: 8,

    // A short, high-amplifier resistance tick applied at the exact
    // moment of landing so the impact itself (which can otherwise register
    // as fall damage in the same tick) never kills or maims the user — it's
    // as if the sword absorbed the force instead. Short on purpose: it
    // expires on its own almost immediately, it isn't manually removed.
    landingResistanceAmplifier: 255,
    landingResistanceDurationTicks: 3,

    // Base ground-pound damage formula: round(baseDamageMultiplier * (fallenDepth / fallenDepthDivisor))
    // (plus the Density-style bonus from enchantScaling), floored at
    // minDamage before armor/Breach/Protection are applied. There is
    // intentionally no upper cap — like the vanilla Mace, damage keeps
    // scaling with fall distance with no ceiling, so a "nearly infinite"
    // fall deals a "nearly infinite" hit.
    baseDamageMultiplier: 5,
    fallenDepthDivisor: 4.4,
    minDamage: 3,

    targetSlownessDurationTicks: 70,
    targetSlownessAmplifier: 1,

    /**
     * How far the ground-pound's AoE reaches. Unlike the damage formula
     * above, this IS capped — an unbounded blast radius would eventually
     * mean "hits literally everything loaded," which isn't fun or
     * performant, no matter how thematically consistent it'd be with the
     * uncapped damage. Formula: clamp(base + floor(fallenDepth /
     * perTierBlocksFallen) * perTierBonus, min, max).
     */
    hitRadius: {
      base: 12, // was a hardcoded 11
      min: 4,
      perTierBlocksFallen: 25,
      perTierBonus: 1.5,
      max: 40,
    },
  },
};
