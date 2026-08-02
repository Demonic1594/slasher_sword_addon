# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> [!NOTE]
> ## Legacy Releases
> Versions **1.0.0** and **1.0.1** were originally developed in the **Slasher v1** repository before development continued in this repository. 
> 
> **Original repository:** https://github.com/lc-studios-mc/slasher-v1/

---

## [1.8.22]

### Fixed

- Fix: RP<->BP manifest dependency mismatch. The RP has its own reverse
  dependency on the BP (in addition to the BP's existing dependency on the
  RP) that was still pinned to 1.8.20 while everything else had moved to
  1.8.21 — same class of bug as the earlier one-directional version, just
  never caught in this direction before now. Both directions are now kept
  in lockstep on every version bump.
- Fix: three states — ChargedAtkState's post-attack window, LockonAtkState's
  ending window, and PlungeImpactState — had onHitEntity/onHitBlock
  (chaining a landed hit into a fresh FastAtkState) but were missing the
  matching onSwing, so an air-swing from those specific windows didn't
  chain into a combo the way a landed hit already did. Re-added, matching
  IdleState and FastAtkState's own combo queue, which already had it.
- Fix: added an unconditional hard-timeout safety net to ChargingState
  (CONFIG.charging.hardTimeoutTicks, 200 ticks), ahead of the existing
  isUsing-based self-heal. Root cause of the still-reported stuck-charging
  bug: isUsing itself can apparently get stuck at true forever (not just
  "flips false but goes unnoticed," which is what the existing self-heal
  was built to catch) — meaning that self-heal's own trigger condition
  could never fire either. The new check doesn't read isUsing at all: no
  legitimate hold, including a full Storm Slash charge, comes anywhere
  close to 200 ticks, so reaching it is itself the signal to force a
  release, regardless of what isUsing currently reports.

### Investigated

- Investigated further, not resolved: playerSwingStart still not firing
  for a true air-swing (confirmed again on this build). InputButton (the
  only way to poll input state directly, as an alternative to relying on
  the event) only exposes Jump and Sneak per Microsoft's own docs — there
  is no Attack/Use entry to poll instead, so there's no independent way to
  verify or work around this from script. This still looks like current
  engine behavior rather than anything on our end.

---

## [1.8.21]

### Fixed

- Fix: charging while gliding could get permanently stuck (frozen charging
  pose, action bar never clearing) on an early release (before reaching a
  full Storm Slash charge). Root cause: the itemStopUse handler had an
  `if (!event.itemStack) return;` guard that, when event.itemStack came
  back empty (observed specifically on early release while gliding), bailed
  out before ever resetting the wrapper's isUsing flag back to false —
  which is also exactly what silently defeated ChargingState's own
  self-heal check, since that check's trigger condition (isUsing already
  false) could never become true in the first place. Nothing downstream
  ever reads event.itemStack from onStopUsing, so the guard wasn't
  protecting anything — removed it; isUsing now always resets on
  itemStopUse regardless of whether the event carried a valid itemStack.
- Investigated: playerSwingStart firing only on a connecting swing (block
  or entity), never on a genuine swing-at-nothing, per direct testing.
  Confirmed via Microsoft's docs that PlayerSwingEventOptions (the only
  filter this event's subscribe() accepts) only filters by held-item and
  swing source — nothing that could explain a hit-vs-miss difference — so
  this isn't a subscription misconfiguration on our end. Given the API's
  own recent changelog history includes at least one prior fix specifically
  to when this event triggers, this looks like current engine behavior
  (possibly still settling) rather than anything fixable from script.
  Leaving the subscription in place as-is: harmless if it never fires for
  true air-swings, and it'll start working automatically if a future game
  version's behavior changes to match the documented "any swing" intent.

---

## [1.8.20]

### Fixed

- Bug fix: IdleState.onSwing and FastAtkState.onSwing were reacting to
  EVERY playerSwingStart event regardless of event.swingSource. That event
  fires for far more than attacks — per @minecraft/server's own
  EntitySwingSource enum it also covers Build, DropItem, Event, Interact,
  Mine, None, and (critically) UseItem, "sent when the Entity swings as
  part of using an item." Starting to hold right-click to charge fires a
  UseItem-sourced swing at that exact moment, which was racing ahead of the
  normal tick-based isUsing check and hijacking IdleState straight into
  FastAtkState before ChargingState ever got a chance to start —
  leaving the state machine (and whatever tp/fp animation had last been
  triggered) stuck, since neither state was tracking the fact that the
  player was still actually holding right-click. Both onSwing handlers
  now bail unless event.swingSource === mc.EntitySwingSource.Attack.
  Given Storm Slash and the normal charged attack both depend on
  successfully staying in ChargingState for their full hold, this was
  very likely also the root cause of Storm Slash failing to trigger
  reliably while gliding — needs an in-game pass to confirm now that
  charging itself can no longer be hijacked mid-press.

### Investigated

- Verified (but did not change): the fast-attack air-swing trigger itself
  (onSwing -> FastAtkState, playing the animation and shooting the beam
  unconditionally regardless of whether swingDamageNearbyEntities finds
  any target) and the Storm Slash strike-phase steering math (from 1.8.19)
  both read correctly in isolation. If air attacks and/or Storm Slash's
  flight boost are still broken after this fix on a fresh test (not
  following a stuck-charge attempt), that points to a separate issue this
  pass didn't find — needs a precise repro (what state the sword was in
  right before testing) to keep digging.

