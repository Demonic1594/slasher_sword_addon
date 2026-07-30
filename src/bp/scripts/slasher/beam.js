/**
 * ============================================================================
 * SLASHER — BEAMS
 * ============================================================================
 * The fast-attack and charged-attack swings both fire a projectile-like beam
 * entity alongside the melee hit (shootFastAtkBeam / shootChargedAtkBeam).
 * These beams are spawned once and then live independently in the world —
 * see the comment on getSourceMainhandItemStack() below for why their damage
 * numbers are snapshotted at shoot-time instead of read at hit-time.
 * ============================================================================
 */

import * as mc from "@minecraft/server";
import * as vec3 from "../utils/vec3.js";
import { CONFIG } from "../config.js";
import { calculateFinalDamage, canBeAttacked, stampLastHitByPlayer } from "../utils/entity.js";
import { randf } from "../utils/math.js";
import * as physics from "../utils/physics.js";
import { safeInvoke } from "../utils/safe.js";
import {
  applyDamageWithResistancePiercing,
  getSharpnessBeamBonusDamage,
  hasResistancePiercingEnchant,
} from "./enchant_interactions.js";

/**
 * Beams are their own entities that can outlive the swing that spawned them,
 * so instead of reading the source player's currently-equipped item at
 * hit-time (which silently loses the original enchant bonuses if the player
 * switched items, died, or logged off before the beam landed), every
 * enchant-driven stat the beam needs is snapshotted ONCE at shoot-time and
 * stored directly on the beam entity itself via dynamic properties:
 *   - lc:ownerName        the shooter's player name, so the beam can still
 *                          be attributed back to them even if the `source`
 *                          entity is no longer resolvable by id.
 *   - lc:sharpnessBonus    flat beam damage bonus from Sharpness (see
 *                          enchant_interactions.js interaction #2).
 *   - lc:resistPierce      whether this beam pierces target Resistance (see
 *                          enchant_interactions.js interaction #1).
 * The beam's hit handlers below read these directly off the beam entity —
 * `source` is only still consulted for things that inherently need a live
 * player reference (self-hit checks, hitmarker sound, kill attribution),
 * never for the damage numbers themselves.
 * @param {mc.Entity | undefined} source
 * @returns {mc.ItemStack | undefined}
 */
function getSourceMainhandItemStack(source) {
  if (!source) return undefined;
  try {
    const equippable = source.getComponent("equippable");
    return equippable?.getEquipment(mc.EquipmentSlot.Mainhand);
  } catch {
    return undefined;
  }
}

/**
 * Snapshots the enchant-driven stats a beam needs from the shooter's
 * mainhand item and writes them onto the beam entity as dynamic properties,
 * along with the shooter's name. Call this once, right after spawning the
 * beam and before it can possibly land.
 * @param {mc.Entity} beamEntity
 * @param {mc.Player} source
 * @returns {void}
 */
function snapshotEnchantsOntoBeam(beamEntity, source) {
  const itemStack = getSourceMainhandItemStack(source);

  beamEntity.setDynamicProperty("lc:ownerName", source.name);
  beamEntity.setDynamicProperty(
    "lc:sharpnessBonus",
    getSharpnessBeamBonusDamage(itemStack),
  );
  beamEntity.setDynamicProperty(
    "lc:resistPierce",
    hasResistancePiercingEnchant(itemStack),
  );
}

/**
 * @param {mc.Entity} beamEntity
 * @returns {string | undefined}
 */
