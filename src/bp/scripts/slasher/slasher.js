/**
 * ============================================================================
 * SLASHER — CORE BEHAVIOR
 * ============================================================================
 * The Slasher is driven by a small state machine: `Slasher` (an ItemExtender,
 * see item_extender/) holds a single `currentState`, and every tick/event
 * simply forwards to whichever state is currently active. Each state is a
 * `SlasherState` subclass below, roughly in the order they can be entered:
 *
 *   IdleState        — nothing happening; waiting for the item to be used.
 *   FastAtkState      — quick melee swing + matching beam.
 *   ChargingState     — holding the charge-attack button; charges up. Held
 *                       while gliding long enough (see CONFIG.stormSlash)
 *                       branches into Storm Slash instead on release:
 *   StormSlashWindupState — brief windup before the flight dash.
 *   StormSlashStrikeState — the dash itself: forward impulses, steered by
 *                       view direction, until it ends or hits something.
 *   StormSlashFinishState — clean mid-air ending (didn't hit anything).
 *   StormSlashImpactState — ended by ramming into something solid.
 *   ChargedAtkState   — releases the charge: dash + swing/beam, then either
 *                       ends or (if a target is right in front) hands off to:
 *   LockonAtkState    — grabs a target and repeatedly chainsaws it in place.
 *   PlungeWindupState — rises briefly before a ground-pound plunge.
 *   PlungeFallState   — falling during the plunge, accelerating over time.
 *   PlungeImpactState — the landing hit: ground-pound damage + effects.
 *
 * A state transitions to the next by calling `slasher.changeState(new X(...))`
 * — see `Slasher.changeState` below for the exact enter/exit lifecycle.
 * ============================================================================
 */

import * as mc from "@minecraft/server";
import * as vec3 from "../utils/vec3.js";
import { CONFIG } from "../config.js";
import { ItemExtender, registerItemExtender } from "../item_extender/item_extender.js";
import {
  calculateFinalDamage,
  canBeAttacked,
  getEntityBodyLocation,
  getEntityName,
  hasLineOfSightFromAny,
  stampLastHitByPlayer,
} from "../utils/entity.js";
import { clamp, randf, randi } from "../utils/math.js";
import * as physics from "../utils/physics.js";
import { safeInvoke } from "../utils/safe.js";
import { shootChargedAtkBeam, shootFastAtkBeam } from "./beam.js";
import {
  applyFireAspectDebilitation,
  applySlasherDamage,
  invalidateMendingCacheFor,
  shouldApplyDurabilityDamage,
} from "./enchant_interactions.js";

// Extend "lc:slasher" item with scripting
registerItemExtender("lc:slasher", (args) => new Slasher(args));

class Slasher extends ItemExtender {
  constructor(args) {
    super(args);

    /** @private @type {SlasherState} */
    this.currentState = new IdleState(this);
    this.currentState.onEnter();
  }

  /** @private Whether a post-dash landing-resistance watch is currently running. */
  dashResistanceActive = false;
  /** @private Ticks elapsed since the current dash landing-resistance watch started. */
  dashResistanceTicksElapsed = 0;

  onCreate() {
    this.user.startItemCooldown("slasher_pick", CONFIG.cooldowns.pick);
    invalidateMendingCacheFor(this.user);
  }

  onTick(itemStack) {
    safeInvoke("dash landing resistance tracking", () =>
      this.tickDashResistanceTracking(),
    );
    this.currentState.tick(itemStack);
  }

  /**
   * Starts (or restarts) the post-dash landing-resistance watch: grants an
   * immediate pulse of Resistance and arms tickDashResistanceTracking() to
   * keep refreshing it every tick until the user lands. Safe to call again
   * mid-watch (e.g. chaining another dash while still airborne) — it simply
   * resets the elapsed-ticks counter and re-pulses the effect.
   */
  startDashResistanceTracking() {
    this.dashResistanceActive = true;
    this.dashResistanceTicksElapsed = 0;

    this.user.addEffect("resistance", CONFIG.dash.resistanceRefreshTicks, {
      amplifier: CONFIG.dash.resistanceAmplifier,
      showParticles: false,
    });
  }

  /**
   * Runs every tick (regardless of the current SlasherState) while a dash
   * landing-resistance watch is active. Keeps Resistance topped up as long
   * as the user hasn't landed yet, so the covered airtime always matches
   * however long the user actually stays airborne — whether that's from a
   * single dash, a dash off a tall cliff, or several chained dashes — rather
   * than a duration guessed once at dash-time. See CONFIG.dash for details.
   */
  tickDashResistanceTracking() {
    if (!this.dashResistanceActive) return;

    this.dashResistanceTicksElapsed++;

    const timedOut =
      this.dashResistanceTicksElapsed >= CONFIG.dash.resistanceMaxTrackedTicks;

    if (this.user.isOnGround || timedOut) {
      this.dashResistanceActive = false;

      // Only bother with the extra-safe final pulse if we actually landed;
      // if we just hit the safety timeout while still airborne, stop
      // refreshing rather than granting more free resistance.
      if (this.user.isOnGround) {
        this.user.addEffect(
          "resistance",
          CONFIG.dash.resistanceRefreshTicks +
            CONFIG.dash.resistanceLandingBufferTicks,
          {
            amplifier: CONFIG.dash.resistanceAmplifier,
            showParticles: false,
          },
        );
      }

      return;
    }

    this.user.addEffect("resistance", CONFIG.dash.resistanceRefreshTicks, {
      amplifier: CONFIG.dash.resistanceAmplifier,
      showParticles: false,
    });
  }

  /**
   * @param {mc.ItemStartUseAfterEvent} event
   * @returns {boolean}
   */
  isUsable(event) {
    if (this.isNeedingRepair(this.getDurabilityComp(event.itemStack)))
      return false;
    return this.currentState.isUsable(event);
  }

  onStartUsing(event) {
    this.currentState.onStartUsing(event);
  }

  onStopUsing(event) {
    this.currentState.onStopUsing(event);
  }

  onSwing(event) {
    this.currentState.onSwing(event);
  }

  onHitEntity(event) {
    this.currentState.onHitEntity(event);
  }

  onHitBlock(event) {
    this.currentState.onHitBlock(event);
  }

  /**
   * @param {SlasherState} newState
   */
  changeState(newState) {
    this.currentState.onExit();
    this.currentState = newState;
    this.currentState.onEnter();
  }

  /** @returns {mc.Vector3} */
  getHeadFrontLocation() {
    return vec3.add(this.user.getHeadLocation(), this.user.getViewDirection());
  }

  /**
   * @param {number} intensity
   * @param {number} seconds
   * @param {("positional" | "rotational")=} shakeType
   */
  shakeCamera(intensity, seconds, shakeType = "rotational") {
    this.user.runCommand(
      `camerashake add @s ${intensity.toFixed(2)} ${seconds.toFixed(2)} ${shakeType}`,
    );
  }

  /**
   * @param {string} soundId
   * @param {mc.WorldSoundOptions=} opts
   */
  playSoundAtHeadFront(soundId, opts) {
    this.user.dimension.playSound(soundId, this.getHeadFrontLocation(), opts);
  }

  /**
   * @param {string} soundId
   * @param {number=} maxDist
   * @param {mc.PlayerSoundOptions=} opts
   */
  playSound3DAnd2D(soundId, maxDist = 15, opts) {
    const soundId2D = `${soundId}.2d`;
    this.user.playSound(soundId2D, opts);

    const listeners = this.user.dimension.getPlayers({
      location: this.user.getHeadLocation(),
      maxDistance: maxDist,
    });

    for (const listener of listeners) {
      if (listener === this.user) continue;

      listener.playSound(soundId, {
        location: this.user.getHeadLocation(),
        pitch: opts?.pitch,
        volume: opts?.volume,
      });
    }
  }

  /**
   * @param {string} id
   * @returns {number}
   */
  getCooldown(id) {
    return this.user.getItemCooldown(id);
  }

  /**
   * @param {string} id
   * @param {number=} duration
   */
  setCooldown(id, duration = 2) {
    this.user.startItemCooldown(id, duration);
  }

  /** @returns {number|undefined} */
  getNextDurabilityDamage() {
    const value = this.user.getDynamicProperty("lc:nextSlasherDurabilityDamage");
    if (typeof value !== "number") return;
    return Math.floor(value);
  }

  /** @param {number=} value */
  setNextDurabilityDamage(value) {
    this.user.setDynamicProperty(
      "lc:nextSlasherDurabilityDamage",
      value == undefined || value <= 0 ? undefined : Math.floor(value),
    );
  }

  /**
   * @param {number} value
   */
  addNextDurabilityDamage(value) {
    if (!shouldApplyDurabilityDamage(this.userMainhandSlot.getItem())) return;

    let current = this.getNextDurabilityDamage();
    if (typeof current !== "number") current = 0;
    this.setNextDurabilityDamage(current + Math.floor(value));
  }

  /**
   * @param {mc.ItemDurabilityComponent} durabilityComp
   * @returns {number}
   */
  getCurrentDurability(durabilityComp) {
    return durabilityComp.maxDurability - durabilityComp.damage;
  }

  /**
   * @param {mc.ItemDurabilityComponent} durabilityComp
   * @returns {boolean}
   */
  isNeedingRepair(durabilityComp) {
    return durabilityComp.damage >= durabilityComp.maxDurability;
  }