---

## [1.8.19]

### Added

- Implemented true air attacks: fast-attack swings now trigger from
  mc.world.afterEvents.playerSwingStart, which fires on every swing
  regardless of whether it connects with a block or entity. Previously
  FastAtkState could only be entered from IdleState via onHitEntity/
  onHitBlock, both of which strictly require a connected target — this
  traced back through the addon's own history (found in an old prototype,
  "slasherv2") to confirm the mechanism is real and was simply dropped
  during a later rewrite. Wired as an additional trigger alongside the
  existing hit-based ones, not a replacement — onSwing and onHitEntity/
  onHitBlock firing for the same physical swing is expected and harmless,
  since FastAtkState's requeue flag is a boolean, not a counter.

### Fixed

- Bug fix: Storm Slash's continuous mid-strike steering force was almost
  entirely vertical regardless of where the player was actually looking.
  physics.applyImpulse folds 90% of the entity's current vertical velocity
  back into every impulse it applies (to simulate normal accumulation,
  since Entity.applyKnockback's vertical parameter otherwise just replaces
  it outright) — but applyKnockback's horizontal parameter already behaves
  like a direct steer, so there's no equivalent carry-over on that axis.
  Left alone, vertical velocity compounded every tick of the strike (up to
  20 ticks) while horizontal kept getting reset to a small per-tick value,
  so the dash snowballed into moving almost straight up or down depending
  on pitch instead of boosting toward wherever the player was looking.
  StormSlashStrikeState.createContinuousForce() now cancels that carry-over
  itself so the steering force stays symmetric across all three axes,
  without touching the shared physics.applyImpulse util (which the
  single-shot Dash/Plunge impulses elsewhere may depend on behaving as-is).
- The normal dash (ChargedAtkState) can no longer be triggered while
  gliding. Its own forward impulse was otherwise usable as a free flight
  boost that skipped Storm Slash's dedicated path entirely (which requires
  staying glide-eligible for the whole charge hold). Releasing a full
  charge while gliding without having qualified for Storm Slash now just
  returns to idle instead of falling back to the ground-combat dash mid-air.

---

## [1.8.18]

### Added