function getOwnerName(beamEntity) {
  const value = beamEntity.getDynamicProperty("lc:ownerName");
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {mc.Entity} beamEntity
 * @returns {number}
 */
function getBeamSharpnessBonus(beamEntity) {
  const value = beamEntity.getDynamicProperty("lc:sharpnessBonus");
  return typeof value === "number" ? value : 0;
}

/**
 * @param {mc.Entity} beamEntity
 * @returns {boolean}
 */
function getBeamResistPierce(beamEntity) {
  return beamEntity.getDynamicProperty("lc:resistPierce") === true;
}

const BEAM_INFO = CONFIG.beam;

/**
 * @param {mc.Player} source
 * @returns {void}
 */
export function shootFastAtkBeam(source) {
  const rot = source.getRotation();
  const dir = source.getViewDirection();

  for (let i = 0; i < 3; i++) {
    const origin = vec3.add(
      vec3.getRelativeToHead(source.getHeadLocation(), dir, {
        x: (i - 1) / 1.6,
        y: -0.3,
        z: 0.9,
      }),
      source.getVelocity(),
    );

    const force = vec3.changeDir(
      vec3.scale(vec3.FORWARD, BEAM_INFO.fastAtk.shootForceMultiplier),
      dir,
    );

    const beamEntity = source.dimension.spawnEntity(
      BEAM_INFO.fastAtk.entityTypeId,
      origin,
    );

    setSourceId(beamEntity, source.id);
    snapshotEnchantsOntoBeam(beamEntity, source);

    setRotation(beamEntity, {
      x: rot.x,
      y: rot.y,
      z: 0,
    });

    beamEntity.setProperty("lc:bit", i);

    beamEntity.applyImpulse(force);

    mc.system.runTimeout(() => {
      safeInvoke("fast-atk beam visibility timeout", () => {
        if (!beamEntity.isValid) return;

        if (vec3.length(beamEntity.getVelocity()) <= 0.1) {
          vanish(beamEntity);
          return;
        }

        makeVisible(beamEntity);
      });
    }, 2);
  }
}

/**
 * @param {mc.Player} source
 * @returns {void}
 */
export function shootChargedAtkBeam(source) {
  const rot = source.getRotation();
  const dir = source.getViewDirection();
  const origin = vec3.add(
    vec3.getRelativeToHead(source.getHeadLocation(), dir, {
      x: -0.11,
      y: 0.03,
      z: 0.9,
    }),
    source.getVelocity(),
  );

  const force = vec3.changeDir(
    vec3.scale(vec3.FORWARD, BEAM_INFO.chargedAtk.shootForceMultiplier),
    dir,
  );

  const beamEntity = source.dimension.spawnEntity(
    BEAM_INFO.chargedAtk.entityTypeId,
    origin,
  );

  setSourceId(beamEntity, source.id);
  snapshotEnchantsOntoBeam(beamEntity, source);

  setRotation(beamEntity, {
    x: rot.x,
    y: rot.y,
    z: -85,
  });

  beamEntity.applyImpulse(force);

  mc.system.runTimeout(() => {
    safeInvoke("charged-atk beam visibility timeout", () => {
      if (!beamEntity.isValid) return;

      if (vec3.length(beamEntity.getVelocity()) <= 0.1) {
        vanish(beamEntity);
        return;
      }

      makeVisible(beamEntity);
    });
  }, 2);
}

mc.world.afterEvents.dataDrivenEntityTrigger.subscribe(
  ({ entity: beamEntity }) => {
    safeInvoke("beam timeout trigger", () => vanish(beamEntity, true));
  },
  {
    entityTypes: [
      BEAM_INFO.fastAtk.entityTypeId,
      BEAM_INFO.chargedAtk.entityTypeId,
    ],
    eventTypes: ["timeout"],
  },
);

mc.world.afterEvents.projectileHitEntity.subscribe((event) => {
  safeInvoke("projectileHitEntity", () => {
    if (event.projectile.typeId === BEAM_INFO.fastAtk.entityTypeId) {
      onFastAtkBeamHitEntity(event);
    } else if (
      event.projectile.typeId === BEAM_INFO.chargedAtk.entityTypeId
    ) {
      onChargedAtkBeamHitEntity(event);
    }
  });
});

mc.world.afterEvents.projectileHitBlock.subscribe((event) => {
  safeInvoke("projectileHitBlock", () => {
    if (event.projectile.typeId === BEAM_INFO.fastAtk.entityTypeId) {
      onFastAtkBeamHitBlock(event);
    } else if (
      event.projectile.typeId === BEAM_INFO.chargedAtk.entityTypeId
    ) {
      onChargedAtkBeamHitBlock(event);
    }
  });
});

/** @param {mc.ProjectileHitEntityAfterEvent} event */
function onFastAtkBeamHitEntity(event) {
  if (!event.projectile.isValid) return;

  const hitEntity = event.getEntityHit().entity;
  if (!hitEntity) return;

  const source = mc.world.getEntity(getSourceId(event.projectile) ?? "");
  if (source === hitEntity) return;
  if (!canBeAttacked(hitEntity)) return;

  let damaged = false;
  try {
    // Damage-relevant enchant data comes from the beam's own snapshot taken
    // at shoot-time (see snapshotEnchantsOntoBeam), not a live item lookup —
    // this still lands correctly even if `source` switched items, died, or
    // logged off while the beam was in flight. `source` itself is only used
    // below for the self-hit check, damagingEntity attribution, and sound.
    const rawDamage =
      BEAM_INFO.fastAtk.directHitDamage +
      getBeamSharpnessBonus(event.projectile);

    const damage = Math.max(
      1,
      calculateFinalDamage(
        rawDamage,
        hitEntity,
        CONFIG.enchantScaling.breachLevel,
      ),
    );

    damaged = applyDamageWithResistancePiercing(
      hitEntity,
      damage,
      {
        // projectile, not override — override bypasses the target's
        // Resistance at the engine level unconditionally, regardless of
        // the snapshotted resistPierce flag below. getBeamResistPierce()
        // (the sword's enchants at shoot-time) is meant to be the only
        // thing that can bypass Resistance, not the damage cause itself.
        cause: mc.EntityDamageCause.projectile,
        damagingEntity: source,
      },
      getBeamResistPierce(event.projectile),
    );
  } catch {}

  if (!damaged) return;

  // Tag the target with who last hit it, read straight off the beam's own
  // snapshot rather than the (possibly gone by now) source entity. This is
  // what backs the kill leaderboard in slasher/leaderboard.js — see
  // stampLastHitByPlayer's doc comment in utils/entity.js.
  stampLastHitByPlayer(hitEntity, getOwnerName(event.projectile));

  physics.clearVelocity(hitEntity);

  if (source instanceof mc.Player) {
    const soundLoc = vec3.add(
      vec3.normalize(
        vec3.subtract(
          vec3.add(hitEntity.location, vec3.UP),
          source.getHeadLocation(),
        ),
      ),
      source.getHeadLocation(),
    );

    source.playSound("slasher.beam.hitmarker", {
      location: soundLoc,
      volume: 0.4,
      pitch: randf(0.95, 1.05),
    });
  }

  vanish(event.projectile);
}

/** @param {mc.ProjectileHitBlockAfterEvent} event */
function onFastAtkBeamHitBlock(event) {
  if (!event.projectile.isValid) return;

  vanish(event.projectile);
}

/** @param {mc.ProjectileHitEntityAfterEvent} event */
function onChargedAtkBeamHitEntity(event) {
  if (!event.projectile.isValid) return;

  const hitEntity = event.getEntityHit().entity;
  if (!hitEntity) return;

  const source = mc.world.getEntity(getSourceId(event.projectile) ?? "");
  if (source === hitEntity) return;
  if (!canBeAttacked(hitEntity)) return;

  // See onFastAtkBeamHitEntity above — same snapshot-based approach.
  const rawDamage =
    BEAM_INFO.chargedAtk.directHitDamage +
    getBeamSharpnessBonus(event.projectile);

  // Floored at 1, matching every other Slasher damage path (melee swings,
  // the fast-atk beam, lock-on ticks, plunge impact) — without this, a
  // heavily-armored/Protection-stacked target could take 0 damage from a
  // direct charged-beam hit while still eating the knockback/slowness.
  const damage = Math.max(
    1,
    calculateFinalDamage(
      rawDamage,
      hitEntity,
      CONFIG.enchantScaling.breachLevel,
    ),
  );

  let damaged = false;
  try {
    damaged = applyDamageWithResistancePiercing(
      hitEntity,
      damage,
      {
        // projectile, not override — override bypasses the target's
        // Resistance at the engine level unconditionally, regardless of
        // the snapshotted resistPierce flag below. getBeamResistPierce()
        // (the sword's enchants at shoot-time) is meant to be the only
        // thing that can bypass Resistance, not the damage cause itself.
        cause: mc.EntityDamageCause.projectile,
        damagingEntity: source,
      },
      getBeamResistPierce(event.projectile),
    );

    if (damaged) {
      hitEntity.addEffect("slowness", BEAM_INFO.chargedAtk.targetSlownessDurationTicks, {
        amplifier: BEAM_INFO.chargedAtk.targetSlownessAmplifier,
      });
    }
  } catch {}

  if (damaged) {
    stampLastHitByPlayer(hitEntity, getOwnerName(event.projectile));
  }

  if (damaged && source instanceof mc.Player) {
    const soundLoc = vec3.add(
      vec3.normalize(
        vec3.subtract(
          vec3.add(hitEntity.location, vec3.UP),
          source.getHeadLocation(),
        ),
      ),
      source.getHeadLocation(),
    );

    source.playSound("slasher.beam.hitmarker", {
      location: soundLoc,
      pitch: randf(0.95, 1.05),
    });
  }

  vanish(event.projectile);
}

/** @param {mc.ProjectileHitBlockAfterEvent} event */
function onChargedAtkBeamHitBlock(event) {
  if (!event.projectile.isValid) return;

  vanish(event.projectile);
}

/**
 * @param {mc.Entity} beamEntity
 * @param {boolean=} timeout
 **/
function vanish(beamEntity, timeout = false) {
  try {
    spawnVanishParticle(beamEntity, timeout);
    beamEntity.remove();
  } catch {}
}

/**
 * @param {mc.Entity} beamEntity
 * @param {boolean=} timeout
 **/
function spawnVanishParticle(beamEntity, timeout = false) {
  if (timeout) {
    if (
      beamEntity.typeId === BEAM_INFO.fastAtk.entityTypeId &&
      Number(beamEntity.getProperty("lc:bit")) !== 1
    )
      return;

    beamEntity.dimension.spawnParticle(
      "lc:slasher_beam_timeout_emitter",
      beamEntity.location,
    );

    return;
  }

  if (beamEntity.typeId === BEAM_INFO.fastAtk.entityTypeId) {
    beamEntity.dimension.spawnParticle(
      "lc:slasher_beam_hit_weak_emitter",
      beamEntity.location,
    );
    return;
  }

  if (beamEntity.typeId === BEAM_INFO.chargedAtk.entityTypeId) {
    beamEntity.dimension.spawnParticle(
      "lc:slasher_beam_hit_strong_emitter",
      beamEntity.location,
    );
  }
}

/**
 * @param {mc.Entity} beamEntity
 * @returns {string | undefined}
 */
function getSourceId(beamEntity) {
  const value = beamEntity.getDynamicProperty("lc:sourceId");
  if (typeof value !== "string") return undefined;
  return value;
}

/**
 * @param {mc.Entity} beamEntity
 * @param {string=} value
 */
function setSourceId(beamEntity, value) {
  beamEntity.setDynamicProperty("lc:sourceId", value);
}

/**
 * @param {mc.Entity} beamEntity
 * @param {mc.Vector3} value
 */
function setRotation(beamEntity, value) {
  beamEntity.setProperty("lc:rotation_x", value.x);
  beamEntity.setProperty("lc:rotation_y", value.y);
  beamEntity.setProperty("lc:rotation_z", value.z);
}

/**
 * @param {mc.Entity} beamEntity
 */
function makeVisible(beamEntity) {
  beamEntity.setProperty("lc:is_visible", true);
}