  /**
   * @param {mc.ItemDurabilityComponent} durabilityComp
   * @returns {boolean}
   */
  processNextDurabilityDamage(durabilityComp) {
    const nextDurabilityDamage = this.getNextDurabilityDamage();
    if (nextDurabilityDamage == undefined) return false;

    this.setNextDurabilityDamage(undefined);

    if (this.user.getGameMode() === mc.GameMode.Creative) return false;
    if (this.isNeedingRepair(durabilityComp)) return false;

    const newDamage = Math.min(
      this.getCurrentDurability(durabilityComp),
      nextDurabilityDamage,
    );

    durabilityComp.damage += newDamage;

    return true;
  }

  /**
   * @param {mc.ItemStack} slasherItem
   * @returns {mc.ItemDurabilityComponent}
   */
  getDurabilityComp(slasherItem) {
    const comp = slasherItem.getComponent("durability");
    if (!comp) throw new Error("Durability component does not exist");
    return comp;
  }

  /** @returns {boolean} Whether the user is sneaking. */
  isSneaking() {
    const isSneakInputButtonPressed =
      this.user.inputInfo.getButtonState(mc.InputButton.Sneak) ===
      mc.ButtonState.Pressed;

    return this.user.isSneaking || isSneakInputButtonPressed;
  }
}

/**
 * Base class every Slasher state extends. Subclasses override whichever hooks
 * they care about; all of them default to a no-op, so a state only needs to
 * implement the handful that matter to it. `currentTick` is scoped to the
 * state instance — it starts at 0 when the state is entered, not the game's
 * global tick counter — which is why timing comments elsewhere in this file
 * ("every 3 ticks", "at tick 4", etc.) always mean "since entering this state."
 */
class SlasherState {
  /**
   * @param {Slasher} slasher
   */
  constructor(slasher) {
    /** @readonly */ this.slasher = slasher;
    /** @private */ this._currentTick = 0;
  }

  get currentTick() {
    return this._currentTick;
  }

  onEnter() {}
  onExit() {}

  /**
   * @param {mc.ItemStack} itemStack
   */
  tick(itemStack) {
    try {
      this.onTick(itemStack);
    } finally {
      this._currentTick++;
    }
  }

  /**
   * @protected
   * @param {mc.ItemStack} itemStack
   */
  onTick(itemStack) {}

  /**
   * @param {mc.ItemStartUseAfterEvent} event
   */
  isUsable(event) {
    return true;
  }

  /**
   * @param {mc.ItemStartUseAfterEvent} event
   */
  onStartUsing(event) {}

  /**
   * @param {mc.ItemStopUseAfterEvent} event
   */
  onStopUsing(event) {}

  /**
   * Fires on every swing, whether or not it connects with anything —
   * alongside (not instead of) onHitEntity/onHitBlock when it does connect.
   * @param {mc.PlayerSwingStartAfterEvent} event
   */
  onSwing(event) {}

  /**
   * @param {mc.EntityHitEntityAfterEvent} event
   */
  onHitEntity(event) {}

  /**
   * @param {mc.EntityHitBlockAfterEvent} event
   */
  onHitBlock(event) {}
}

/**
 * The resting state: nothing is happening. The Slasher sits here between
 * attacks, waiting for the item to be used (fast-attack) or held (charging).
 */
class IdleState extends SlasherState {
  /** @param {mc.ItemStack} itemStack */
  onTick(itemStack) {
    const durabilityComp = this.slasher.getDurabilityComp(itemStack);

    if (this.slasher.isNeedingRepair(durabilityComp)) {
      this.slasher.user.onScreenDisplay.setActionBar({
        translate: "slasher.repairNeeded",
      });
      return;
    }

    if (this.slasher.processNextDurabilityDamage(durabilityComp)) {
      this.slasher.userMainhandSlot.setItem(itemStack);
      return;
    }

    if (!this.slasher.isUsing) return;

    this.slasher.changeState(new ChargingState(this.slasher));
  }

  onStartUsing() {
    this.slasher.user.playSound("random.click", { pitch: 1.4, volume: 0.8 });
  }

  /** @param {mc.PlayerSwingStartAfterEvent} event */
  onSwing(event) {
    if (event.swingSource !== mc.EntitySwingSource.Attack) return;
    this.slasher.changeState(new FastAtkState(this.slasher));
  }

  onHitEntity() {
    this.slasher.changeState(new FastAtkState(this.slasher));
  }

  onHitBlock() {
    this.slasher.changeState(new FastAtkState(this.slasher));
  }
}

/**
 * The quick, un-charged melee attack: a short swing that damages nearby
 * entities in front of the user, paired with a matching fast-attack beam.
 */
class FastAtkState extends SlasherState {
  static COMBO = CONFIG.fastAtk.combo;
  static PREVENT_CHARGE_TICK = CONFIG.fastAtk.preventChargeTick;
  static COOLDOWN_MAX = CONFIG.fastAtk.cooldownMaxTicks;
  static SWING_DAMAGE = CONFIG.fastAtk.swingDamage;

  // comboIndex is carried over from the previous FastAtkState instance (see
  // changeState calls below) so a chained swing advances the combo instead
  // of every hit restarting at hit 1. Whiffing (state lifespan runs out
  // without a follow-up swing) or completing hit 4 both reset it to 0.
  //
  // NOTE: these are set in the constructor body rather than as class-field
  // initializers, since class fields initialize before the rest of an
  // explicit constructor body runs — a `ticksUntilExitState = ...` field
  // relying on `this.comboIndex` would read it before it's assigned.
  constructor(slasher, comboIndex = 0) {
    super(slasher);
    this.comboIndex = comboIndex % FastAtkState.COMBO.length;
    this.ticksUntilExitState = FastAtkState.COMBO[this.comboIndex].lifespanTicks;
    this.cooldown = 0;
    this.isNextSwingQueued = true;
  }

  onTick() {
    if (this.ticksUntilExitState <= 0) {
      // Whiffed the combo window — drop back to hit 1 next time, not
      // wherever we left off.
      this.resetAnimationCooldowns();
      this.slasher.changeState(new IdleState(this.slasher));
      return;
    }

    if (
      this.ticksUntilExitState < FastAtkState.PREVENT_CHARGE_TICK &&
      this.slasher.isUsing
    ) {
      this.resetAnimationCooldowns();
      this.slasher.changeState(new ChargingState(this.slasher));
      return;
    }

    this.ticksUntilExitState--;

    if (this.cooldown > 0) {
      this.cooldown--;
      return;
    }

    if (!this.isNextSwingQueued) return;

    try {
      this.fastAttack();
    } finally {
      this.isNextSwingQueued = false;
    }
  }

  /** @param {mc.PlayerSwingStartAfterEvent} event */
  onSwing(event) {
    if (event.swingSource !== mc.EntitySwingSource.Attack) return;
    this.isNextSwingQueued = true;
  }

  onHitEntity() {
    this.isNextSwingQueued = true;
  }

  onHitBlock() {
    this.isNextSwingQueued = true;
  }

  onStopUsing() {
    // Hits flagged requireAttackInput (currently hit 3 and hit 4) must be
    // queued by an actual left-click swing landing (onHitEntity/onHitBlock),
    // not by tapping/releasing right-click mid-combo.
    if (FastAtkState.COMBO[this.comboIndex].requireAttackInput) return;
    this.isNextSwingQueued = true;
  }

  resetAnimationCooldowns() {
    for (const entry of FastAtkState.COMBO) {
      this.slasher.setCooldown(`slasher_${entry.anim}`, 0);
    }
  }

  fastAttack() {
    const entry = FastAtkState.COMBO[this.comboIndex];

    this.ticksUntilExitState = entry.lifespanTicks;
    this.cooldown += FastAtkState.COOLDOWN_MAX;

    // Only one combo-step cooldown should be "live" at a time — that's what
    // the fp animation controller keys off of to pick which swing to show.
    this.resetAnimationCooldowns();
    this.slasher.setCooldown(`slasher_${entry.anim}`, entry.cooldownTicks);

    this.slasher.user.playAnimation(`animation.slasher.tp.${entry.anim}`);

    const nextComboIndex = (this.comboIndex + 1) % FastAtkState.COMBO.length;

    this.slasher.shakeCamera(0.05, 0.09);
    this.slasher.playSoundAtHeadFront("slasher.fast_atk");

    mc.system.run(() => {
      safeInvoke("fast-atk swing (beam + nearby damage)", () => {
        shootFastAtkBeam(this.slasher.user);
        this.swingDamageNearbyEntities(entry);
      });
    });

    // Advance the combo for the *next* swing. This doesn't change state —
    // onHitEntity/onHitBlock/onStopUsing above just queue another swing of
    // the current FastAtkState instance — so we track the pending index
    // and hand it off if/when this state is ever re-entered fresh.
    this.comboIndex = nextComboIndex;
  }

  swingDamageNearbyEntities(entry) {
    const entities = this.slasher.user.dimension.getEntities({
      closest: 10,
      maxDistance: entry.hitboxMaxDistance,
      excludeTypes: ["minecraft:item", "minecraft:xp_orb"],
      location: this.slasher.getHeadFrontLocation(),
    });

    const itemStack = this.slasher.userMainhandSlot.getItem();

    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];

      if (entity === this.slasher.user) continue;
      if (!canBeAttacked(entity)) continue;

      const damage = Math.max(
        1,
        calculateFinalDamage(
          FastAtkState.SWING_DAMAGE * entry.damageMultiplier,
          entity,
          CONFIG.enchantScaling.breachLevel,
        ),
      );

