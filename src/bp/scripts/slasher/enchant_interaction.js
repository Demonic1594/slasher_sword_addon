/**
 * ============================================================================
 * SLASHER SWORD — ENCHANTMENT INTERACTIONS
 * ============================================================================
 * These are bespoke behaviors layered on top of a handful of vanilla
 * enchantments when they're on "lc:slasher" (the sword). They're kept in
 * their own module (rather than scattered across slasher.js/beam.js) so all
 * enchant-driven behavior lives in one place.
 *
 * Interactions implemented here:
 *
 * 1. Resistance-piercing crit (Sharpness/Bane of Arthropods/Smite V):
 *    If the sword has Sharpness, Bane of Arthropods, or Smite at level 5 —
 *    any one of the three qualifies, they don't need to be the sword's only
 *    enchantment — every damage source the sword deals (fast-attack swing +
 *    beam, charged-attack swing + beam, lock-on chainsaw ticks, and
 *    plunge-impact ground pound) ignores the target's Resistance effect
 *    entirely, regardless of amplifier. Other enchantments present
 *    alongside it (Unbreaking, Mending, Fire Aspect, etc.) don't disqualify
 *    it. This is done by stripping the target's Resistance for the instant
 *    the damage is applied, then restoring it immediately after (same
 *    duration/amplifier), rather than trying to out-math Resistance's damage
 *    reduction.
 *
 * 2. Sharpness beam scaling (Sharpness ONLY, stacks with anything):
 *    Independent of interaction #1, plain Sharpness adds flat bonus damage
 *    to the Slasher's beams ONLY (the fast-attack beam and charged-attack
 *    beam) — never the melee swing itself, and never Bane/Smite:
 *      Sharpness I–II  -> +1
 *      Sharpness III–IV -> +2
 *      Sharpness V      -> +3
 *
 * 3. Fire Aspect debilitation (melee only, not beams):
 *    Fire Aspect I applies Slowness I (amplifier 0) to whatever the sword's
 *    melee hits (fast-attack swing, charged-attack swing, lock-on ticks,
 *    plunge impact). Fire Aspect II applies Slowness II (amplifier 1)
 *    instead. Thematically this is the nether star's "withering" power
 *    bleeding through — enough to debilitate, not enough to fully wither.
 *
 * 4. Mending overcharge:
 *    While the sword (with Mending) sits anywhere in a player's inventory —
 *    equipped or not — the player is kept topped up with Regeneration I.
 *
 * 5. Unbreaking (standard vanilla behavior, not a bespoke interaction):
 *    every point of scripted durability damage has a `1/(level+1)` chance to
 *    actually apply, matching vanilla's own Unbreaking odds — Unbreaking III
 *    means roughly a 1-in-4 chance any given hit costs durability at all.
 * ============================================================================
 */

import * as mc from "@minecraft/server";
import { CONFIG } from "../config.js";
import { safeInvoke } from "../utils/safe.js";

const SLASHER_TYPE_ID = "lc:slasher";

/**
 * @param {mc.ItemStack | undefined} itemStack
 * @returns {mc.ItemEnchantableComponent | undefined}
 */
function getEnchantable(itemStack) {
  if (!itemStack) return undefined;
  try {
    return itemStack.getComponent("enchantable");
  } catch {
    return undefined;
  }
}

/**
 * @param {mc.ItemStack | undefined} itemStack
 * @param {string} enchantId
 * @returns {number}
 */
