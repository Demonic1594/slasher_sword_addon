# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> [!NOTE]
> ## Legacy Releases
> Versions **1.0.0** and **1.0.1** were originally developed in the **Slasher v1** repository before development continued in this repository. 
> 
> **Original repository:** https://github.com/lc-studios-mc/slasher-v1/

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
