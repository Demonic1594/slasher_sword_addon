import { Entity, EquipmentSlot, GameMode, Player, system, world } from "@minecraft/server";
import { CONFIG } from "../config.js";
import * as vec3 from "./vec3.js";

/**
 * A point roughly at the entity's chest/torso height — the midpoint between
 * its head and feet locations, nudged up slightly. Used to place hit/impact
 * particles somewhere more natural-looking than the entity's feet-level
 * `.location`.
 * @param {Entity} entity
 * @returns {mc.Vector3}
 */
export function getEntityBodyLocation(entity) {
  const midpoint = vec3.midpoint(entity.getHeadLocation(), entity.location);
  return vec3.add(midpoint, { x: 0, y: 0.29, z: 0 });
}

/**
 * Whether the player's game mode is creative or spectator.
 * (Previously its own file; merged here since every caller already imports entity utils.)
 * @param {Player} player
 * @returns {boolean}
 */
export function isPlayerCreativeOrSpectator(player) {
  const gameMode = player.getGameMode();
  return gameMode === GameMode.Creative || gameMode === GameMode.Spectator;
}

/**
 * The single "can this entity legally be attacked right now" rule, shared by
 * every damage path the Slasher has (fast-attack, charged-attack, plunge-impact,
 * and both beam-hit types). Non-player entities are always attackable; players
 * are only attackable when PvP is enabled and they're not in creative or
 * spectator mode.
 * @param {Entity} entity Entity that would receive damage.
 * @returns {boolean}
 */
export function canBeAttacked(entity) {
  if (!(entity instanceof Player)) return true;
  if (!world.gameRules.pvp) return false;
  return !isPlayerCreativeOrSpectator(entity);
}

/**
 * Gets what would be the name of the entity, in this order: `Player name > Name tag > Translated type ID`.
 * @param {Entity | string} entity Entity object or type ID string.
 * @returns {import("@minecraft/server").RawText} RawText object.
 */
export function getEntityName(entity) {
  if (typeof entity === "string") {
    return getTranslatedEntityTypeId(entity);
  }

  try {
    if (!(entity instanceof Entity)) return { rawtext: [{ text: "Unknown" }] };

    if (entity.nameTag.trim() !== "") {
      return { rawtext: [{ text: entity.nameTag }] };
    }

    if (entity instanceof Player) {
      return { rawtext: [{ text: entity.name }] };
    }

    return getTranslatedEntityTypeId(entity.typeId);
  } catch {
    return { rawtext: [{ text: "Unknown" }] };
  }
}

/**
 * @param {string} typeId
 * @returns {import("@minecraft/server").RawText}
 */
function getTranslatedEntityTypeId(typeId) {
  const namespace = typeId.split(":")[0];
  const entityTypeId =
    namespace === "minecraft" ? typeId.replace("minecraft:", "") : typeId;

  return { rawtext: [{ translate: `entity.${entityTypeId}.name` }] };
}

const ARMOR_SLOTS = [
  EquipmentSlot.Head,
  EquipmentSlot.Chest,
  EquipmentSlot.Legs,
  EquipmentSlot.Feet,
];

/**
 * Calculates the final damage after applying armor reduction and the Protection enchantment bonus,
 * following Minecraft's mechanics as detailed on the Minecraft Wiki: https://minecraft.wiki/w/Armor#Damage_reduction
 *
 * Armor and Toughness are read straight from the engine
 * (`EntityEquippableComponent.totalArmor` / `.totalToughness`) rather than a
 * hardcoded per-item table, so this automatically reflects whatever's
 * actually equipped — including armor added by other add-ons/mods, as long
 * as it's defined with a normal `minecraft:armor` item component. There's
 * nothing here to keep in sync with vanilla's own armor values, and nothing
 * that needs updating for a third-party armor set to "just work".
 *
 * @param {number} damage The initial damage value.
 * @param {Entity} entity The entity receiving damage.
 * @param {number} [breachLevel] Mace-Breach-style armor-piercing level; reduces the target's
 *   effective armor points by `15% * breachLevel` before the armor formula runs, so the final
 *   damage scales relative to the (now weaker) armor rather than being a flat bonus.
 * @returns {number} The final damage after applying damage reductions.
 */
