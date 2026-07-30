/**
 * ============================================================================
 * SLASHER — KILL LEADERBOARD
 * ============================================================================
 * Tracks kills credited to the Slasher on a scoreboard objective
 * (CONFIG.leaderboard.objectiveId), so a server owner can display or query it
 * with normal vanilla commands — e.g.:
 *
 *   /scoreboard objectives setdisplay sidebar lc_slasher_kills
 *   /scoreboard players list @a
 *
 * — without needing any addon-specific UI. This module doesn't force any
 * display slot itself: forcing the sidebar would fight with whatever else a
 * server might already be showing there, so displaying it is left as an
 * opt-in for whoever installs the pack.
 *
 * Kill detection piggybacks entirely on the "who last hit this, and when"
 * stamp every Slasher damage path already leaves via
 * utils/entity.js#stampLastHitByPlayer (melee swings, chainsaw ticks, plunge
 * impact, and both beam types all call this on a successful hit). On
 * entityDie, if the dead entity's stamp names a player and the stamp is
 * recent enough (CONFIG.leaderboard.killCreditWindowTicks), that player's
 * score goes up by one — scored by username, so the killer doesn't need to
 * still be online at the moment of death for the kill to count.
 * ============================================================================
 */

import * as mc from "@minecraft/server";
import { CONFIG } from "../config.js";
import { getLastHitByPlayer } from "../utils/entity.js";
import { safeInvoke } from "../utils/safe.js";

/**
 * @returns {mc.ScoreboardObjective}
 */
function getOrCreateObjective() {
  const existing = mc.world.scoreboard.getObjective(CONFIG.leaderboard.objectiveId);
  if (existing) return existing;

  return mc.world.scoreboard.addObjective(
    CONFIG.leaderboard.objectiveId,
    CONFIG.leaderboard.objectiveDisplayName,
  );
}

mc.world.afterEvents.worldLoad.subscribe(() => {
  safeInvoke("slasher leaderboard objective setup", getOrCreateObjective);
});

mc.world.afterEvents.entityDie.subscribe(({ deadEntity }) => {
  safeInvoke("slasher leaderboard kill credit", () => {
    const lastHit = getLastHitByPlayer(deadEntity);
    if (!lastHit) return;

    const ticksSinceHit = mc.system.currentTick - lastHit.tick;
    if (ticksSinceHit < 0 || ticksSinceHit > CONFIG.leaderboard.killCreditWindowTicks) {
      // Either stale (the entity died long after its last Slasher hit, to
      // something unrelated) or a clock oddity — don't credit either way.
      return;
    }

    // A killer crediting themselves for their own death (e.g. self-inflicted
    // plunge-impact splash) is already excluded upstream by canBeAttacked()
    // never letting the Slasher damage its own wielder, so no extra check
    // is needed here.

    // addScore accepts a plain string participant (not just a live
    // Entity/Player), so the killer doesn't need to still be online for
    // this to work — previously, disconnecting between your last hit and
    // the target's death (e.g. a delayed plunge-impact death, or lag)
    // silently dropped the kill because no matching online Player existed
    // to score against. Scoring by name also means the objective keeps
    // accumulating correctly across sessions for the same account.
    const objective = getOrCreateObjective();
    objective.addScore(lastHit.name, 1);
  });
});