      let damaged = false;
      try {
        damaged = applySlasherDamage(itemStack, entity, damage, {
          cause: mc.EntityDamageCause.entityAttack,
          damagingEntity: this.slasher.user,
        });
      } catch {}

      if (!damaged) continue;

      applyFireAspectDebilitation(itemStack, entity);
      stampLastHitByPlayer(entity, this.slasher.user.name);

      this.slasher.addNextDurabilityDamage(CONFIG.fastAtk.durabilityDamagePerHit);
    }
  }
}

/**
 * Entered while the player holds down the use button: winds up towards a
 * charged attack, showing the charge-progress UI, until either released
 * (-> ChargedAtkState) or cancelled.
 */
class ChargingState extends SlasherState {
  static CHARGE_UI_FRAMES = CONFIG.charging.chargeUiFrames;
  static FULL_CHARGE_DURATION = this.CHARGE_UI_FRAMES.length;
  static STORM_UI_FRAMES = CONFIG.charging.stormChargeUiFrames;
  static STORM_READY_FRAMES = CONFIG.charging.stormReadyUiFrames;
  static STORM_CHARGE_DURATION = CONFIG.stormSlash.chargeDurationTicks;
  static HARD_TIMEOUT_TICKS = CONFIG.charging.hardTimeoutTicks;

  constructor(slasher) {
    super(slasher);

    // Only eligible for Storm Slash if gliding for the *entire* hold, not
    // just at the moment of release — matches the behavior this is ported
    // from. Checked fresh every tick in onTick() and invalidated the first
    // time it isn't true.
    /** @private */
    this.stormSlashEligible = this.slasher.user.isGliding;
  }

  onTick() {
    // Hard timeout: unconditional, doesn't depend on isUsing at all. Added
    // because the isUsing-based self-heal right below this can itself get
    // stuck — its trigger condition is isUsing having already flipped to
    // false, but the actual failure mode being guarded against here is
    // itemStopUse not delivering *at all* while gliding, which means
    // isUsing can stay stuck at true forever too, never tripping that
    // check. No legitimate charge (even a full Storm Slash hold, the
    // longest one there is) comes anywhere close to this many ticks, so
    // reaching it at all means the release was never delivered by any
    // means — force it now regardless of what isUsing currently reads.
    if (this.currentTick >= ChargingState.HARD_TIMEOUT_TICKS) {
      console.warn(
        "[Slasher] ChargingState hard timeout: forcing a release after " +
          `${ChargingState.HARD_TIMEOUT_TICKS} ticks with no itemStopUse ` +
          "(isUsing was still " +
          `${this.slasher.isUsing}).`,
      );
      this.onStopUsing();
      return;
    }

    // Safety net: if the wrapper's own isUsing flag has already flipped to
    // false, the normal release path (onStopUsing(), fired from the
    // itemStopUse event handler) should already have moved us out of
    // ChargingState entirely — reaching this line at all means that never
    // happened. Observed specifically for an early release (before a full
    // charge) while gliding, where the Elytra flight state appears to
    // occasionally drop the itemStopUse dispatch itself rather than
    // anything in this state machine failing to react to it — the charge UI
    // and pose otherwise sit frozen indefinitely, only resolving once some
    // *later* itemStopUse happens to go through. Rather than track down
    // exactly why that dispatch gets dropped, treat the mismatch itself as
    // the release the moment it's noticed, which is at most one tick later
    // than it should have fired.
    if (!this.slasher.isUsing) {
      console.warn(
        "[Slasher] ChargingState self-heal: isUsing was false but the " +
          "state never left ChargingState — forcing the release now.",
      );
      this.onStopUsing();
      return;
    }

    if (this.stormSlashEligible && !this.slasher.user.isGliding) {
      this.stormSlashEligible = false;
    }

    if (
      this.stormSlashEligible &&
      this.currentTick === ChargingState.STORM_CHARGE_DURATION - 1
    ) {
      this.slasher.playSoundAtHeadFront("slasher.charged_storm_slash");
    }

    this.updateActionbar();

    if (this.currentTick === 0) {
      this.slasher.setCooldown("slasher_charging_start", CONFIG.cooldowns.chargingStart);

      this.slasher.user.playAnimation("animation.slasher.tp.charging_start");
    }

    if (this.currentTick > 0 && this.currentTick % 6 === 0) {
      this.slasher.user.playAnimation("animation.slasher.tp.charging_hold");
    }

    if (
      this.currentTick === 1 ||
      (this.currentTick !== 0 && this.currentTick % 8 === 0)
    ) {
      this.slasher.playSoundAtHeadFront("slasher.charge_loop");
    }
  }

  updateActionbar() {
    if (this.currentTick < ChargingState.FULL_CHARGE_DURATION) {
      const text = ChargingState.CHARGE_UI_FRAMES[this.currentTick];

      this.slasher.user.onScreenDisplay.setActionBar(`§c${text}`);
      return;
    }

    if (this.stormSlashEligible) {
      if (this.currentTick < ChargingState.STORM_CHARGE_DURATION) {
        const index = Math.min(
          ChargingState.STORM_UI_FRAMES.length - 1,
          Math.floor(
            (this.currentTick / ChargingState.STORM_CHARGE_DURATION) *
              ChargingState.STORM_UI_FRAMES.length,
          ),
        );

        this.slasher.user.onScreenDisplay.setActionBar(
          `§c${ChargingState.STORM_UI_FRAMES[index]}`,
        );
        return;
      }

      const frames = ChargingState.STORM_READY_FRAMES;
      this.slasher.user.onScreenDisplay.setActionBar(
        frames[this.currentTick % frames.length],
      );
      return;
    }

    // Flashy colors for fully charged
    const text =
      ChargingState.CHARGE_UI_FRAMES[ChargingState.FULL_CHARGE_DURATION - 1];

    this.slasher.user.onScreenDisplay.setActionBar(
      (this.currentTick % 2 === 0 ? "§d" : "§b") + text,
    );
  }

  onStopUsing() {
    if (
      this.stormSlashEligible &&
      this.currentTick >= ChargingState.STORM_CHARGE_DURATION
    ) {
      this.onReleaseStormSlash();
      return;
    }

    if (this.currentTick >= ChargingState.FULL_CHARGE_DURATION) {
      this.onReleaseFullCharge();
      return;
    }

    this.onCancelCharge();
  }

  onCancelCharge() {
    // Cancelling a charge should start fast attack
    this.slasher.changeState(new FastAtkState(this.slasher));
    mc.system.run(() => {
      safeInvoke("charge-cancel actionbar reset", () =>
        this.slasher.user.onScreenDisplay.setActionBar("§8---"),
      );
    });
  }

  onReleaseStormSlash() {
    this.slasher.user.onScreenDisplay.setActionBar("§l§c< < X > >");
    this.slasher.changeState(new StormSlashWindupState(this.slasher));
  }

  onReleaseFullCharge() {
    const shouldDoPlunge =
      !this.slasher.user.isOnGround &&
      this.slasher.user.getRotation().x > 65 &&
      this.slasher.user.inputInfo.getButtonState(mc.InputButton.Jump) ===
        mc.ButtonState.Pressed;

    if (shouldDoPlunge) {
      this.slasher.changeState(new PlungeWindupState(this.slasher));
      return;
    }

    if (this.slasher.user.isGliding) {
      // ChargedAtkState's own forward impulse would otherwise work as a
      // free flight boost that doesn't need Storm Slash's dedicated (and
      // more heavily gated — must stay glide-eligible for the whole hold)
      // path. A gliding player who releases a full charge without having
      // qualified for Storm Slash the whole time just gets nothing here,
      // rather than silently falling back to the ground-combat dash mid-air.
      this.slasher.changeState(new IdleState(this.slasher));
      return;
    }

    this.slasher.user.onScreenDisplay.setActionBar("§c< X >");
    this.slasher.changeState(new ChargedAtkState(this.slasher));
  }
}

/**
 * Released charge attack: dashes the user forward (with a matching beam),
 * dealing heavy damage to anything caught in the swing. If a target ends up
 * right in front of the user afterwards, this hands off into LockonAtkState
 * to grab and chainsaw it; otherwise it just ends back at IdleState.
 */
class ChargedAtkState extends SlasherState {
  static GROUND_DASH_DURATION = CONFIG.dash.groundDashDurationTicks;
  static AIR_DASH_DURATION = CONFIG.dash.airDashDurationTicks;
  static CHARGED_ATK_DAMAGING_DURATION = CONFIG.chargedAtk.damagingDurationTicks;

  static CHARGED_ATK_DAMAGE = CONFIG.chargedAtk.damage;

  static ATK_EXCLUDED_FAMILIES = ["ignore_slasher_charged_atk"];
  static LOCKON_EXCLUDED_FAMILIES = [
    "inanimate",
    "projectile",
    "ignore_slasher_lockon",
  ];
  static ATK_EXCLUDED_TYPES = ["minecraft:item", "minecraft:xp_orb"];
  static LOCKON_EXCLUDED_TYPES = [
    "minecraft:arrow",
    "minecraft:snowball",
    "minecraft:fireball",
    "minecraft:wither",
    "minecraft:ender_dragon",
  ];
  static LOCKON_EXCLUDED_TAGS = [];

  weaknessEffect = true;
  chargedAtkStartTick = 0;
  alreadyHitEntities = /** @type {mc.Entity[]} */ ([]);

