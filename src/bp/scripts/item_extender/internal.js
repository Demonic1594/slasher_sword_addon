import * as mc from "@minecraft/server";
import { ITEM_EXTENDER_PROFILE_MAP, ItemExtender } from "./item_extender.js";
import { safeInvoke } from "../utils/safe.js";

/**
 * @typedef {Object} ItemExtenderWrapper
 * @property {{ currentTick: number, isUsing: boolean }} fields
 * @property {ItemExtender} itemExtender
 */

const ITEM_EXTENDER_WRAPPER_MAP =
  /** @type {Map<mc.Player, ItemExtenderWrapper>} */ (new Map());

/**
 *
 * @param {import("./item_extender.js").ItemExtenderProfile} profile
 * @param {mc.ItemStack} initialItemStack
 * @param {mc.Player} user
 * @param {Partial<import("./item_extender.js").ArgsUserRelated>} [userRelated]
 * @returns {ItemExtenderWrapper}
 */
function createAndWrapItemExtender(
  profile,
  initialItemStack,
  user,
  userRelated,
) {
  const userHealth = userRelated?.userHealth ?? user.getComponent("health");
  if (!userHealth)
    throw new Error("Could not get health component of the player.");

  const userEquippable =
    userRelated?.userEquippable ?? user.getComponent("equippable");
  if (!userEquippable)
    throw new Error("Could not get equippable component of the player.");

  const userMainhandSlot =
    userRelated?.userMainhandSlot ??
    userEquippable.getEquipmentSlot(mc.EquipmentSlot.Mainhand);

  const userOffhandSlot =
    userRelated?.userOffhandSlot ??
    userEquippable.getEquipmentSlot(mc.EquipmentSlot.Offhand);

  const fields = /** @type {ItemExtenderWrapper["fields"]} */ ({
    currentTick: 0,
    isUsing: false,
  });

  const itemExtender = profile.create({
    profile,
    user,
    userHealth,
    userEquippable,
    userMainhandSlot,
    userOffhandSlot,
    initialHotbarIndex: user.selectedSlotIndex,
    initialItemStack,
    currentTick: () => fields.currentTick,
    isUsing: () => fields.isUsing,
  });

  // Guarantees the wrapper is still returned (and registered) even if
  // onCreate() throws — but unlike a bare try/finally with the return
  // inside finally, this actually surfaces the error instead of silently
  // discarding it. (A `return` inside `finally` swallows any exception from
  // the `try` block with zero trace — exactly the kind of silent failure
  // safeInvoke exists everywhere else in this addon to prevent.)
  try {
    itemExtender.onCreate();
  } catch (e) {
    console.warn(
      `[ItemExtender] Unhandled error in onCreate() for "${profile.typeId}": ${e?.stack ?? e}`,
    );
  }

  return {
    fields,
    itemExtender,
  };
}

/**
 * @param {mc.Player} user
 * @param {ItemExtenderWrapper} [itemExtWrapper]
 */
function removeItemExtenderWrapperEntry(user, itemExtWrapper) {
  try {
    if (!itemExtWrapper) {
      itemExtWrapper = ITEM_EXTENDER_WRAPPER_MAP.get(user);
      if (!itemExtWrapper) return;
    }
    itemExtWrapper.itemExtender.onRemove();
  } finally {
    ITEM_EXTENDER_WRAPPER_MAP.delete(user);
  }
}

// Loop over all players in the world every single tick
mc.world.afterEvents.worldLoad.subscribe(() => {
  mc.system.runInterval(() => {
    const players = mc.world.getPlayers();
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      safeInvoke(`tick for player "${player?.name}"`, () =>
        onTickPlayer(player),
      );
    }
  }, 1);
});

/**
 * @param {mc.Player} player
 */