function getEnchantLevel(itemStack, enchantId) {
  const enchantable = getEnchantable(itemStack);
  if (!enchantable) return 0;
  try {
    return enchantable.getEnchantment(enchantId)?.level ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Whether the sword qualifies for the resistance-piercing interaction: it
 * has Sharpness, Bane of Arthropods, or Smite at level 5 — any one of the
 * three is enough. Other enchantments present alongside it (Unbreaking,
 * Mending, Fire Aspect, etc.) don't disqualify it; there's no requirement
 * that the qualifying enchant be the sword's only enchantment.
 * @param {mc.ItemStack | undefined} itemStack
 * @returns {boolean}
 */
export function hasResistancePiercingEnchant(itemStack) {
  return (
    getEnchantLevel(itemStack, "sharpness") === 5 ||
    getEnchantLevel(itemStack, "bane_of_arthropods") === 5 ||
    getEnchantLevel(itemStack, "smite") === 5
  );
}

/**
 * Flat bonus damage Sharpness alone grants to the Slasher's beams. See module
 * docblock, interaction #2.
 * @param {mc.ItemStack | undefined} itemStack
 * @returns {number}
 */
export function getSharpnessBeamBonusDamage(itemStack) {
  const sharpness = getEnchantLevel(itemStack, "sharpness");
  if (sharpness >= 5) return 3;
  if (sharpness >= 3) return 2;
  if (sharpness >= 1) return 1;
  return 0;
}

/**
 * Slowness amplifier Fire Aspect grants on melee hits, or -1 if not eligible.
 * @param {mc.ItemStack | undefined} itemStack
 * @returns {number}
 */
function getFireAspectSlownessAmplifier(itemStack) {
  const fireAspect = getEnchantLevel(itemStack, "fire_aspect");
  if (fireAspect >= 2) return 1;
  if (fireAspect === 1) return 0;
  return -1;
}

/**
 * Applies damage to `hitEntity`, transparently stripping and restoring
 * Resistance around the hit if `piercesResistance` is true (see interaction
 * #1). Falls back to a plain `entity.applyDamage` call otherwise.
 *
 * This is the itemStack-agnostic core of the resistance-piercing
 * interaction: callers that already know whether the hit should pierce
 * Resistance (e.g. a beam that snapshotted it at shoot-time — see beam.js)
 * can call this directly instead of needing a live ItemStack on hand.
 * `applySlasherDamage` below is a thin wrapper for callers that still have
 * one (melee swings, which always read the currently-equipped item).
 * @param {mc.Entity} hitEntity
 * @param {number} damage
 * @param {mc.EntityApplyDamageByProjectileOptions | mc.EntityApplyDamageOptions} damageOptions
 * @param {boolean} piercesResistance
 * @returns {boolean} Whether the damage was actually applied.
 */
export function applyDamageWithResistancePiercing(hitEntity, damage, damageOptions, piercesResistance) {
  if (!piercesResistance) {
    return hitEntity.applyDamage(damage, damageOptions);
  }

  /** @type {mc.Effect | undefined} */
  let existingResistance;
  try {
    existingResistance = hitEntity.getEffect("resistance") ?? undefined;
  } catch {
    existingResistance = undefined;
  }

  if (existingResistance) {
    try {
      hitEntity.removeEffect("resistance");
    } catch {}
  }

  let damaged = false;
  try {
    damaged = hitEntity.applyDamage(damage, damageOptions);
  } finally {
    if (existingResistance) {
      try {
        hitEntity.addEffect("resistance", existingResistance.duration, {
          amplifier: existingResistance.amplifier,
        });
      } catch {}
    }
  }

  return damaged;
}

/**
 * Convenience wrapper around `applyDamageWithResistancePiercing` for callers
 * that still have a live Slasher ItemStack on hand (melee swings). Beams
 * should prefer `applyDamageWithResistancePiercing` directly with a
 * snapshotted boolean — see beam.js.
 * @param {mc.ItemStack | undefined} itemStack The Slasher item stack currently in the user's hand.
 * @param {mc.Entity} hitEntity
 * @param {number} damage
 * @param {mc.EntityApplyDamageByProjectileOptions | mc.EntityApplyDamageOptions} damageOptions
 * @returns {boolean} Whether the damage was actually applied.
 */
export function applySlasherDamage(itemStack, hitEntity, damage, damageOptions) {
  return applyDamageWithResistancePiercing(
    hitEntity,
    damage,
    damageOptions,
    hasResistancePiercingEnchant(itemStack),
  );
}

/**
 * Applies the Fire Aspect debilitation Slowness to a melee hit, if the
 * Slasher currently has Fire Aspect. No-op for beam hits (never call this
 * from beam.js — see interaction #3).
 * @param {mc.ItemStack | undefined} itemStack
 * @param {mc.Entity} hitEntity
 */
export function applyFireAspectDebilitation(itemStack, hitEntity) {
  const amplifier = getFireAspectSlownessAmplifier(itemStack);
  if (amplifier < 0) return;

  try {
    hitEntity.addEffect("slowness", CONFIG.fireAspectDebilitation.durationTicks, {
      amplifier,
    });
  } catch {}
}

/**
 * Standard vanilla Unbreaking odds: with no Unbreaking, durability damage
 * always applies (100%). Each level beyond that divides the odds down —
 * Unbreaking I: 1/2, II: 1/3, III: 1/4 — matching how vanilla tools/armor
 * behave. Meant to be checked once per "durability-loss event" (i.e. once
 * per call to Slasher.addNextDurabilityDamage, not once per point of
 * damage in that call) since the Slasher already only calls that once per
 * qualifying hit.
 * @param {mc.ItemStack | undefined} itemStack
 * @returns {boolean} Whether durability damage should be applied this time.
 */
export function shouldApplyDurabilityDamage(itemStack) {
  const level = getEnchantLevel(itemStack, "unbreaking");
  if (level <= 0) return true;
  return Math.random() < 1 / (level + 1);
}

// ----------------------------------------------------------------------------
// Interaction #4: Mending overcharge — Regeneration I as long as a Mending
// Slasher is anywhere in the player's inventory (equipped or not).
// ----------------------------------------------------------------------------

/**
 * @param {mc.ItemStack | undefined} itemStack
 * @returns {boolean}
 */
function isMendingSlasher(itemStack) {
  if (!itemStack) return false;
  if (itemStack.typeId !== SLASHER_TYPE_ID) return false;
  return getEnchantLevel(itemStack, "mending") > 0;
}

/**
 * @param {mc.Player} player
 * @returns {boolean}
 */
function playerHasMendingSlasherInInventory(player) {
  try {
    const equippable = player.getComponent("equippable");
    if (equippable) {
      const equipmentSlots = [
        mc.EquipmentSlot.Mainhand,
        mc.EquipmentSlot.Offhand,
        mc.EquipmentSlot.Head,
        mc.EquipmentSlot.Chest,
        mc.EquipmentSlot.Legs,
        mc.EquipmentSlot.Feet,
      ];

      for (const slot of equipmentSlots) {
        // Per-slot, not around the whole loop: one bad slot read (a
        // transient engine hiccup, an item mid-swap, etc.) shouldn't abort
        // checking the rest of the slots for the same tick.
        let equipment;
        try {
          equipment = equippable.getEquipment(slot);
        } catch {
          continue;
        }

        if (isMendingSlasher(equipment)) return true;
      }
    }
  } catch {}

  try {
    const inventory = player.getComponent("inventory");
    const container = inventory?.container;
    if (container) {
      for (let i = 0; i < container.size; i++) {
        // Same reasoning as above: one bad slot shouldn't abort the scan.
        let item;
        try {
          item = container.getItem(i);
        } catch {
          continue;
        }

        if (isMendingSlasher(item)) return true;
      }
    }
  } catch {}

  return false;
}

/**
 * Per-player cache backing the two-tier mending overcharge system: the
 * (comparatively expensive) full-inventory scan only actually runs once per
 * CONFIG.mendingOvercharge.scanIntervalTicks; every apply tick in between
 * just reuses whatever the last scan found. Cleared on player leave.
 * @type {Map<mc.Player, { hasMendingSlasher: boolean, ticksSinceScan: number }>}
 */
const mendingCache = new Map();

/**
 * Forces the next apply tick for `player` to run a fresh full-inventory
 * scan instead of reusing the cache, so picking up (or switching to) a
 * Mending Slasher takes effect on the next tick rather than waiting up to
 * scanIntervalTicks. Called from Slasher.onCreate (see slasher.js) — i.e.
 * whenever the item extender (re)attaches to a Slasher in the player's
 * mainhand, which covers both "picked one up for the first time" and
 * "switched hotbar slots to one already in the inventory."
 *
 * Deliberately NOT hooked up to every possible way a Mending Slasher could
 * enter a player's inventory (e.g. being placed directly into a backpack
 * slot via another mod/plugin) — those still get picked up within
 * scanIntervalTicks by the regular periodic scan, same as before this
 * optimization existed. This just shaves the latency down for the common
 * case of actually wielding the sword.
 * @param {mc.Player} player
 */
export function invalidateMendingCacheFor(player) {
  const cached = mendingCache.get(player);
  if (cached) cached.ticksSinceScan = Infinity;
}

mc.world.beforeEvents.playerLeave.subscribe(({ player }) => {
  mendingCache.delete(player);
});

mc.world.afterEvents.worldLoad.subscribe(() => {
  mc.system.runInterval(() => {
    const players = mc.world.getPlayers();

    for (let i = 0; i < players.length; i++) {
      const player = players[i];

      safeInvoke(`mending overcharge check for player "${player?.name}"`, () =>
        tickMendingOverchargeForPlayer(player),
      );
    }
  }, CONFIG.mendingOvercharge.applyIntervalTicks);
});

/**
 * @param {mc.Player} player
 */
function tickMendingOverchargeForPlayer(player) {
  let cached = mendingCache.get(player);
  if (!cached) {
    // Infinity forces an immediate scan below the first time a player is
    // ever seen, rather than waiting a full scanIntervalTicks after joining.
    cached = { hasMendingSlasher: false, ticksSinceScan: Infinity };
    mendingCache.set(player, cached);
  }

  cached.ticksSinceScan += CONFIG.mendingOvercharge.applyIntervalTicks;

  if (cached.ticksSinceScan >= CONFIG.mendingOvercharge.scanIntervalTicks) {
    cached.hasMendingSlasher = playerHasMendingSlasherInInventory(player);
    cached.ticksSinceScan = 0;
  }

  if (!cached.hasMendingSlasher) return;

  player.addEffect("regeneration", CONFIG.mendingOvercharge.durationTicks, {
    amplifier: 0,
    showParticles: false,
  });
}