  onTick() {
    if (this.weaknessEffect && this.currentTick % CONFIG.chargedAtk.weaknessEffect.everyNTicks === 0) {
      this.slasher.user.addEffect("weakness", CONFIG.chargedAtk.weaknessEffect.durationTicks, {
        amplifier: CONFIG.chargedAtk.weaknessEffect.amplifier,
        showParticles: false,
      });
    }

    if (this.currentTick === 0) {
      this.onInitialTick();
    }

    if (this.isDuringChargedAtk) {
      this.onTickChargedAtk(this.currentTick - this.chargedAtkStartTick);
    }

    if (!this.isAfterChargedAtk) return;

    this.weaknessEffect = false;

    if (this.slasher.isUsing) {
      this.slasher.changeState(new ChargingState(this.slasher));
      return;
    }

    if (this.currentTick >= this.chargedAtkStartTick + 30) {
      this.slasher.changeState(new IdleState(this.slasher));
    }
  }

  onHitEntity() {
    if (!this.isAfterChargedAtk) return;
    this.slasher.changeState(new FastAtkState(this.slasher));
  }

  onHitBlock() {
    if (!this.isAfterChargedAtk) return;
    this.slasher.changeState(new FastAtkState(this.slasher));
  }

  onSwing() {
    if (!this.isAfterChargedAtk) return;
    this.slasher.changeState(new FastAtkState(this.slasher));
  }

  get isDuringChargedAtk() {
    return (
      this.currentTick >= this.chargedAtkStartTick &&
      this.currentTick <
        this.chargedAtkStartTick + ChargedAtkState.CHARGED_ATK_DAMAGING_DURATION
    );
  }

  get isAfterChargedAtk() {
    return (
      this.currentTick >=
      this.chargedAtkStartTick + ChargedAtkState.CHARGED_ATK_DAMAGING_DURATION
    );
  }

  onInitialTick() {
    const shouldDash = this.slasher.user.inputInfo.getMovementVector().y > 0.6;

    if (!shouldDash) {
      return;
    }

    const isOnGround = this.slasher.user.isOnGround;
    const impulse = this.getDashImpulse(isOnGround);

    physics.applyImpulse(this.slasher.user, impulse);
    this.slasher.startDashResistanceTracking();

    this.chargedAtkStartTick = isOnGround
      ? ChargedAtkState.GROUND_DASH_DURATION
      : ChargedAtkState.AIR_DASH_DURATION;
    this.slasher.setCooldown("slasher_dash", CONFIG.cooldowns.dash);
    this.slasher.playSound3DAnd2D("slasher.dash", 10, { volume: 1.3 });

    this.slasher.shakeCamera(0.05, 0.08);

    this.slasher.user.playAnimation("animation.slasher.tp.charging_hold");
  }

  /**
   * @param {boolean} isOnGround
   * @returns {mc.Vector3}
   */
  getDashImpulse(isOnGround) {
    const base = vec3.changeDir(
      vec3.scale(vec3.FORWARD, CONFIG.dash.airImpulseMagnitude),
      this.slasher.user.getViewDirection(),
    );

    if (!isOnGround) return base;

    const groundImpulse = vec3.normalize({
      x: base.x,
      y: 0,
      z: base.z,
    });

    return vec3.scale(groundImpulse, CONFIG.dash.groundImpulseMagnitude);
  }

  /** @param {number} atkTick */
  onTickChargedAtk(atkTick) {
    const lockon = atkTick === 0 && this.slasher.isSneaking();

    const targets = this.getEntitiesInAtkRange(lockon);

    if (atkTick === 0) {
      this.slasher.playSound3DAnd2D("slasher.charged_atk", 10, { volume: 1.3 });

      this.slasher.user.playAnimation("animation.slasher.tp.charged_atk_start");

      if (lockon && targets.length > 0) {
        this.slasher.changeState(new LockonAtkState(this.slasher, targets));
        return;
      }

      this.slasher.setCooldown("slasher_charged_atk_continue", CONFIG.cooldowns.chargedAtkContinue);
      this.slasher.setCooldown("slasher_charged_atk_start", CONFIG.cooldowns.chargedAtkStart);
      this.slasher.shakeCamera(0.07, 0.08);
    } else if (atkTick === 1) {
      shootChargedAtkBeam(this.slasher.user);

      this.slasher.user.playAnimation("animation.slasher.tp.charged_atk_end");
    }

    const itemStack = this.slasher.userMainhandSlot.getItem();

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];

      if (this.alreadyHitEntities.includes(target)) continue;

      let damaged = false;
      try {
        // Floored at 1, matching every other Slasher damage path — without
        // this, a heavily-armored/Protection-stacked target could take the
        // full wind-up of a charged attack and register 0 damage.
        const dmg = Math.max(
          1,
          calculateFinalDamage(
            ChargedAtkState.CHARGED_ATK_DAMAGE,
            target,
            CONFIG.enchantScaling.breachLevel,
          ),
        );

        damaged = applySlasherDamage(itemStack, target, dmg, {
          // entityAttack, not override — override bypasses the target's
          // Resistance at the engine level unconditionally, regardless of
          // whether the sword actually has the qualifying enchant. Letting
          // this behave like a normal hit means applySlasherDamage's own
          // resistance-piercing check (interaction #1 in
          // enchant_interactions.js) is the only thing that can bypass it.
          cause: mc.EntityDamageCause.entityAttack,
          damagingEntity: this.slasher.user,
        });
      } catch {}

      if (!damaged) continue;

      applyFireAspectDebilitation(itemStack, target);
      stampLastHitByPlayer(target, this.slasher.user.name);

      // Intentionally inert right now: no entity file in this pack defines
      // "lc:on_getting_chainsawed", so this call currently does nothing on
      // its own. Kept in on purpose as a stable extension point — any mob
      // (in this pack, or a third-party one) can define this event on
      // itself to react to being chainsawed (a hit animation, a sound, a
      // scripted behavior, etc.) with no script changes needed here. Its
      // value is in staying available for whatever hooks into it, not in
      // doing anything by itself today — don't remove this as "dead code."
      try {
        target.triggerEvent("lc:on_getting_chainsawed");
      } catch {}

      this.slasher.addNextDurabilityDamage(CONFIG.chargedAtk.durabilityDamagePerHit);

      if (i > 2) continue;

      const critParticleLoc = vec3.midpoint(
        this.slasher.user.getHeadLocation(),
        target.getHeadLocation(),
      );

      this.slasher.user.dimension.spawnParticle(
        "lc:slasher_spark_particle",
        critParticleLoc,
      );

      this.slasher.shakeCamera(0.13, 0.26);

      mc.system.runTimeout(() => {
        safeInvoke("critical-hit sound timeout", () =>
          this.slasher.playSoundAtHeadFront("slasher.critical", {
            volume: 1.1,
            pitch: randf(1, 1.08),
          }),
        );
      }, i);
    }
  }

  /**
   * @param {boolean} lockon
   * @returns {mc.Entity[]}
   */
  getEntitiesInAtkRange(lockon) {
    const headLoc = this.slasher.user.getHeadLocation();
    const viewDir = this.slasher.user.getViewDirection();
    const result = [];

    const checkPositions = [
      { z: 1.3, y: 0, maxDistance: 1.8 },
      { z: 2.7, y: 0, maxDistance: 1.8 },
      { z: 2.2, y: -1.4, maxDistance: 1.9 },
    ];

    const candidates = [];

    for (const pos of checkPositions) {
      const location = vec3.getRelativeToHead(headLoc, viewDir, {
        z: pos.z,
        y: pos.y ?? 0,
      });

      const entities = this.slasher.user.dimension.getEntities({
        closest: 5,
        maxDistance: pos.maxDistance,
        location,
        excludeFamilies: lockon
          ? [
              ...ChargedAtkState.ATK_EXCLUDED_FAMILIES,
              ...ChargedAtkState.LOCKON_EXCLUDED_FAMILIES,
            ]
          : ChargedAtkState.ATK_EXCLUDED_FAMILIES,
        excludeTypes: lockon
          ? [
              ...ChargedAtkState.ATK_EXCLUDED_TYPES,
              ...ChargedAtkState.LOCKON_EXCLUDED_TYPES,
            ]
          : ChargedAtkState.ATK_EXCLUDED_TYPES,
        excludeTags: lockon ? ChargedAtkState.LOCKON_EXCLUDED_TAGS : undefined,
      });

      candidates.push(...entities);
    }

    // Multiple check zones can return the same entity; dedupe before doing the
    // (comparatively expensive) raycast visibility check so each candidate is
    // only ever raycast once instead of once per zone it appeared in.
    const uniqueCandidates = new Set(candidates);

    for (const entity of uniqueCandidates) {
      if (entity === this.slasher.user) continue;
      if (!canBeAttacked(entity)) continue;

      const isVisible = hasLineOfSightFromAny(
        this.slasher.user.dimension,
        [this.slasher.user.getHeadLocation(), this.slasher.getHeadFrontLocation()],
        entity,
        entity.getHeadLocation(),
      );

      if (isVisible) result.push(entity);
    }

    return result;
  }
}

/**
 * Grabs a locked-on target and repeatedly chainsaws it in place every tick
 * for as long as the user holds sneak. Damage and speed both escalate the
 * longer a single target is held (see CONFIG.lockonAtk.escalation), with
 * Wither kicking in and eventually shutting off the target's healing
 * entirely past certain cumulative-damage thresholds.
 */
class LockonAtkState extends SlasherState {
  attackerLoc = /** @type {mc.Vector3} */ (vec3.ZERO);
  attackerRot = /** @type {mc.Vector2} */ (vec3.ZERO);
  targetLockLoc = /** @type {mc.Vector3} */ (vec3.ZERO);
  nextCritParticleTick = 0;
  tickWhenEndingStarted = -1;
  allowChangingState = false;

