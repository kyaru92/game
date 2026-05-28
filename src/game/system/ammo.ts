import type { AmmoComponent, AmmoRound, FirearmComponent, ProjectileConfig } from "../../domain/componentTypes";
import type { ItemInstance } from "../types";
import type { World } from "../world";
import { displayItemName } from "../utils";
import { cloneOptional } from "./common";

export function magazineRounds(firearm: FirearmComponent): AmmoRound[] {
  firearm.loadedRounds ??= [];
  return firearm.loadedRounds;
}

export function magazineSize(firearm: FirearmComponent): number {
  return firearm.magazineSize;
}

export function acceptsAmmo(firearm: FirearmComponent, ammo: AmmoComponent): boolean {
  const accepted = firearm.acceptedAmmoTypes.map((value) => value.trim().toLowerCase()).filter(Boolean);
  const ammoType = ammo.ammoType.trim().toLowerCase();
  return accepted.length === 0 || accepted.includes(ammoType);
}

export function makeAmmoRound(item: ItemInstance): AmmoRound {
  const ammo = item.components.ammo;
  if (!ammo) throw new Error(`${displayItemName(item)} 没有 ammo 组件，无法创建弹药运行时对象。`);
  return {
    ammoProtoId: item.protoId,
    displayName: displayItemName(item),
    ammoType: ammo.ammoType,
    damage: ammo.damage ?? 0,
    damageType: ammo.damageType ?? "generic",
    impactRadius: ammo.impactRadius,
    damage_applier: cloneOptional(ammo.damage_applier),
    effect_applier: cloneOptional(ammo.effect_applier),
    projectile: cloneOptional(ammo.projectile) ?? ({} as ProjectileConfig),
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
