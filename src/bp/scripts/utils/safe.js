/**
 * Runs `fn` and logs/swallows any exception instead of letting it propagate.
 *
 * Use this to wrap the body of every `world.afterEvents`/`beforeEvents`
 * subscriber and every `system.run`/`system.runInterval`/`system.runTimeout`
 * callback. On a server/realm with multiple concurrent players, an unhandled
 * exception in one of these can affect far more than the player who
 * triggered it — `system.runInterval` in particular reuses the same
 * registration every tick, so a single throw risks cancelling all future
 * ticks of that interval for everyone. Wrapping each callback means one
 * player's edge case (an entity that just became invalid, a component
 * missing for a single tick during teleport/respawn, etc.) can't silently
 * break the addon world-wide.
 *
 * @template T
 * @param {string} label Short description of what was being run, used only in the log.
 * @param {() => T} fn
 * @returns {T | undefined}
 */
export function safeInvoke(label, fn) {
  try {
    return fn();
  } catch (e) {
    console.warn(`[Slasher] Unhandled error in ${label}: ${e?.stack ?? e}`);
    return undefined;
  }
}