  /**
   * Cumulative HP dealt to each locked target since this grab began, keyed
   * by the target entity itself. Drives the damage/speed escalation and the
   * Wither/no-heal thresholds — see CONFIG.lockonAtk.escalation. Reset
   * naturally every time a new LockonAtkState is created (i.e. every fresh
   * grab starts the ramp-up over from zero).
   * @type {Map<mc.Entity, number>}
   */
  cumulativeDamageDealt = new Map();

  /**
   * Once a target crosses the no-heal threshold, this tracks the highest HP
   * value it's "allowed" to have — any tick where its actual HP comes back
   * higher (natural regen, the Regeneration effect, Instant Health, etc.)
   * gets clamped straight back down to this floor.
   * @type {Map<mc.Entity, number>}
   */
  healSuppressionFloor = new Map();

  /**
   * @param {Slasher} slasher
   * @param {mc.Entity[]} targets
   */
  constructor(slasher, targets) {
    super(slasher);
    this.targets = targets;
  }

  onEnter() {
    this.slasher.setCooldown("slasher_charged_atk_hold", CONFIG.cooldowns.chargedAtkHold);
    this.slasher.setCooldown("slasher_charged_atk_start", CONFIG.cooldowns.chargedAtkStart);

    if (this.targets.length <= 0) {
      return;
    }

    const firstTarget = this.targets[0];

    const attackerLoc = vec3.add(
      firstTarget.location,
      vec3.normalize(
        vec3.subtract(this.slasher.user.location, firstTarget.location),
      ),
    );

    this.slasher.user.tryTeleport(attackerLoc, {
      facingLocation: firstTarget.location,
    });

    this.attackerLoc = attackerLoc;
    this.attackerRot = this.slasher.user.getRotation();
    this.targetLockLoc = firstTarget.location;
    this.nextCritParticleTick = randi(1, 2);
  }

  onTick() {
    if (this.targets.length <= 0) {
      if (this.tickWhenEndingStarted === -1) {
        this.tickWhenEndingStarted = this.currentTick;
      }

      if (this.tickWhenEndingStarted !== -1) {
        this.onTickEnding();
      }

      return;
    }

    this.onTick_2();
  }

  onTickEnding() {
    const endingTick = this.currentTick - this.tickWhenEndingStarted;

    if (endingTick === 0) {
      this.slasher.setCooldown("slasher_charged_atk_end", CONFIG.cooldowns.chargedAtkEnd);
      this.slasher.playSound3DAnd2D("slasher.charged_atk", 10, { volume: 1.3 });

      this.slasher.user.playAnimation("animation.slasher.tp.charged_atk_end");
    } else if (endingTick === 4) {
      this.allowChangingState = true;
    }

    if (this.allowChangingState && this.slasher.isUsing) {
      this.slasher.changeState(new ChargingState(this.slasher));
      return;
    }

    if (endingTick >= 16) {
      this.slasher.setCooldown("slasher_pick", CONFIG.cooldowns.pick);
      this.slasher.changeState(new IdleState(this.slasher));
    }
  }

  onHitEntity() {
    if (!this.allowChangingState) return;
    this.slasher.user.removeEffect("weakness");
    this.slasher.user.removeEffect("resistance");
    this.slasher.changeState(new FastAtkState(this.slasher));
  }

  onHitBlock() {
    if (!this.allowChangingState) return;
    this.slasher.user.removeEffect("weakness");
    this.slasher.user.removeEffect("resistance");
    this.slasher.changeState(new FastAtkState(this.slasher));
  }

  onSwing() {
    if (!this.allowChangingState) return;
    this.slasher.user.removeEffect("weakness");
    this.slasher.user.removeEffect("resistance");
    this.slasher.changeState(new FastAtkState(this.slasher));
  }

  onTick_2() {
    const shouldStartEnding =
      this.targets.length <= 0 || !this.slasher.isSneaking();

    if (shouldStartEnding) {
      this.slasher.user.removeEffect("resistance");
      this.slasher.playSound3DAnd2D("slasher.chainsaw.finish", 10, {
        volume: 1.2,
      });
      this.spawnFinishEffect(this.targets);
      this.targets = [];
      return;
    }

    this.slasher.user.addEffect(
      "resistance",
      CONFIG.lockonAtk.userResistanceDurationTicks,
      {
        amplifier: CONFIG.lockonAtk.userResistanceAmplifier,
        showParticles: false,
      },
    );

    if (this.currentTick % CONFIG.lockonAtk.userWeaknessEveryNTicks === 0)
      this.slasher.user.addEffect("weakness", CONFIG.lockonAtk.userWeaknessDurationTicks, {
        amplifier: CONFIG.lockonAtk.userWeaknessAmplifier,
        showParticles: false,
      });

    if (this.currentTick % 8 === 0)
      this.slasher.playSound3DAnd2D("slasher.chainsaw.loop");

    try {
      this.onTickChainsawing();
    } catch {}
  }

  onTickChainsawing() {
    this.slasher.user.tryTeleport(this.attackerLoc, {
      rotation: this.attackerRot,
    });

    if (this.nextCritParticleTick === this.currentTick) {
      const critParticleLoc = vec3.add(
        this.slasher.user.getHeadLocation(),
        vec3.changeDir(
          vec3.scale(vec3.FORWARD, 0.45),
          this.slasher.user.getViewDirection(),
        ),
      );

      this.slasher.user.dimension.spawnParticle(
        "lc:slasher_spark_particle",
        critParticleLoc,
      );

      this.slasher.user.playSound("slasher.critical", {
        volume: 0.4,
        pitch: randf(0.98, 1.08),
      });

      this.nextCritParticleTick += randi(2, 4);
    }

    this.slasher.shakeCamera(0.08, 0.1);

    if (this.currentTick % 3 === 0) {
      this.slasher.user.playAnimation("animation.slasher.tp.charged_atk_hold");
    }

    // Hoisted above the loop — the item can't change mid-tick, so there's no
    // reason to re-fetch it once per target (every other damage site in this
    // file already does this).
    const itemStack = this.slasher.userMainhandSlot.getItem();

    for (let i = 0; i < this.targets.length; i++) {
      const target = this.targets[i];

      if (
        !target.isValid ||
        (ChargedAtkState.LOCKON_EXCLUDED_TAGS.length > 0 &&
          target.matches({ tags: ChargedAtkState.LOCKON_EXCLUDED_TAGS }))
      ) {
        this.targets.splice(i, 1);
        i--;
        continue;
      }

      const targetHealth = target.getComponent("health");

      if (targetHealth?.currentValue == 0) {
        this.slasher.user.removeEffect("resistance");
        this.targets.splice(i, 1);
        i--;
        continue;
      }

      target.tryTeleport(this.targetLockLoc, { keepVelocity: false });

      const escalation = CONFIG.lockonAtk.escalation;
      const cumulativeHp = this.cumulativeDamageDealt.get(target) ?? 0;
      const thresholdHp = escalation.thresholdHearts * CONFIG.hpPerHeart;
      const thresholdsCrossed = Math.floor(cumulativeHp / thresholdHp);

      const reachedWither = cumulativeHp >= escalation.witherThresholdHearts * CONFIG.hpPerHeart;
      const reachedNoHeal = cumulativeHp >= escalation.noHealThresholdHearts * CONFIG.hpPerHeart;

      // Wither + user Regeneration kick in at the 50-heart mark and persist
      // (reapplied every tick so they can't lapse) for the rest of the grab;
      // Wither's amplifier steps up again once the 75-heart no-heal mark hits.
      if (reachedWither) {
        try {
          target.addEffect(
            "wither",
            escalation.witherDurationTicks,
            {
              amplifier: reachedNoHeal
                ? escalation.noHealWitherAmplifier
                : escalation.witherAmplifier,
              showParticles: false,
            },
          );

          this.slasher.user.addEffect(
            "regeneration",
            escalation.userRegenDurationTicks,
            { amplifier: escalation.userRegenAmplifier, showParticles: false },
          );
        } catch {}
      }

      // Past the 75-heart mark, the target can no longer heal by any means
      // (natural regen, the Regeneration effect, Instant Health, ...): every
      // tick, if its HP came back higher than the floor we last saw, clamp
      // it straight back down.
      if (reachedNoHeal && targetHealth) {
        const floor = this.healSuppressionFloor.get(target);
        if (floor !== undefined && targetHealth.currentValue > floor) {
          try {
            targetHealth.setCurrentValue(floor);
          } catch {}
        }
      }

      // The actual damage tick is gated to an interval that starts at
      // baseIntervalTicks and speeds up (down to minIntervalTicks) as more
      // thresholds are crossed — "the speed of damage gets faster."
      const intervalTicks = clamp(
        escalation.baseIntervalTicks - thresholdsCrossed,
        escalation.minIntervalTicks,
        escalation.baseIntervalTicks,
      );

      if (this.currentTick % intervalTicks !== 0) {
        if (reachedNoHeal && targetHealth) {
          this.healSuppressionFloor.set(target, targetHealth.currentValue);
        }
        continue;
      }

      let damaged = false;
      let dmg = 0;
      try {
        // "The damage increased by +3 every 25 hearts" — an uncapped bonus
        // on top of the base per-tick damage, scaling with how much has
        // already been dealt to this specific target this grab.
        const bonusDamage = thresholdsCrossed * escalation.damageBonusPerThreshold;

        dmg = Math.max(
          1,
          calculateFinalDamage(
            CONFIG.lockonAtk.damagePerTick + bonusDamage,
            target,
            CONFIG.enchantScaling.breachLevel,
          ),
        );

        damaged = applySlasherDamage(itemStack, target, dmg, {
          // entityAttack, not override — override bypasses the target's
          // Resistance at the engine level unconditionally, regardless of
          // whether the sword actually has the qualifying enchant. Letting
          // this behave like a normal hit means applySlasherDamage's own
          // resistance-piercing check (interaction #1 in
          // enchant_interactions.js) is the only thing that can bypass it.
          cause: mc.EntityDamageCause.entityAttack,
          damagingEntity: this.slasher.user,
        });
      } catch {}

      if (!damaged) continue;

      try {
        this.slasher.user.dimension.spawnParticle(
          CONFIG.lockonAtk.hitEffect.particleId,
          getEntityBodyLocation(target),
        );
      } catch {}

      this.cumulativeDamageDealt.set(target, cumulativeHp + dmg);
      if (reachedNoHeal && targetHealth) {
        this.healSuppressionFloor.set(target, targetHealth.currentValue);
      }

      applyFireAspectDebilitation(itemStack, target);
      stampLastHitByPlayer(target, this.slasher.user.name);

      try {
        target.addEffect("slowness", CONFIG.lockonAtk.targetSlownessDurationTicks, {
          amplifier: CONFIG.lockonAtk.targetSlownessAmplifier,
        });
        // Intentionally inert for now — see the same triggerEvent call in
        // onTickChargedAtk above for why this is kept as-is.
        target.triggerEvent("lc:on_getting_chainsawed");
      } catch {}

      if (i !== 0) continue;

      if (this.currentTick % 2 === 0) {
        this.slasher.addNextDurabilityDamage(CONFIG.lockonAtk.durabilityDamagePerTick);
      }

      if (targetHealth) {
        this.displayEntityHealthInfo(targetHealth);
      }
    }
  }