- Added Storm Slash, ported from the "v4-1" build (same reimplementation
  approach as 1.8.17's chainsaw hit effects — v4-1's own code couldn't be
  copied verbatim since it's a different item on a different architecture,
  so this is a faithful reimplementation using our own state-machine/config
  conventions, not a literal port of v4-1's compiled script):
  - Hold the charge-attack button while gliding (Elytra deployed) for
    CONFIG.stormSlash.chargeDurationTicks (30 ticks/1.5s — gliding has to
    hold for the *entire* charge, not just at the moment of release, or it
    falls back to the normal charged attack/plunge branch). Releasing while
    still gliding at that point launches a flight dash instead of the usual
    charged attack: a brief windup, then a forward-impulse strike phase that
    steers with view direction, ending either in a clean mid-air finish or
    an impact if something solid gets in the way.
  - New states: StormSlashWindupState, StormSlashStrikeState,
    StormSlashFinishState, StormSlashImpactState, branching off
    ChargingState.onReleaseStormSlash — see the state-machine doc comment
    at the top of slasher.js for how this fits alongside the existing
    charged-attack/plunge branches.
  - The source has no scripted damage anywhere in this move — it's a pure
    traversal/mobility ability (impulses + self-buffs so the forced
    movement can't hurt the user + sound/camera feel), not an attack in the
    damage-dealing sense. Ported as such; nothing here deals damage.
  - Ported the fp windup/strike/impact animations directly from v4-1 —
    current's fp rig has used v4-1's exact bone names since 1.8.15's mesh
    port, so these came across essentially 1:1, unlike the reimplemented
    script logic.
  - v4-1 has no third-person animation for this move at all (fp only, even
    in the source) — ported that way for now, so third-person viewers just
    see whatever the default pose is during the dash. A real tp animation
    for this is a natural follow-up but wasn't in scope here.
  - New charging.stormChargeUiFrames/stormReadyUiFrames actionbar frames:
    once a normal charge completes but the hold continues while gliding,
    the actionbar switches to a storm-specific progress readout, then a
    bold 3-color flash once storm-slash is ready — distinct from the
    normal charge's 2-color flash, since it's a bigger payoff.
  - New sounds: slasher.charged_storm_slash (ready cue),
    storm_slash_windup/strike/impact (+.2d variants), and
    storm_slash_finish/.2d (ported from v4-1's power_slash.ogg, renamed —
    "power slash" isn't a concept that exists in this build, so kept the
    audio but not that name).
  - New utils/vec3.js#dot, used by the strike phase's steering calculation
    (angle between current velocity and view direction).
  - This move's impulses go through our existing physics.applyImpulse
    (the applyKnockback-based replacement for the native, since-removed
    applyImpulse — see utils/physics.js) rather than a raw native call,
    for consistency with how Dash/Plunge already do it. That function has
    different internal scaling than v4-1's native calls did, so the exact
    flight distance/speed numbers here are a starting point, not a verified
    match to the source's feel — genuinely needs an in-game pass.

---

## [1.8.17]

### Added

- Added chainsaw/lock-on hit effects, reimplemented from the "v4-1" build's
  blood-burst concept using our own particle identifiers and namespace
  (v4-1 itself couldn't be copied directly — different item id, different
  architecture entirely):
  - A small blood-burst particle (lc:slasher_chainsaw_hit_emitter) now
    spawns at the target's body location on every tick a chainsaw hit
    actually lands.
  - A bigger burst (lc:slasher_chainsaw_finish_emitter) plays on every
    target when the grab ends, plus — for the first 5 released targets —
    a staggered (1 tick apart) camera shake, critical-hit sound, and
    a quick sparkle particle (lc:slasher_chainsaw_sparkle_emitter), so a
    multi-target release reads as a rapid one-two-three. Purely cosmetic:
    no extra damage was added, only what onTickChainsawing already deals.
  - Added CONFIG.lockonAtk.hitEffect / finishEffect for the particle ids,
    staggered-target cap, and per-target delay.
  - New assets: rp/particles/slasher_chainsaw_{hit,finish,sparkle}.
    particle.json, plus the blood/sparkle textures + PBR companions
    ported from v4-1 into rp/textures/particles/.
  - Added utils/entity.js#getEntityBodyLocation (head/feet midpoint + a
    small upward nudge) for placing these particles at a natural spot on
    the target rather than at its feet-level .location.

---

## [1.8.16]

### Fixed

- Bug fix: the blade/chain never actually spun in any state (attacking,
  charging, beam release, chainsaw hold). Every animation was correctly
  setting v.blade_speed_mod to its intended target speed (this content
  carried over correctly from the v4-1 port), but the attachable's easing
  math was reading a different, never-updated variable (v.blade_speed_a,
  stuck at 0 since initialization). Fixed the attachable to read
  v.blade_speed_mod instead, so the existing smooth lerp-based easing
  (already correctly written) now actually drives the chain, including a
  natural ease down to a stop rather than an abrupt one.
- Bug fix: charged_atk_end (the release-after-full-charge fp animation)
  snapped back to the exact charging-hold pose in its last 1/24s instead
  of continuing its own easing-down motion. Replaced that final keyframe
  (rotation and position) with a value that continues the established
  trend from the preceding frames, removing the reversal.

---

## [1.8.15]

### Changed

- Ported the weapon's visual identity from the earlier "v4-1" build over to
  this codebase: new hilt/blade model and texture (fp + tp), new item icon,
  and the charged-attack beam's model + texture. Gameplay code, the state
  machine, damage/config values, and every existing identifier (item id,
  geometry/animation/controller names, cooldown names) are unchanged — only
  the mesh, texture, and animation CONTENT at those existing slots changed,
  so nothing on the BP side needed to be touched.
  - fp/tp geometry: v4-1's hilt+29-segment sawblade mesh replaces the old
    13-cube hilt + 14-blade mesh, grafted onto the same anchor bones
    (fp_rightarm_g for fp, rightItem for tp) 1.8.14 already used, translated
    to sit at that anchor rather than v4-1's own. v4-1's model has no
    separate "blade extend" or "trigger press" sub-bones the old mesh had,
    so that specific micro-articulation is gone — the rest of the rig is
    unaffected.
  - fp animations: all 17 identifiers now carry v4-1 content. Direct
    matches: pick, general, blade_cycle, fast_atk_1/2 (from
    speed_slash_1/2), charging_start/hold (from charge_1/2), dash
    (from charge_dash), charged_atk_start (from power_slash_start),
    charged_atk_hold/end (from sawing_loop/release — same chainsaw-hold
    concept, matches the chainsaw_loop/finish sounds both builds already
    share). v4-1 never had a plunge attack, a 3rd/4th combo hit, or a
    dash-into-charge variant, so those five (plunge_windup/fall/impact,
    overhead_chop, two_handed_cleave, dash_charged_atk_start) are reusing
    the closest existing v4-1 clip as a placeholder rather than dead/frozen
    — see chat for the exact mapping. These are the ones most likely to
    want a real bespoke animation later.
  - tp animations: untouched. All 13 only ever moved leftArm/rightArm/
    rightItem (the vanilla arm bones), never the weapon's own sub-bones, so
    they keep working unmodified on the new mesh.
  - charged-atk beam: model + texture replaced (v4-1's power_slash_beam).
    The rotation/visibility animation binding (reads lc:rotation_x/y/z and
    lc:is_visible off the entity) is untouched — that's the live aiming
    mechanism, not cosmetic, so it stays wired exactly as it was. No v4-1
    equivalent exists for the fast-atk beam; it's unchanged.
  - Also carried over v4-1's PBR metalness/emissive/roughness maps
    (slasher_mer.png, beam_charged_atk_mer.png + texture_set.json) as
    same-name companions to the new base textures — inert for anyone not
    using deferred/Vibrant Visuals rendering, additive for anyone who is.
  - Left untouched (not part of this request): particle effects, sounds,
    the slasher_blade item/icon, and the fast-atk beam's look.
  - The new mesh's exact position/scale/rotation in-hand is computed from
    the two models' pivot data, not visually verified — it's the one part
    of this port that genuinely needs an in-game look. If anything sits
    offset, rotated wrong on an axis, or mis-scaled, say which and it's a
    quick, precise fix from there.

---

## [1.8.14]

### Changed

- Behavior change: hit 3 (overhead_chop) and hit 4 (two_handed_cleave) can
  now only be queued by an actual left-click swing landing
  (onHitEntity/onHitBlock). Previously, FastAtkState.onStopUsing() queued
  the next combo step on ANY right-click release mid-combo too, with no
  distinction between combo steps — so simply tapping right-click while
  sitting at hit 2 or hit 3 would silently advance into hit 3 or hit 4
  without the player having attacked anything. Added a per-step
  requireAttackInput flag to CONFIG.fastAtk.combo (set on hit 3 and hit 4
  only); onStopUsing() now checks it before queuing. Hit 1 and hit 2 are
  unaffected — both left-click and right-click-release still advance the
  combo into them, exactly as before.

---

## [1.8.13]

### Fixed

- Fixed a bug affecting both tp combo-finisher animations (overhead_chop and
  two_handed_cleave): their final keyframe on every bone had no lerp_mode
  set, which defaults to linear — the exact same "ends on a robotic snap"
  issue that 1.8.12 fixed for the fp versions, but that fix was never
  mirrored to tp. All four bones (body, leftArm, rightArm, rightItem) now
  ease out on catmullrom all the way to the last frame, on both hits.
- Bug fix: the fp overhead_chop and two_handed_cleave animations were
  missing "loop": "hold_on_last_frame" and "blend_weight":
  "v.fp_anim_blend_weight" — every other fp animation in the file sets
  both. Without hold_on_last_frame, and with animation_length sized to
  match the cooldown window exactly (no safety margin, unlike fast_atk_1/2
  which finish well before their cooldown expires), there was a real risk
  of the pose popping back to frame 0 for an instant before the controller
  transitions out. Both fields are now set, consistent with the rest of the
  file.
- Bug fix: the tp overhead_chop and two_handed_cleave animations were
  missing override_previous_animation (every other tp animation sets it to
  true), which could let a chained swing into hit 3 or hit 4 blend from
  whatever pose the prior swing's animation was fading out of instead of
  cleanly overriding it. Added.
- Deepened the anticipation pose on both hits, fp and tp — the windup/hold
  keyframes now pull back further before the strike, with hit 4's pull-back
  bigger than hit 3's so the combo reads as escalating in weight. Timing is
  unchanged; only the pose depth increased.
- Added secondary motion to the fp overhead_chop animation: fp_leftarm and
  fp_head had no keyframes at all and sat fully static through the entire
  swing. Both now get a small keyframed shift through the strike — a
  support-hand brace and a slight head dip — settling back to the ready
  pose by the end. fp_two_handed_cleave already had this on both bones;
  its amplitude has been increased slightly so the finisher reads as a
  bigger flourish than hit 3.
- Retimed tp two_handed_cleave from 1.2s to 1.1s (every keyframe time
  scaled proportionally, so the existing shape of the swing is otherwise
  unchanged) to close most of the gap against its fp counterpart (1.05s) —
  the widest fp/tp mismatch in the combo. tp overhead_chop's fp/tp gap was
  already small (1.0s vs 0.95s) and was left alone.
- None of the above touches fp animation_length or CONFIG.fastAtk.combo
  timing, so cooldownTicks/lifespanTicks in config.js didn't need to
  change.

---

## [1.8.12]

### Fixed

- Bug fix: the fp overhead_chop and two_handed_cleave animations ended
  each swing on a keyframe with no lerp_mode set, which defaults to
  linear — so after several catmullrom-eased keyframes through the
  windup and strike, the final ~0.1-0.2s recovery back to the ready pose
  snapped along a straight line instead of easing out. That's what read
  as fast/unnatural/robotic at the end of the swing.
- Retimed both animations: overhead_chop 0.75s -> 0.95s, two_handed_cleave
  0.85s -> 1.05s. The windup and strike keep their original timing (still
  fast and punchy); the extra time all goes to the recovery, which now
  has an added settle keyframe and catmullrom easing all the way to the
  ready pose instead of a single fast linear snap.
- Synced fastAtk.combo cooldownTicks/lifespanTicks for overhead_chop
  (15->19 / 22->26) and two_handed_cleave (17->21 / 25->29) to match the
  new fp animation lengths.

---

## [1.8.11]

### Fixed

- Bug fix: removed minecraft:digger and the pickaxe/axe/diamond_tier tags
  from the Slasher item. Left-click-on-a-block was being treated as mining
  (hold-to-break, longer reach) instead of a discrete melee swing, which
  interfered with the sword's own hit/beam-triggering logic in some cases.
  Reverted to a pure melee-swing interaction on blocks (matching the
  original v1.0.1 item profile) at the cost of the "can mine like a
  diamond pickaxe/axe" side feature.

---

## [1.8.10]

### Added

- Added a 4-hit fast-attack combo, up from 2. Hit 3 is a heavier overhead
  chop with a real anticipation beat; hit 4 is a two-handed finishing
  cleave on a distinct diagonal swing plane (bigger hitbox and damage
  multiplier than hits 1-2). FastAtkState now tracks a comboIndex driven
  by a new CONFIG.fastAtk.combo table instead of the old binary
  nextAnimIndex — whiffing the follow-up window or getting interrupted
  into a different attack type both reset the combo back to hit 1.
- Bug fix: both the fast-attack and charged-attack beams were dealing no
  damage to mobs in the common case. The beam hit handlers had switched
  from EntityDamageCause.override to .projectile at some point — projectile
  is a "normal" damage cause that respects a target's brief post-hit
  invulnerability window, and since these beams fire in the same instant
  as the melee swing that spawned them (which already applied its own,
  larger hit and started that window), the beam's much smaller damage
  value was getting silently swallowed almost every time. Reverted to
  .override, matching the behavior from 1.0.1.
- Fixed the fast-attack combo cooldown durations, which had been reused
  as both the JS-side "how long to wait for the next chained swing" timer
  AND the RP-side value gating how long the fp animation controller stays
  in that swing's state. Those are two different things — sizing the
  latter to the gameplay combo window (which is deliberately longer than
  the animation itself) left the fp arms frozen in a static held pose for
  up to half a second after the swing animation had already finished
  playing, before the controller would transition out. Split into two
  separate config values (lifespanTicks for gameplay, cooldownTicks for
  the RP animation state) and sized cooldownTicks to actually match each
  fp animation's real length.
- Added blend_transition to the fast_atk_1, fast_atk_2, overhead_chop,
  two_handed_cleave, and pick states in the fp animation controller, so
  entering/exiting the attack chain blends smoothly instead of snapping.
- Retimed and reworked the hit 3 / hit 4 fp animations — both were
  playing faster than their tp counterparts by a wider margin than the
  rest of the combo, which read as rushed. Hit 4 also now swings on a
  visibly different plane from hit 3 (diagonal cross-body vs. overhead)
  instead of being a scaled-up copy of the same motion.

---

## [1.8.8–1.8.9]

*Skipped releases.*

---

## [1.8.7]

### Added

- Added localization support for eight new languages:
  - Spanish (`es_ES`)
  - French (`fr_FR`)
  - German (`de_DE`)
  - Portuguese (Brazil) (`pt_BR`)
  - Russian (`ru_RU`)
  - Simplified Chinese (`zh_CN`)
  - Korean (`ko_KR`)
  - Turkish (`tr_TR`)
- Added translations for:
  - Item display names
  - Entity display names
  - Repair-needed warning text

### Changed

- Updated `texts/languages.json` to register all ten bundled languages:
  - `en_US`
  - `ja_JP`
  - `es_ES`
  - `fr_FR`
  - `de_DE`
  - `pt_BR`
  - `ru_RU`
  - `zh_CN`
  - `ko_KR`
  - `tr_TR`

---

## [1.8.6]

### Documentation

- Added explanatory comments to both `triggerEvent("lc:on_getting_chainsawed")` call sites.
- Documented that the event is intentionally left inert as a stable extension point for custom entities.
- Clarified that first-party or third-party entities may define the event themselves without requiring any script changes in this add-on.
- No gameplay or behavioral changes.

---

## [1.8.5]

### Changed

- Removed `isEntityDead()` from `utils/entity.js`.
- The helper had no remaining call sites anywhere in the codebase, as all active dead-target checks already perform their own inline health validation.

### Notes

- Documented the currently unused `lc:on_getting_chainsawed` entity event.
- The event is intentionally retained because it may serve as an interoperability hook for third-party entities.
- Flagged as documentation only in case it was originally intended to drive behavior within this add-on.

---

## [1.8.4]

### Fixed

- Fixed the resistance-piercing critical strike requiring Sharpness V, Bane of Arthropods V, or Smite V to be the weapon's only enchantment.
- The interaction now activates whenever any one of the qualifying enchantments is present at level V, regardless of any additional enchantments such as Mending, Fire Aspect, or Unbreaking.
- Fixed Breach armor reduction ignoring `enchantScaling.breachArmorReductionPerLevel`.
- Breach now correctly reads its configurable armor reduction value instead of using a hardcoded constant.
- Fixed swallowed registration errors inside the item extender framework.
- Removed a `return` inside a `finally` block that previously suppressed exceptions thrown from `onCreate()`.
- Registration now continues safely while correctly logging errors.
- Kept Behavior Pack and Resource Pack manifest versions synchronized.
- Kept the BP → RP dependency version synchronized after drifting since 1.8.3.

### Changed

- Removed the unused `physics.gravityPerTick` configuration value.
- Added a dedicated configuration value for chainsaw Wither duration:
  - `lockonAtk.escalation.witherDurationTicks`
- Removed a duplicate code comment above the base Slasher state class.

---

## [1.8.3]

### Fixed

- Fixed the resistance-piercing critical strike introduced in 1.8.2.
- A string comparison bug caused enchantment identifiers such as:
  - `minecraft:sharpness`
  - `minecraft:smite`
  - `minecraft:bane_of_arthropods`
  to be compared against un-namespaced identifiers, preventing the interaction from ever activating.
- The resistance-piercing critical strike now functions correctly again.

---

## [1.8.2]

### Changed

- Migrated from the stable `@minecraft/server` 1.x API to the stable 2.x API.
- Updated every affected API call throughout the project, including:
  - `isValid()` method → `isValid` property
  - `applyKnockback()` separate direction and strength parameters → single force vector
  - `GameMode` enum casing (lowercase → PascalCase)
  - `worldInitialize` event → `worldLoad`
- Verified that knockback behavior remains functionally equivalent after migration.
- Performed general code cleanup and maintenance throughout the codebase.

### Fixed

- Fixed several enchantment interaction issues introduced during the migration.
- Fixed damage and effect ordering across multiple attack types.
- Fixed recipe definitions using the invalid `"amount"` result field.
- Updated recipes to correctly use the `"count"` field.

---

## [1.8.1]

### Performance

- Optimized the Mending Overcharge system by splitting its update logic into two independent cadences.
- The visible Regeneration effect continues to refresh every second.
- The expensive full-inventory scan now executes once every five seconds, with results cached between scans.
- The cache is immediately invalidated whenever a player equips a Slasher, ensuring the common case of actively wielding the weapon remains responsive without waiting for the slower scan interval.

### Added

- Added a dedicated "woosh" sound effect for the Charged Attack beam while in flight.
- Reused a previously reserved but unused sound asset.
- Deliberately excluded the Fast Attack beams from using the same sound, as testing showed three simultaneous looping sounds became noisy rather than impactful.
- Re-enabling the sound for Fast Attack beams remains a simple one-line change if desired.

### Fixed

- Added the missing `texts/languages.json` file to the Resource Pack.
- This file registers every available `.lang` localization file and was previously absent, resulting in an incomplete Resource Pack.

---

## [1.8.0]

### Added

- Added a Slasher kill leaderboard (`scripts/slasher/leaderboard.js`).
- Kill tracking is backed by a standard Minecraft scoreboard objective, allowing server owners to display or query statistics using vanilla commands without requiring addon-specific UI.
- Added configurable leaderboard settings:
  - `leaderboard.objectiveId`
  - `leaderboard.objectiveDisplayName`
  - `leaderboard.killCreditWindowTicks`
- Kill attribution is performed using the player's name rather than a live `Player` reference, ensuring kills are still credited even if the player disconnects between their final hit and the target's death.

### Changed

- Completely reworked the Plunge Attack ground-pound blast radius calculation.
- Replaced the previous linear formula, which was capped at 11 blocks regardless of fall distance.
- Introduced a configurable tiered radius system using `plungeImpact.hitRadius`.
- The blast radius now:
  - Starts at a 12-block base radius.
  - Scales with fall depth.
  - Can reach up to 40 blocks.
- This represents a deliberate gameplay rebalance rather than a minor numerical adjustment.

---

## [1.7.8]

### Changed

- Replaced hardcoded armor and armor toughness lookup tables with the engine's live equipment data.
- Improves compatibility with custom and third-party armor implementations without requiring explicit support inside the add-on.

---

## [1.7.7]

### Fixed

- Fixed the Charged Attack and both beam direct-hit attacks unintentionally bypassing the Resistance effect.
- These attacks previously used `EntityDamageCause.override`, causing Minecraft to ignore Resistance at the engine level regardless of whether the Slasher possessed the resistance-piercing enchantment.
- Replaced the damage causes with:
  - `EntityDamageCause.entityAttack` for melee attacks.
  - `EntityDamageCause.projectile` for beam attacks.
- Resistance is now bypassed only when the add-on's intended enchantment-gated resistance-piercing logic explicitly allows it.

---

## [1.7.6]

### Changed

- Removed the hardcoded SCP: Dystopia compatibility exclusions from Charged Attack and Lock-on target filtering.
- Removed:
  - `scpdy_ignore_slasher_slash`
  - `scpdy_ignore_slasher_capture`
  - Related exclusion tags
  - `scp096`
  - `scp682`

### Fixed

- Guarded the Lock-on exclusion tag check with a `length > 0` validation before calling `entity.matches({ tags: [...] })`.
- Prevents relying on undefined engine behavior when evaluating an empty tag array after removing the default SCP: Dystopia exclusions.

---

## [1.7.5]

### Added

- Added the Lock-on Chainsaw damage escalation system.
- Damage scaling now increases every 50 hearts of cumulative damage dealt to the grabbed target.
- Damage scaling has no upper limit.
- Added configurable escalation settings through `CONFIG.lockonAtk.escalation`.
- Added escalation milestones:
  - At 75 hearts dealt:
    - Applies Wither to the target.
    - Grants Regeneration to the user.
  - At 100 hearts dealt:
    - Completely suppresses target healing.
    - Prevents:
      - Natural regeneration.
      - Regeneration status effect.
      - Instant Health effects.

### Changed

- Performed a documentation quality pass on `vec3.js` and `entity.js`.
- Replaced historical comments such as:
  - "previously..."
  - "BUGFIX:..."
- Comments now describe current implementation behavior instead of documenting development history.

---

## [1.7.0]

### Fixed

A comprehensive round of fixes resulting from an external code audit. These improvements were implemented across several internal development saves before being released together.

- Fixed the Resource Pack manifest dependency version referencing an outdated Behavior Pack version.
- Added the same minimum 1-damage floor already used elsewhere to:
  - Charged beam direct hits.
  - Charged melee attacks.
- Prevents heavily armored or Protection-stacked targets from receiving zero damage.
- Fixed an edge case in `vec3.js::getRelativeToHead()`.
- Looking almost straight upward or downward previously caused the calculated right vector to collapse to zero, resulting in the Fast Attack beam fan collapsing into a single beam.
- Corrected a copy-paste error in the first-person animation controller.
- Charged Attack states previously routed both Fast Attack cooldown states to `fast_atk_2`.
- Animation routing now alternates correctly between:
  - `fast_atk_1`
  - `fast_atk_2`
- Commented out the unused `slasher_charging_cancel` cooldown reference inside the Resource Pack animation controller.
- Added explanatory documentation noting that no script currently sets this cooldown state.

---

## [1.6.0]

### Changed

- Performed general code enhancements and maintenance.
- Applied additional internal code patching and cleanup to improve long-term maintainability.

---

## [1.5.0]

### Added

- Added new gameplay features and functionality.

---

## [1.4.0]

### Changed

- Performed gameplay balance adjustments.

### Fixed

- Fixed various bugs throughout the add-on.

---

## [1.3.0]

### Changed

- Improved overall code quality.
- Applied additional internal code patching and maintenance.

---

## [1.2.0]

### Changed

- Performed general code enhancements and maintenance.

### Fixed

- Fixed various bugs throughout the project.

---

## [1.1.0]

### Added

- Added additional gameplay features.
- Performed gameplay balance improvements.

---

## [1.0.7]

### Changed

- Introduced `BASE_DAMAGE` in `config.js` as the single source of truth for all primary weapon damage values.
- Fast Attack, Charged Attack, and both beam direct-hit attacks are now defined as explicit multipliers of `BASE_DAMAGE` rather than independent hardcoded values.
- This ensures the weapon's displayed attack damage and its actual damage output remain synchronized whenever balancing changes are made.

- Reworked beam enchantment handling.
- Previously, beams queried the shooter's currently equipped weapon when the beam collided with its target.
- This caused enchantment bonuses such as Sharpness and resistance-piercing to be lost if the player:
  - Switched items.
  - Died.
  - Logged out.
  while the beam was still in flight.
- Beams now snapshot all required combat information onto the projectile when fired, including:
  - Owner name.
  - Sharpness bonus.
  - Resistance-piercing state.
- Beam damage therefore remains consistent regardless of changes to the shooter's inventory or session after firing.

- Reworked the Plunge Attack's fall acceleration.
- Added a distance-based downward impulse that applies additional acceleration every configurable distance fallen.
- Long falls now continue accelerating instead of naturally leveling off.

- Removed the Plunge Attack damage cap.
- Damage now scales without an upper limit, mirroring the behavior of the vanilla Mace.

### Notes

- Known issue introduced or still present at this point:
  - The Resource Pack manifest dependency remained pinned to the previous Behavior Pack version instead of tracking the current release.
  - This issue was corrected in **1.7.0**.

---

## [1.0.6]

### Added

- Added `enchant_interactions.js`.
- Introduced Fire Aspect interaction:
  - Applies Slowness to affected targets.
- Introduced Mending Overcharge:
  - Periodically grants Regeneration while a Slasher enchanted with Mending exists in the player's inventory.
- Integrated enchantment interactions into:
  - Fast Attack.
  - Charged Attack.
  - Lock-on Chainsaw Attack.
  - Plunge Attack.

### Changed

- Performed a major gameplay and economy rebalance.

- Increased maximum durability:
  - **900 → 7500**

- Added enchantability.
- The weapon can now receive enchantments through normal enchanting mechanics.

- Added digger and pickaxe-tier tags.
- The Slasher can now mine blocks with functionality comparable to a Diamond Pickaxe.

- Expanded repair materials.
- Previously only a single repair item with a flat repair value existed.
- Added support for:
  - Netherite Ingot
  - Netherite Block
  - Netherite Scrap
  - Ancient Debris
  - Mace
  - Netherite Sword

- Completely redesigned both crafting recipes.

**Slasher Blade**
- Previous recipe:
  - Iron Ingot
  - Coal
  - Slime Ball
- New recipe:
  - Iron Block
  - Netherite Block
  - Slime Ball
  - Chain
- Crafting output reduced:
  - **2 → 1**

**Slasher**
- New crafting recipe requires:
  - Nether Star
  - Netherite Ingot
  - Mace
  - Netherite Sword
  - Four Slasher Blades

---

## [1.0.5]

### Added

- Linked the Behavior Pack and Resource Pack through manifest dependencies.
- Installing either pack now automatically requires the other.
- Exposed additional gameplay settings through the configuration system, including:
  - Attack cooldowns.
  - Plunge Attack damage range.

### Changed

- Completely reworked Charged Attack landing protection.
- Replaced the previous fixed-duration Resistance calculation with a dynamic airtime tracking system.
- Correctly handles:
  - Cliff dashes.
  - Chained dashes.
  - Variable airtime.
- Prevents fall damage consistently regardless of dash duration.

---

## [1.0.4]

### Changed

- Wrapped every Item Extender framework event handler with `safeInvoke`.
- Covered handlers include:
  - `itemStartUse`
  - `itemStopUse`
  - `entityHitEntity`
  - `entityHitBlock`
  - `entityDie` cleanup
  - `playerLeave` cleanup
  - Per-player tick loop
- Unhandled exceptions are now safely logged rather than silently terminating event execution or disrupting the update loop.

- Replaced `patches/player.js`, which extended `mc.Player.prototype` with custom methods, with a standalone `utils/physics.js` module exposing equivalent functionality through regular functions.
- Eliminated direct modification of SDK prototypes, reducing compatibility risks with:
  - Other add-ons.
  - Future Minecraft API updates introducing methods with identical names.

---

## [1.0.3]

### Added

- Introduced `config.js` as the central configuration file for gameplay tuning.
- Centralized configurable values including:
  - Damage values.
  - Dash impulse strength.
  - Movement values.
  - State durations.
  - Status effect amplifiers.
  - Effect durations.
- Migrated Density and Breach enchantment scaling into the configuration system, matching the vanilla Mace's enchantment behavior.
- Moved Charged Beam statistics from hardcoded values inside `beam.js` into configurable settings.

- Added Breach-style armor piercing to `calculateFinalDamage()`.
- Effective armor is reduced by **15% per enchantment level** before the standard armor and armor toughness calculations execute.
- Integrated Breach armor piercing into:
  - Fast Attack.
  - Both beam attacks.

- Added the initial implementation of post-dash landing protection.
- Applies Resistance while airborne following a Charged Attack dash.
- Resistance duration was originally calculated from the dash's initial upward impulse.
- This implementation was later replaced in **1.0.5** after edge cases involving cliff dashes and chained dashes were identified.

### Fixed

- Fixed Fast Attack beam direct-hit damage bypassing armor.
- Previously, direct beam damage called `entity.applyDamage()` directly, ignoring armor entirely.
- Damage now passes through `calculateFinalDamage()`, making armor mitigation consistent across every attack type.

---

## [1.0.2]

### Changed

- Merged `item_extender.js` and `profile_registry.js` into a single file.
- Every consumer already imported both files together, making the separation unnecessary while adding additional indirection.

- Consolidated repeated attack validation into a shared `canBeAttacked()` helper inside `entity.js`.
- Centralized checks include:
  - PvP status.
  - Creative mode immunity.
  - Spectator mode immunity.
- Replaced duplicated validation logic across:
  - Fast Attack.
  - Charged Attack.
  - Plunge Attack.
  - Both beam damage paths.

- Added `hasLineOfSightFromAny()`.
- Unified several duplicated raycast implementations previously shared between Charged Attack and Plunge Attack logic.

- Removed a substantial amount of unused vector mathematics functionality from `vec3.js`, including:
  - `ONE`
  - `HALF`
  - `LEFT`
  - `RIGHT`
  - `BACKWARD`
  - `isVector3`
  - `divide`
  - `sqrDistance`
  - `lerp`
  - `reflect`
  - Public `dot`
  - Public `cross`
  - `sqrLength`
  - `angle`
  - `generateVectorsOnCircle`
  - `random`
  - `randomDirection`
  - `randomLocationInSphere`
  - `rotateDeg`
  - `rotateRad`
  - `getRelativeLocation`
  - `floor`
  - `ceil`
  - `round`
  - Vector-overloaded `clamp`
- None of these utilities were referenced anywhere else within the add-on.

### Fixed

- Fixed corruption of the shared vanilla armor lookup table.
- `calculateFinalDamage()` previously executed:
  `Object.assign(VANILLA_ARMOR_VALUES, customArmorValues)`
- This permanently modified the shared vanilla armor data whenever custom armor overrides were used.
- The implementation now spreads values into a fresh object, preventing damage calculations for unrelated entities from becoming corrupted.

- Fixed duplicated line-of-sight logic using inconsistent ray origins.
- One implementation constructed the second ray's direction vector from a different origin than the ray itself.
- `hasLineOfSightFromAny()` now computes both ray origin and direction consistently, resolving the issue.

---

## [1.0.1] *(Legacy)*

> [!NOTE]
> This release belongs to the original **Slasher v1** repository.
>
> **Source:** https://github.com/lc-studios-mc/slasher-v1/

### Fixed

- Fixed the Lock-on Chainsaw Attack incorrectly detecting whether the player was sneaking.
- The original implementation only checked the raw sneak input state, causing the attack to fail whenever the player was sneaking without the input button actively reporting as pressed.
- This could cause:
  - The Lock-on Chainsaw Attack to silently fail to trigger.
  - The Lock-on Chainsaw Attack to fail to release correctly after activation.
- Introduced an `isSneaking()` helper that also checks the player's actual `isSneaking` property as a fallback.
- Updated both the trigger and release logic to use the new helper, ensuring sneak detection behaves consistently.

---

## [1.0.0] *(Legacy)*

> [!NOTE]
> This release belongs to the original **Slasher v1** repository.
>
> **Source:** https://github.com/lc-studios-mc/slasher-v1/

### Added

- Initial public release.

### Features

- Added the **Slasher Blade** crafting component.
- Added the **Slasher** weapon.
- Added the Slasher upgrade crafting recipe.
- Added the **Fast Attack** combo system.
- Added the **Charged Attack**, consisting of:
  - Dash attack.
  - Beam attack.
- Added the **Lock-on Chainsaw Attack**.
- Added the **Plunge Attack** (ground-pound attack).
- Added custom:
  - Sounds.
  - Particles.
  - Animations.