function onTickPlayer(player) {
  let itemExtWrapper = ITEM_EXTENDER_WRAPPER_MAP.get(player);

  const health =
    itemExtWrapper?.itemExtender.userHealth ?? player.getComponent("health");
  if (!health) return;

  const equippable =
    itemExtWrapper?.itemExtender.userEquippable ??
    player.getComponent("equippable");
  if (!equippable) return;

  const mainhandSlot = equippable.getEquipmentSlot(mc.EquipmentSlot.Mainhand);

  const itemStack = mainhandSlot.getItem();

  if (!itemStack) {
    removeItemExtenderWrapperEntry(player, itemExtWrapper);
    return;
  }

  const profile = ITEM_EXTENDER_PROFILE_MAP.get(itemStack.typeId);

  if (!profile) {
    removeItemExtenderWrapperEntry(player, itemExtWrapper);
    return;
  }

  if (!itemExtWrapper || !itemExtWrapper.itemExtender.isValid(itemStack)) {
    removeItemExtenderWrapperEntry(player, itemExtWrapper);

    itemExtWrapper = createAndWrapItemExtender(profile, itemStack, player, {
      userHealth: health,
      userEquippable: equippable,
      userMainhandSlot: mainhandSlot,
    });

    ITEM_EXTENDER_WRAPPER_MAP.set(player, itemExtWrapper);
  }

  itemExtWrapper.itemExtender.onTick(itemStack);
  itemExtWrapper.fields.currentTick++;
}

// Detect when an extended item is first used
mc.world.afterEvents.itemStartUse.subscribe((event) => {
  safeInvoke(`itemStartUse for player "${event.source?.name}"`, () => {
    const { itemStack, source } = event;

    const profile = ITEM_EXTENDER_PROFILE_MAP.get(itemStack.typeId);
    if (!profile) return;

    let itemExtWrapper = ITEM_EXTENDER_WRAPPER_MAP.get(source);

    if (!itemExtWrapper || !itemExtWrapper.itemExtender.isValid(itemStack)) {
      removeItemExtenderWrapperEntry(source, itemExtWrapper);
      itemExtWrapper = createAndWrapItemExtender(profile, itemStack, source);
      ITEM_EXTENDER_WRAPPER_MAP.set(source, itemExtWrapper);
    }

    if (!itemExtWrapper.itemExtender.isUsable(event)) return;

    itemExtWrapper.fields.isUsing = true;
    itemExtWrapper.itemExtender.onStartUsing(event);
  });
});

// Detect when a player stopped using an extended item
mc.world.afterEvents.itemStopUse.subscribe((event) => {
  safeInvoke(`itemStopUse for player "${event.source?.name}"`, () => {
    if (!event.itemStack) return;

    const itemExtWrapper = ITEM_EXTENDER_WRAPPER_MAP.get(event.source);

    if (!itemExtWrapper) return;
    if (!itemExtWrapper.fields.isUsing) return;

    itemExtWrapper.fields.isUsing = false;
    itemExtWrapper.itemExtender.onStopUsing(event);
  });
});

// Detect when a player used an extended item to hit an entity
mc.world.afterEvents.entityHitEntity.subscribe(
  (event) => {
    const player = event.damagingEntity;
    if (!(player instanceof mc.Player)) return;

    safeInvoke(`entityHitEntity for player "${player?.name}"`, () => {
      const advancedItemWrapper = ITEM_EXTENDER_WRAPPER_MAP.get(player);

      if (!advancedItemWrapper) return;

      advancedItemWrapper.itemExtender.onHitEntity(event);
    });
  },
  {
    entityTypes: ["minecraft:player"],
  },
);

// Detect when a player used an extended item to hit an block
mc.world.afterEvents.entityHitBlock.subscribe(
  (event) => {
    const player = event.damagingEntity;
    if (!(player instanceof mc.Player)) return;

    safeInvoke(`entityHitBlock for player "${player?.name}"`, () => {
      const advancedItemWrapper = ITEM_EXTENDER_WRAPPER_MAP.get(player);

      if (!advancedItemWrapper) return;

      advancedItemWrapper.itemExtender.onHitBlock(event);
    });
  },
  {
    entityTypes: ["minecraft:player"],
  },
);

// Remove an item extender wrapper entry when a player dies
mc.world.afterEvents.entityDie.subscribe(
  ({ deadEntity }) => {
    if (!(deadEntity instanceof mc.Player)) return;
    safeInvoke(`entityDie cleanup for player "${deadEntity?.name}"`, () =>
      removeItemExtenderWrapperEntry(deadEntity),
    );
  },
  {
    entityTypes: ["minecraft:player"],
  },
);

// Remove an item extender wrapper entry when a player exits the game
mc.world.beforeEvents.playerLeave.subscribe(({ player }) => {
  safeInvoke(`playerLeave cleanup for player "${player?.name}"`, () =>
    removeItemExtenderWrapperEntry(player),
  );
});