  /**
   * Purely cosmetic release flourish: a bigger blood-burst particle on
   * every released target, plus a staggered camera-shake + critical-hit
   * sound + sparkle particle on the first few (so a multi-target release
   * reads as a rapid one-two-three rather than everything firing at once).
   * No damage is dealt here — the actual damage already happened tick by
   * tick in onTickChainsawing.
   * @param {mc.Entity[]} targets
   */
  spawnFinishEffect(targets) {
    const { finishEffect } = CONFIG.lockonAtk;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      if (!target.isValid) continue;

      const bodyLoc = getEntityBodyLocation(target);

      try {
        this.slasher.user.dimension.spawnParticle(
          finishEffect.particleId,
          bodyLoc,
        );
      } catch {}

      if (i >= finishEffect.maxStaggeredTargets) continue;

      const delayTicks = i * finishEffect.staggerDelayTicksPerTarget;

      mc.system.runTimeout(() => {
        try {
          this.slasher.shakeCamera(0.08, 0.08);
          this.slasher.user.playSound("slasher.critical", {
            volume: 1,
            pitch: randf(0.85, 1.1),
          });
          this.slasher.user.dimension.spawnParticle(
            finishEffect.sparkleParticleId,
            bodyLoc,
          );
        } catch {}
      }, delayTicks);
    }
  }

  /** @param {mc.EntityHealthComponent} health */
  displayEntityHealthInfo(health) {
    const entity = health.entity;

    const targetName = getEntityName(entity);

    const colorText =
      health.currentValue <= 0
        ? "§c"
        : health.currentValue <= 30
          ? mc.system.currentTick % 2 === 0
            ? "§b"
            : "§d"
          : "§e";

    const currentHealth = Math.floor(health.currentValue);
    const maxHealth = Math.floor(health.effectiveMax);
    const healthText = `${currentHealth} / ${maxHealth}`;

    const actionbarText = /** @type {mc.RawText} */ ({
      rawtext: [
        { text: colorText },
        { rawtext: targetName.rawtext },
        { text: " — ❤ " },
        { text: healthText },
      ],
    });

    this.slasher.user.onScreenDisplay.setActionBar(actionbarText);
  }
}

/**
 * The brief rise before a ground-pound plunge: lifts the user upward for a
 * moment (giving the pound a running start) before gravity takes over in
 * PlungeFallState. The user is protected with Resistance/Weakness for the
 * whole windup+fall+impact sequence so they can't be interrupted or hurt
 * mid-plunge.
 */
class PlungeWindupState extends SlasherState {
  static RISE_FORCE = CONFIG.plungeWindup.riseForce;
  static DURATION = CONFIG.plungeWindup.durationTicks;

  onEnter() {
    this.slasher.user.addEffect(
      "weakness",
      PlungeWindupState.DURATION + CONFIG.plungeWindup.weaknessExtraDurationTicks,
      {
        amplifier: CONFIG.plungeWindup.weaknessAmplifier,
        showParticles: false,
      },
    );

    this.slasher.user.addEffect(
      "resistance",
      PlungeWindupState.DURATION + CONFIG.plungeWindup.resistanceExtraDurationTicks,
      {
        amplifier: CONFIG.plungeWindup.resistanceAmplifier,
        showParticles: false,
      },
    );

    mc.system.run(() => {
      safeInvoke("plunge-windup rise impulse", () =>
        physics.applyImpulse(this.slasher.user, PlungeWindupState.RISE_FORCE),
      );
    });

    this.slasher.playSound3DAnd2D("slasher.plunge_windup", 15, {
      volume: 1.7,
      pitch: 1.2,
    });

    this.slasher.setCooldown("slasher_plunge_windup", CONFIG.cooldowns.plungeWindup);

    this.slasher.user.playAnimation("animation.slasher.tp.plunge_windup");
  }

  onTick() {
    if (this.currentTick < PlungeWindupState.DURATION) return;

    this.slasher.changeState(
      new PlungeFallState(this.slasher, this.slasher.user.location.y),
    );
  }
}

/**
 * Falling phase of the ground pound: accelerates downward the longer the
 * fall lasts (see CONFIG.plungeFall.speedBoost), so a plunge from very high
 * up keeps getting faster all the way down instead of settling at a fixed
 * speed. Ends the instant the user touches ground, handing off to
 * PlungeImpactState.
 */
class PlungeFallState extends SlasherState {
  static FALL_FORCE = CONFIG.plungeFall.fallForce;
  static SPEED_BOOST_INTERVAL_BLOCKS = CONFIG.plungeFall.speedBoost.intervalBlocks;
  static SPEED_BOOST_FORCE = CONFIG.plungeFall.speedBoost.force;

  /**
   * @param {Slasher} slasher
   * @param {number} startHeight
   */
  constructor(slasher, startHeight) {
    super(slasher);
    this.startHeight = startHeight;
    /** @private How many speed-boost intervals have already been applied this fall. */
    this.boostsApplied = 0;
  }

  onEnter() {
    this.addEffects();

    this.slasher.playSound3DAnd2D("slasher.charged_atk", 12, {
      volume: 1.3,
      pitch: randf(0.8, 0.9),
    });
    physics.applyImpulse(this.slasher.user, PlungeFallState.FALL_FORCE);
    this.slasher.setCooldown("slasher_plunge_fall", CONFIG.cooldowns.plungeFall);
    this.slasher.user.playAnimation("animation.slasher.tp.plunge_fall");
  }

  onTick() {
    if (this.currentTick % CONFIG.plungeFall.refreshEveryNTicks === 0) {
      this.addEffects();
    }

    safeInvoke("plunge-fall speed boost", () => this.tickSpeedBoost());

    if (this.currentTick === 0) return;

    if (this.currentTick % 5 === 0) {
      this.slasher.user.playAnimation("animation.slasher.tp.plunge_fall_hold");
    }

    const yVelocity = this.slasher.user.getVelocity().y;

    // Ray distance is driven by actual fall speed, so this naturally keeps
    // up with however fast the speed-boosts above have made the fall.
    const blockBelow = this.slasher.user.dimension.getBlockFromRay(
      this.slasher.user.location,
      vec3.DOWN,
      {
        maxDistance: Math.abs(yVelocity * 2),
      },
    );

    if (!blockBelow && yVelocity < -0.5) return;

    this.slasher.changeState(
      new PlungeImpactState(this.slasher, this.startHeight),
    );
  }

  /**
   * Every SPEED_BOOST_INTERVAL_BLOCKS fallen, kicks in an extra downward
   * impulse so the plunge keeps noticeably accelerating the longer it
   * falls, rather than leveling off at a single speed. Distance-based
   * (not tick-based) so it stays correct regardless of how fast the user
   * is already falling from previous boosts. Uncapped — a long enough
   * drop keeps getting faster the whole way down, same spirit as the
   * uncapped ground-pound damage in PlungeImpactState.
   */
  tickSpeedBoost() {
    const fallenSoFar = this.startHeight - this.slasher.user.location.y;
    if (fallenSoFar <= 0) return;

    const intervalsPassed = Math.floor(
      fallenSoFar / PlungeFallState.SPEED_BOOST_INTERVAL_BLOCKS,
    );

    if (intervalsPassed <= this.boostsApplied) return;

    const newBoosts = intervalsPassed - this.boostsApplied;
    this.boostsApplied = intervalsPassed;

    for (let i = 0; i < newBoosts; i++) {
      physics.applyImpulse(this.slasher.user, PlungeFallState.SPEED_BOOST_FORCE);
    }

    this.slasher.playSoundAtHeadFront("slasher.dash", {
      volume: 1.0,
      pitch: 0.6,
    });
  }

