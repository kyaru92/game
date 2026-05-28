
import type { EventData, ItemInstance, JsonObj, Target } from "../types";
import type { World } from "../world";
import { displayItemName } from "../utils";
import {
  acceptsAmmo,
  consumeItemQuantity,
  itemQuantity,
  magazineRounds,
  magazineSize,
  makeAmmoRound,
} from "./ammo";
import { buildFirearmProjectilePayload, launchProjectile } from "./projectiles";

export class FirearmSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("BeforeItemActivation", (event) => this.onBeforeItemActivation(event));
    world.bus.subscribe("OnItemActivation", (event) => this.onItemActivation(event));
  }

  reload(actorId: string, inventoryIndex: number): void {
    const itemId = this.world.inventory(actorId)[inventoryIndex];
    if (!itemId) {
      this.world.log(`背包索引不存在：${inventoryIndex}`);
      return;
    }
    this.reloadItem(actorId, itemId);
  }

  reloadItem(actorId: string, itemId: string): void {
    const item = this.world.items[itemId];
    if (!item || !this.world.inventory(actorId).includes(itemId)) {
      this.world.log(`物品不在背包中：${itemId}`);
      return;
    }
    if (!item.components.firearm) {
      this.world.log(`${displayItemName(item)} 不是枪械。`);
      return;
    }
    this.startReload(actorId, item, true);
  }

  update(): void {
    const now = this.world.nowMs();
    for (const item of Object.values(this.world.items)) {
      const firearm = item.components.firearm;
      if (!firearm || !firearm._reloadFinishAtMs || Number(firearm._reloadFinishAtMs) > now) continue;
      this.finishReload(item);
    }
  }

  private onBeforeItemActivation(event: EventData): void {
    const item = this.world.items[event.data.itemId];
    const firearm = item?.components.firearm;
    if (!item || !firearm) return;

    const now = this.world.nowMs();
    const reloadFinishAt = Number(firearm._reloadFinishAtMs ?? 0);
    if (reloadFinishAt > now) {
      event.data.cancelReason = `${displayItemName(item)} 正在装填，还需 ${Math.ceil(reloadFinishAt - now)}ms。`;
      return;
    }

    if (magazineRounds(firearm).length > 0) return;
    const started = this.startReload(String(event.data.actorId), item, false);
    event.data.cancelReason = started
      ? `${displayItemName(item)} 弹匣为空，开始装填。`
      : `${displayItemName(item)} 弹匣为空，且背包里没有可用弹药。`;
  }

  private onItemActivation(event: EventData): void {
    const item = this.world.items[event.data.itemId];
    const firearm = item?.components.firearm;
    if (!item || !firearm) return;

    const round = magazineRounds(firearm).shift();
    if (!round) {
      this.world.log(`${displayItemName(item)} 弹匣为空。`);
      return;
    }

    const launched = launchProjectile(this.world, {
      sourceEntityId: String(event.data.actorId),
      sourceItemId: item.instanceId,
      target: event.data.target as Target,
      displayName: `${displayItemName(item)} / ${round.displayName ?? round.ammoProtoId ?? "子弹"}`,
      color: String(firearm.projectileColor ?? round.projectile?.color ?? "#facc15"),
      glyph: String(firearm.projectileGlyph ?? round.projectile?.glyph ?? "•"),
      radius: Number(firearm.projectileRadius ?? round.projectile?.radius ?? 0.07),
      payload: buildFirearmProjectilePayload(firearm, round),
    });
    if (!launched) return;
    this.world.log(`${this.world.entityName(String(event.data.actorId))} 使用 ${displayItemName(item)} 发射 ${round.displayName ?? "子弹"}，弹匣剩余 ${magazineRounds(firearm).length}/${magazineSize(firearm)}。`);
  }

  private startReload(actorId: string, item: ItemInstance, announce: boolean): boolean {
    const firearm = item.components.firearm;
    if (!firearm) return false;
    const loaded = magazineRounds(firearm).length;
    const capacity = magazineSize(firearm);
    if (loaded >= capacity) {
      if (announce) this.world.log(`${displayItemName(item)} 弹匣已满。`);
      return false;
    }
    if (!this.availableAmmoCount(actorId, firearm, item.instanceId)) {
      if (announce) this.world.log(`${displayItemName(item)} 没有可装填的弹药。`);
      return false;
    }

    const reloadMs = Math.max(0, Number(firearm.reloadDurationMs ?? 0));
    firearm._reloadOwnerId = actorId;
    if (reloadMs <= 0) {
      this.finishReload(item);
      return true;
    }
    firearm._reloadFinishAtMs = this.world.nowMs() + reloadMs;
    if (announce) this.world.log(`${displayItemName(item)} 开始装填，需要 ${reloadMs}ms。`);
    return true;
  }

  private finishReload(item: ItemInstance): void {
    const firearm = item.components.firearm;
    if (!firearm) return;
    const ownerId = String(firearm._reloadOwnerId ?? "player");
    const capacity = magazineSize(firearm);
    const needed = Math.max(0, capacity - magazineRounds(firearm).length);
    const rounds = this.takeAmmoRounds(ownerId, firearm, item.instanceId, needed);
    delete firearm._reloadFinishAtMs;
    delete firearm._reloadOwnerId;
    if (!rounds.length) {
      this.world.log(`${displayItemName(item)} 装填失败：没有可用弹药。`);
      return;
    }
    magazineRounds(firearm).push(...rounds);
    this.world.log(`${displayItemName(item)} 装填 ${rounds.length} 发，弹匣 ${magazineRounds(firearm).length}/${capacity}。`);
  }

  private availableAmmoCount(ownerId: string, firearm: JsonObj, firearmItemId: string): number {
    let count = 0;
    for (const itemId of this.world.inventory(ownerId)) {
      if (itemId === firearmItemId) continue;
      const item = this.world.items[itemId];
      if (!item?.components.ammo || !acceptsAmmo(firearm, item.components.ammo)) continue;
      count += itemQuantity(item);
    }
    return count;
  }

  private takeAmmoRounds(ownerId: string, firearm: JsonObj, firearmItemId: string, count: number): JsonObj[] {
    const rounds: JsonObj[] = [];
    const inventory = this.world.inventory(ownerId);
    for (const itemId of [...inventory]) {
      if (rounds.length >= count || itemId === firearmItemId) continue;
      const item = this.world.items[itemId];
      if (!item?.components.ammo || !acceptsAmmo(firearm, item.components.ammo)) continue;
      const quantity = itemQuantity(item);
      const take = Math.min(quantity, count - rounds.length);
      for (let index = 0; index < take; index += 1) rounds.push(makeAmmoRound(item));
      consumeItemQuantity(this.world, ownerId, item, take);
    }
    return rounds;
  }
}
