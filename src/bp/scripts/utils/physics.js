import * as mc from "@minecraft/server";

/**
 * Custom "impulse" implementation, replacing the engine's own (deprecated)
 * Entity.applyImpulse so its behavior is consistent regardless of API version.
 * Works on any entity, not just players.
 *
 * IMPORTANT: this module intentionally does NOT patch @minecraft/server's
 * built-in classes (e.g. mc.Player.prototype). Behavior packs share a single
 * JS environment on a world; patching a shared prototype is global and
 * load-order-dependent; the last script pack to load its own patch silently
 * wins over any other pack's, which is a common cause of unpredictable
 * physics bugs when running this alongside other scripted add-ons. Exporting
 * plain functions and calling them explicitly keeps the same behavior fully
 * self-contained.
 *
 * @param {mc.Entity} entity The entity to apply the impulse to.
 * @param {mc.Vector3} vector The vector of the impulse.
 */
export function applyImpulse(entity, vector) {
  const { x, y, z } = vector;
  const previousVelocity = entity.getVelocity();

  // Horizontal strength is scaled 2.5x based on experimentation. The current
  // Entity.applyKnockback(horizontalForce: {x, z}, verticalStrength) takes
  // direction and magnitude combined as a single vector (unlike the
  // 4-argument directionX/directionZ/horizontalStrength/verticalStrength
  // form this used to call, which @minecraft/server 2.0.0 removed) — so
  // scaling the raw x/z straight through is equivalent to the old
  // normalize-then-multiply-by-strength dance, just without needing it.
  const horizontalForce = { x: x * 2.5, z: z * 2.5 };

  // The vertical component is directly taken as verticalStrength.
  // The previous velocity is also taken into account, because normal impulse retains
  // the previous velocity and knockback does not.
  const verticalStrength = y + previousVelocity.y * 0.9;

  // Apply the knockback
  entity.applyKnockback(horizontalForce, verticalStrength);
}

/**
 * Clears the velocity of an entity. This applies a knockback with the opposite
 * direction and the same strength as the current velocity in horizontal direction.
 * Works on any entity, not just players.
 * @param {mc.Entity} entity The entity to clear the velocity of.
 */
export function clearVelocity(entity) {
  const { x, z } = entity.getVelocity();

  // Applying the exact negated horizontal velocity as the knockback vector
  // cancels it out.
  entity.applyKnockback({ x: -x, z: -z }, 0);
}