  addEffects() {
    this.slasher.user.addEffect("resistance", CONFIG.plungeFall.resistanceDurationTicks, {
      amplifier: CONFIG.plungeFall.resistanceAmplifier,
      showParticles: false,
    });

    this.slasher.user.addEffect("weakness", CONFIG.plungeFall.weaknessDurationTicks, {
      amplifier: CONFIG.plungeFall.weaknessAmplifier,
      showParticles: false,
    });
  }
}

/**
 * The landing hit of the ground pound: deals fall-distance-scaled damage
 * (with a Density-style bonus, see CONFIG.enchantScaling) to everything
 * nearby, and grants the user a brief high-amplifier Resistance pulse at the
 * exact moment of landing so the impact itself can't register as fall
 * damage against them.
 */
class PlungeImpactState extends SlasherState {
  static MIN_DEPTH_CONSIDERED_AS_HIGH = CONFIG.plungeImpact.minDepthConsideredHigh;
  static CHANGE_STATE_ALLOWED_TICK = CONFIG.plungeImpact.changeStateAllowedTick;

  /**
   * @param {Slasher} slasher
   * @param {number} startHeight
   */
  constructor(slasher, startHeight) {
    super(slasher);

    this.fallenDepth = startHeight - this.slasher.user.location.y;
    this.fellFromHigh =
      this.fallenDepth >= PlungeImpactState.MIN_DEPTH_CONSIDERED_AS_HIGH;

    this.slasher.user.addEffect("weakness", CONFIG.plungeImpact.weaknessDurationTicks, {
      amplifier: CONFIG.plungeImpact.weaknessAmplifier,
      showParticles: false,
    });

    // A short, high-amplifier resistance tick right at the moment of landing —
    // it's as if the sword (not the user) absorbed the impact force. Kept
    // deliberately short so it wears off on its own almost immediately rather
    // than lingering as a lasting buff.
    this.slasher.user.addEffect("resistance", CONFIG.plungeImpact.landingResistanceDurationTicks, {
      amplifier: CONFIG.plungeImpact.landingResistanceAmplifier,
      showParticles: false,
    });
  }

  onEnter() {
    if (
      this.fallenDepth <= 1.2 ||
      (!this.slasher.user.isFalling && !this.slasher.user.isOnGround)
    ) {
      this.slasher.playSoundAtHeadFront("mace.smash_air", { volume: 1.1 });
      return;
    }

    this.slasher.addNextDurabilityDamage(Math.ceil(this.fallenDepth / 2));

    const impactLocation = this.getImpactLocation();

    mc.system.run(() => {
      safeInvoke("plunge-impact nearby damage", () =>
        this.hurtNearbyEntities(impactLocation),
      );
    });

    if (this.fellFromHigh) {
      this.slasher.playSoundAtHeadFront("mace.heavy_smash_ground", {
        volume: 1.1,
      });

      this.slasher.playSound3DAnd2D("slasher.plunge_impact", 20, {
        volume: 1.8,
        pitch:
          this.fallenDepth > 50
            ? 0.7
            : this.fallenDepth > 20
              ? randf(0.85, 0.95)
              : 1,
      });

      if (mc.system.serverSystemInfo.memoryTier > mc.MemoryTier.Low) {
        this.slasher.user.dimension.spawnEntity(
          "lc:ground_impact_particle_spawner",
          impactLocation,
        );
      }
    } else {
      this.slasher.playSoundAtHeadFront("mace.smash_ground", { volume: 1.1 });
      this.slasher.playSoundAtHeadFront("slasher.critical", { volume: 1.4 });
    }

    this.slasher.setCooldown("slasher_plunge_impact", CONFIG.cooldowns.plungeImpact);

    this.slasher.user.spawnParticle(
      "lc:slasher_spark_particle",
      vec3.add(impactLocation, { x: 0, y: 0.9, z: 0 }),
    );

    this.shakeNearbyPlayerCameras(impactLocation);

    this.slasher.user.playAnimation("animation.slasher.tp.plunge_impact");
  }

  /**
   * @param {mc.Vector3} param0
   */
  shakeNearbyPlayerCameras({ x, y, z }) {
    const locString = `${x} ${y} ${z}`;
    this.slasher.user.dimension.runCommand(
      `execute positioned ${locString} run camerashake add @a[r=10] 0.3 0.35 rotational`,
    );
  }

  getImpactLocation() {
    const raycastHit = this.slasher.user.dimension.getBlockFromRay(
      vec3.add(this.slasher.user.location, { x: 0, y: -1.0, z: 0 }),
      vec3.DOWN,
      { maxDistance: 15 },
    );

    if (!raycastHit) return this.slasher.user.location;

    const loc = vec3.add(raycastHit.block.location, raycastHit.faceLocation);

    return vec3.add(loc, { x: 0, y: 0.1, z: 0 });
  }

  /** @param {mc.Vector3} impactLocation */
  hurtNearbyEntities(impactLocation) {
    const maxDist = this.calculateHitRadius();

    const entities = this.slasher.user.dimension.getEntities({
      location: impactLocation,
      maxDistance: maxDist,
      excludeFamilies: ["ignore_slasher_plunge"],
      excludeTypes: ["minecraft:item", "minecraft:xp_orb"],
      closest: 20,
    });

    const itemStack = this.slasher.userMainhandSlot.getItem();

    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];

      if (entity === this.slasher.user) continue;
      if (!canBeAttacked(entity)) continue;

      const dist = vec3.distance(entity.location, impactLocation);

      if (dist >= 2 && !entity.isOnGround) continue;

      // Ray must hit for an entity that is not very close
      if (dist >= 3) {
        const isVisible = hasLineOfSightFromAny(
          entity.dimension,
          [impactLocation, vec3.add(impactLocation, { x: 0, y: 2, z: 0 })],
          entity,
          entity.location,
          true, // original code normalized the ray direction here
        );

        if (!isVisible) continue;
      }

      const damage = Math.max(
        1,
        calculateFinalDamage(
          this.calculateDamage(),
          entity,
          CONFIG.enchantScaling.breachLevel,
        ),
      );

      try {
        const damaged = applySlasherDamage(itemStack, entity, damage, {
          cause: mc.EntityDamageCause.maceSmash,
          damagingEntity: this.slasher.user,
        });

        if (damaged) {
          entity.addEffect("slowness", CONFIG.plungeImpact.targetSlownessDurationTicks, {
            amplifier: CONFIG.plungeImpact.targetSlownessAmplifier,
          });

          applyFireAspectDebilitation(itemStack, entity);
          stampLastHitByPlayer(entity, this.slasher.user.name);
        }
      } catch {}
    }
  }

  /**
   * How far the ground-pound's AoE reaches: a base radius, plus a bonus
   * every `hitRadius.perTierBlocksFallen` fallen, clamped to
   * [hitRadius.min, hitRadius.max]. Unlike calculateDamage() below, this IS
   * capped — see the comment on CONFIG.plungeImpact.hitRadius for why an
   * uncapped blast radius wouldn't actually be a good idea even though the
   * damage itself deliberately has no ceiling.
   * @returns {number}
   */
  calculateHitRadius() {
    const { base, min, max, perTierBlocksFallen, perTierBonus } =
      CONFIG.plungeImpact.hitRadius;

    const tiersReached = Math.floor(this.fallenDepth / perTierBlocksFallen);
    const radius = base + tiersReached * perTierBonus;

    return clamp(radius, min, max);
  }

  /**
   * Base ground-pound damage plus a Density-V-style bonus (0.5 damage per
   * block fallen, per level — same formula as the vanilla Mace's Density
   * enchant) so the smash keeps scaling with how far the user fell.
   * @returns {number}
   */
  calculateDamage() {
    const base = Math.round(
      CONFIG.plungeImpact.baseDamageMultiplier *
        (this.fallenDepth / CONFIG.plungeImpact.fallenDepthDivisor),
    );

    const densityBonus = Math.round(
      CONFIG.enchantScaling.densityDamagePerBlockPerLevel *
        CONFIG.enchantScaling.densityLevel *
        this.fallenDepth,
    );

    // No upper clamp — mirrors the vanilla Mace, which has no damage
    // ceiling either: the further the fall, the harder the hit, forever.
    return Math.max(base + densityBonus, CONFIG.plungeImpact.minDamage);
  }

  onTick() {
    if (
      this.currentTick >= PlungeImpactState.CHANGE_STATE_ALLOWED_TICK &&
      this.slasher.isUsing
    ) {
      this.slasher.changeState(new ChargingState(this.slasher));
      return;
    }

    if (this.currentTick >= 12) {
      this.slasher.changeState(new IdleState(this.slasher));
      this.slasher.setCooldown("slasher_pick", CONFIG.cooldowns.pick);
    }
  }

  onHitEntity() {
    if (this.currentTick < PlungeImpactState.CHANGE_STATE_ALLOWED_TICK) return;
    this.slasher.changeState(new FastAtkState(this.slasher));
  }

  onHitBlock() {
    if (this.currentTick < PlungeImpactState.CHANGE_STATE_ALLOWED_TICK) return;
    this.slasher.changeState(new FastAtkState(this.slasher));
  }

  onSwing() {
    if (this.currentTick < PlungeImpactState.CHANGE_STATE_ALLOWED_TICK) return;
    this.slasher.changeState(new FastAtkState(this.slasher));
  }
}