export function calculateFinalDamage(damage, entity, breachLevel = 0) {
  if (damage <= 0) return 0;

  let equippable;
  try {
    equippable = entity.getComponent("equippable");
    if (!equippable) return damage;
  } catch {
    return damage;
  }

  // Read straight from the engine — this is exactly what the vanilla
  // damage pipeline itself uses, computed from whatever "minecraft:armor"
  // component each equipped item actually declares, so third-party armor
  // is picked up automatically with no table to maintain here.
  let totalArmor = 0;
  let totalToughness = 0;
  try {
    totalArmor = equippable.totalArmor;
    totalToughness = equippable.totalToughness;
  } catch {
    totalArmor = 0;
    totalToughness = 0;
  }

  // Protection has no equivalent "total" getter, so this still has to walk
  // each armor slot itself — but only to read the Protection enchantment
  // level, never to look up armor/toughness values.
  let totalProtection = 0;
  for (const slot of ARMOR_SLOTS) {
    let equipment;
    try {
      equipment = equippable.getEquipment(slot);
    } catch {
      continue;
    }
    if (!equipment) continue;

    try {
      const enchantable = equipment.getComponent("enchantable");
      const protLevel = enchantable?.getEnchantment("protection")?.level ?? 0;
      totalProtection += protLevel;
    } catch {
      continue;
    }
  }

  // Breach-style armor piercing: reduce the target's effective armor points
  // before running the normal reduction formula, so the extra damage from
  // piercing scales together with whatever base damage/toughness is in play,
  // rather than being tacked on afterwards as a flat bonus.
  if (breachLevel > 0) {
    const armorReductionFraction = Math.min(
      1,
      CONFIG.enchantScaling.breachArmorReductionPerLevel * breachLevel,
    );
    totalArmor *= 1 - armorReductionFraction;
  }

  // Armor Reduction
  const armorReductionFactor =
    Math.min(
      20,
      Math.max(totalArmor / 5, totalArmor - damage / (2 + totalToughness / 4)),
    ) / 25;
  const damageAfterArmor = damage * (1 - armorReductionFactor);

  // Protection Enchantment Reduction
  const protectionReduction = Math.min(totalProtection * 0.04, 0.8);
  const finalDamage = damageAfterArmor * (1 - protectionReduction);

  return Math.max(0, Math.floor(finalDamage));
}

/**
 * Checks whether `target` can be seen along a straight line from any of the given
 * origins, by firing an entity-ray from each origin towards `targetLocation` and
 * checking whether `target` is amongst the hits. Used by both the charged-attack
 * range check and the plunge-impact landing check, each of which offers a couple
 * of candidate ray origins (e.g. eye height and a slightly-forward point) so a
 * target isn't missed just because one particular origin happened to clip a wall.
 * Each ray's direction is always computed from its own origin, so origin and
 * direction can never end up mismatched.
 * @param {import("@minecraft/server").Dimension} dimension
 * @param {import("@minecraft/server").Vector3[]} origins Candidate ray origins, tried in order.
 * @param {Entity} target Entity to look for in the ray hits.
 * @param {import("@minecraft/server").Vector3} [targetLocation] Point aimed at; defaults to `target.location`.
 * @param {boolean} [normalizeDirection] Whether to normalize the ray direction before casting.
 * @returns {boolean} Whether any of the rays hit the target.
 */
export function hasLineOfSightFromAny(
  dimension,
  origins,
  target,
  targetLocation = target.location,
  normalizeDirection = false,
) {
  for (const origin of origins) {
    let direction = {
      x: targetLocation.x - origin.x,
      y: targetLocation.y - origin.y,
      z: targetLocation.z - origin.z,
    };

    if (normalizeDirection) {
      const len = Math.hypot(direction.x, direction.y, direction.z);
      if (len > 0) {
        direction = { x: direction.x / len, y: direction.y / len, z: direction.z / len };
      }
    }

    let hits;
    try {
      hits = dimension.getEntitiesFromRay(origin, direction);
    } catch {
      continue;
    }

    if (hits.some((hit) => hit.entity === target)) return true;
  }

  return false;
}

/**
 * Stamps `entity` with who last hit it (by name, not a live Entity/Player
 * reference) and when, as a pair of dynamic properties. Used by every
 * Slasher damage path (melee swings, chainsaw ticks, plunge impact, and both
 * beam types) so anything downstream — currently the kill leaderboard in
 * slasher/leaderboard.js — has a reliable, resilient way to answer "did the
 * Slasher kill this?" without needing a still-valid reference to the
 * attacker, which may no longer resolve by the time it matters (attacker
 * logged off, a beam landing ticks after it was fired, etc.).
 * @param {Entity} entity The entity that was hit.
 * @param {string | undefined} attackerName
 */
export function stampLastHitByPlayer(entity, attackerName) {
  if (!attackerName) return;
  try {
    entity.setDynamicProperty("lc:lastHitByPlayerName", attackerName);
    entity.setDynamicProperty("lc:lastHitByPlayerTick", system.currentTick);
  } catch {}
}

/**
 * Reads back what {@link stampLastHitByPlayer} stamped onto `entity`, if
 * anything.
 * @param {Entity} entity
 * @returns {{ name: string, tick: number } | undefined}
 */
export function getLastHitByPlayer(entity) {
  try {
    const name = entity.getDynamicProperty("lc:lastHitByPlayerName");
    const tick = entity.getDynamicProperty("lc:lastHitByPlayerTick");
    if (typeof name !== "string" || typeof tick !== "number") return undefined;
    return { name, tick };
  } catch {
    return undefined;
  }
}
