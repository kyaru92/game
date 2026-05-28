
import type { ItemInstance, JsonObj } from "../types";
import type { World } from "../world";
import { displayItemName } from "../utils";
import { cloneOptional, stringList } from "./common";

export function magazineRounds(firearm: JsonObj): JsonObj[] {
  firearm.loadedRounds ??= [];
  return firearm.loadedRounds;
}

export function magazineSize(firearm: JsonObj): number {
  return Math.max(1, Number(firearm.magazineSize ?? firearm.capacity ?? 1));
}

export function acceptsAmmo(firearm: JsonObj, ammo: JsonObj): boolean {
  const accepted = stringList(firearm.acceptedAmmoTypes ?? firearm.ammoTypes ?? firearm.ammoType);
  const ammoType = String(ammo.ammoType ?? "").trim().toLowerCase();
  return accepted.length === 0 || accepted.includes(ammoType);
}

export function makeAmmoRound(item: ItemInstance): JsonObj {
  const ammo = item.components.ammo;
  if (!ammo) return { ammoProtoId: item.protoId, displayName: displayItemName(item), ammoType: item.protoId, projectile: {} };
  return {
    ammoProtoId: item.protoId,
    displayName: displayItemName(item),
    ammoType: String(ammo.ammoType ?? item.protoId),
    damage: Number(ammo.damage ?? 0),
    damageType: String(ammo.damageType ?? "generic"),
    areaRadius: ammo.areaRadius,
    impactRadius: ammo.impactRadius,
    damage_applier: cloneOptional(ammo.damage_applier),
    effect_applier: cloneOptional(ammo.effect_applier),
    projectile: cloneOptional(ammo.projectile) ?? {},
  };
}

export function itemQuantity(item: ItemInstance): number {
  return Math.max(1, Number(item.components.stacking?.quantity ?? 1));
}

export function consumeItemQuantity(world: World, ownerId: string, item: ItemInstance, amount: number): void {
  if (amount <= 0) return;
  const stacking = item.components.stacking;
  if (!stacking || Number(stacking.max ?? 1) <= 1) {
    world.services.inventory.removeItem(ownerId, item.instanceId);
    return;
  }
  const remaining = itemQuantity(item) - amount;
  if (remaining > 0) {
    stacking.quantity = remaining;
    return;
  }
  world.services.inventory.removeItem(ownerId, item.instanceId);
}