/**
 * Storm Slash, part 1/4: a brief windup once ChargingState hands off (see
 * ChargingState.onReleaseStormSlash). Purely a beat before the dash — no
 * movement here, just camera feel + sound + waiting to confirm the player
 * is still gliding when the windup ends.
 */
class StormSlashWindupState extends SlasherState {
  static DURATION_TICKS = CONFIG.stormSlash.windup.durationTicks;

  onEnter() {
    this.slasher.shakeCamera(
      CONFIG.stormSlash.windup.cameraShake.intensity,
      CONFIG.stormSlash.windup.cameraShake.seconds,
    );
    this.slasher.setCooldown(
      "slasher_storm_slash_windup",
      CONFIG.cooldowns.stormSlashWindup,
    );
    this.slasher.playSound3DAnd2D("slasher.storm_slash_windup", 15, {
      volume: 1.5,
    });
  }

  onTick() {
    if (this.currentTick < StormSlashWindupState.DURATION_TICKS) return;

    if (this.slasher.user.isGliding) {
      this.slasher.changeState(new StormSlashStrikeState(this.slasher));
      return;
    }

    // Stopped gliding partway through the windup — nothing to dash off of,
    // so cancel back to idle instead of launching a flight move with no
    // Elytra deployed.
    this.slasher.setCooldown("slasher_pick", CONFIG.cooldowns.pick);
    this.slasher.changeState(new IdleState(this.slasher));
  }
}

/**
 * Storm Slash, part 2/4: the flight dash itself. An initial forward burst
 * on entry, then every tick a smaller continuous correction that steers
 * back toward the player's current view direction — see
 * createContinuousForce(). Ends either by running out the clock (a clean
 * finish) or by shouldImpact() detecting the player has stopped gliding,
 * slowed to a near-stop, or is about to hit a solid block.
 *
 * Deals no direct damage — see the CONFIG.stormSlash doc comment. Whatever
 * gets rammed on the way takes whatever knockback/collision the forced
 * movement itself causes, nothing more.
 */
class StormSlashStrikeState extends SlasherState {
  static CFG = CONFIG.stormSlash.strike;

  onEnter() {
    this.applyConstantEffect();

    const force = vec3.changeDir(
      { x: 0, y: 0, z: StormSlashStrikeState.CFG.initialImpulseMagnitude },
      this.slasher.user.getViewDirection(),
    );
    mc.system.run(() => {
      // The native applyImpulse, NOT physics.applyImpulse. physics.js's
      // wrapper goes through Player.applyKnockback specifically because raw
      // applyImpulse causes visible rubber-banding for normal, grounded
      // player movement (client/server reconciliation fighting the
      // server-set velocity) — but knockback is also the mechanic vanilla
      // dampens while an Elytra is deployed, to stop PVP knockback-canceling
      // glide combos. Route a flight boost through it and the horizontal
      // component gets silently suppressed by that same anti-abuse
      // dampening, leaving only a vertical nudge — exactly this bug. Gliding
      // isn't normal grounded movement, so the rubber-banding concern
      // doesn't apply here; this is also what the source this was ported
      // from (v4-1) actually calls for this exact move.
      safeInvoke("storm slash initial impulse", () =>
        this.slasher.user.applyImpulse(force),
      );
    });

    this.slasher.shakeCamera(
      StormSlashStrikeState.CFG.cameraShake.intensity,
      StormSlashStrikeState.CFG.cameraShake.seconds,
    );
    this.slasher.setCooldown(
      "slasher_storm_slash_strike",
      CONFIG.cooldowns.stormSlashStrike,
    );
    this.slasher.playSound3DAnd2D("slasher.storm_slash_strike", 15, {
      volume: 1.5,
      pitch: randf(0.94, 1.03),
    });
  }

  onTick() {
    if (this.currentTick >= StormSlashStrikeState.CFG.maxDurationTicks) {
      this.slasher.changeState(new StormSlashFinishState(this.slasher));
      return;
    }

    if (this.shouldImpact()) {
      this.slasher.changeState(new StormSlashImpactState(this.slasher));
      return;
    }

    this.applyConstantEffect();

    const force = this.createContinuousForce();
    safeInvoke("storm slash continuous impulse", () =>
      this.slasher.user.applyImpulse(force),
    );

    this.slasher.shakeCamera(
      StormSlashStrikeState.CFG.continuousCameraShake.intensity,
      StormSlashStrikeState.CFG.continuousCameraShake.seconds,
    );
  }

  /**
   * Resistance + Weakness at max amplifier, refreshed every tick rather
   * than applied once for the whole state — same trick
   * PlungeWindupState/PlungeImpactState use so the forced movement (and
   * ramming into things) can't hurt the user, and stray vanilla punch
   * damage can't happen while they're being flung around.
   */
  applyConstantEffect() {
    const cfg = StormSlashStrikeState.CFG;
    this.slasher.user.addEffect("resistance", cfg.effectDurationTicks, {
      amplifier: cfg.effectAmplifier,
      showParticles: false,
    });
    this.slasher.user.addEffect("weakness", cfg.effectDurationTicks, {
      amplifier: cfg.effectAmplifier,
      showParticles: false,
    });
  }

  /**
   * The dash doesn't just fly in a fixed direction from the initial burst —
   * every tick it corrects back toward wherever the player is currently
   * looking, weighted by how far off their current velocity already is
   * from that look direction (a bigger gap between the two means a bigger
   * correction). This is what makes the dash "steerable" while it's
   * in progress.
   * @returns {mc.Vector3}
   */
  createContinuousForce() {
    const cfg = StormSlashStrikeState.CFG;
    const viewDir = this.slasher.user.getViewDirection();
    const currentVelocity = this.slasher.user.getVelocity();
    const velocityNorm = vec3.normalize(currentVelocity);
    const angle = Math.acos(clamp(vec3.dot(velocityNorm, viewDir), -1, 1));
    const forwardForce = Math.max(
      cfg.continuousImpulseMin,
      angle / cfg.continuousImpulseAngleDivisor,
    );

    const target = vec3.changeDir({ x: 0, y: 0, z: forwardForce }, viewDir);

    return target;
  }

  shouldImpact() {
    const cfg = StormSlashStrikeState.CFG;

    if (!this.slasher.user.isGliding) return true;

    const velocityLen = vec3.length(this.slasher.user.getVelocity());
    if (velocityLen < cfg.minVelocityForContinue) return true;

    const searchDist = Math.max(cfg.minBlockSearchDistance, velocityLen);
    const block = this.slasher.user.getBlockFromViewDirection({
      maxDistance: searchDist,
      includeLiquidBlocks: false,
      includePassableBlocks: false,
    });

    return block !== undefined;
  }
}

/**
 * Storm Slash, part 3/4a: a clean ending — the dash ran its full course
 * without hitting anything. No dedicated fp/tp animation for this state (it
 * doesn't exist in the source this is ported from either): the strike
 * animation's own cooldown is sized to stay active through this whole
 * window too (see CONFIG.cooldowns.stormSlashStrike), so the controller
 * just holds the strike pose on its last frame while this plays out.
 */
class StormSlashFinishState extends SlasherState {
  static DURATION_TICKS = CONFIG.stormSlash.finish.durationTicks;
  static CHANGE_STATE_ALLOWED_TICK = 4;

  onEnter() {
    this.slasher.playSound3DAnd2D("slasher.storm_slash_finish", 15, {
      volume: 1.3,
      pitch: 1.04,
    });
  }

  onTick() {
    if (
      this.currentTick >= StormSlashFinishState.CHANGE_STATE_ALLOWED_TICK &&
      this.slasher.isUsing
    ) {
      this.slasher.changeState(new ChargingState(this.slasher));
      return;
    }

    if (this.currentTick < StormSlashFinishState.DURATION_TICKS) return;
    this.exit();
  }

  exit() {
    this.slasher.setCooldown("slasher_pick", CONFIG.cooldowns.pick);
    this.slasher.changeState(new IdleState(this.slasher));
  }
}

/**
 * Storm Slash, part 3/4b: ended by ramming into something solid instead of
 * finishing clean. tryTeleport-ing the player to their own current location
 * on the first tick is a standard Bedrock trick for an instant, hard stop —
 * teleporting to where you already are zeroes out momentum immediately,
 * rather than letting the flight velocity bleed off naturally.
 */
class StormSlashImpactState extends SlasherState {
  static DURATION_TICKS = CONFIG.stormSlash.impact.durationTicks;
  static CHANGE_STATE_ALLOWED_TICK = 4;

  onEnter() {
    this.slasher.setCooldown(
      "slasher_storm_slash_impact",
      CONFIG.cooldowns.stormSlashImpact,
    );
    this.slasher.playSound3DAnd2D("slasher.storm_slash_impact", 18, {
      volume: 1.6,
    });
  }

  onTick() {
    if (this.currentTick === 1) {
      safeInvoke("storm slash impact velocity reset", () =>
        this.slasher.user.tryTeleport(this.slasher.user.location),
      );
    }

    if (
      this.currentTick >= StormSlashImpactState.CHANGE_STATE_ALLOWED_TICK &&
      this.slasher.isUsing
    ) {
      this.slasher.changeState(new ChargingState(this.slasher));
      return;
    }

    if (this.currentTick < StormSlashImpactState.DURATION_TICKS) return;
    this.exit();
  }

  exit() {
    this.slasher.setCooldown("slasher_pick", CONFIG.cooldowns.pick);
    this.slasher.changeState(new IdleState(this.slasher));
  }
}
