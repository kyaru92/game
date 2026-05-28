
import type { BeforeItemActivationEventData, Target } from "../types";
import type { World } from "../world";
import { describeTarget, displayItemName } from "../utils";
import { validateTarget } from "./targeting";

export class ActivationSystem {
  constructor(private readonly world: World) {}

  startUse(actorId: string, inventoryIndex: number, target: Target): void {
    const itemId = this.world.services.inventory.itemAt(actorId, inventoryIndex);
    if (!itemId) {
      this.world.log(`背包索引不存在：${inventoryIndex}`);
      return;
    }
    this.startUseItem(actorId, itemId, target);
  }

  startUseItem(actorId: string, itemId: string, target: Target): void {
    const actor = this.world.entities[actorId];
    if (!actor) {
      this.world.log(`找不到使用者：${actorId}`);
      return;
    }
    const casting = actor.components.casting;
    if (casting) {
      const remaining = Math.max(0, casting.finishAtMs - this.world.nowMs());
      this.world.log(`正在使用 ${casting.itemName}，还需 ${Math.ceil(remaining)}ms。`);
      return;
    }

    const inventoryIndex = this.world.services.inventory.indexOf(actorId, itemId);
    const item = this.world.items[itemId];
    if (!item || inventoryIndex < 0) {
      this.world.log(`物品不在背包中：${itemId}`);
      return;
    }

    const activation = item.components.activation;
    if (!activation) {
      this.world.log(`${displayItemName(item)} 没有 activation 组件，无法使用。`);
      return;
    }

    const now = this.world.nowMs();
    const cooldownUntil = Number(activation._cooldownUntilMs ?? 0);
    if (cooldownUntil > now) {
      this.world.log(`${displayItemName(item)} 冷却中，还需 ${Math.ceil(cooldownUntil - now)}ms。`);
      return;
    }
    if (activation.consumeCharge !== false && Number(activation.charges ?? 0) <= 0) {
      this.world.log(`${displayItemName(item)} 已无可用次数。`);
      return;
    }

    const error = validateTarget(this.world, item, target, actorId);
    if (error) {
      this.world.log(error);
      return;
    }

    const castMs = Number(activation.castDurationMs ?? 0);
    if (castMs <= 0) {
      this.completeActivation(actorId, item.instanceId, target);
      return;
    }

    actor.components.casting = {
      itemId: item.instanceId,
      itemName: displayItemName(item),
      startedAtMs: now,
      finishAtMs: now + castMs,
      target,
    };
    this.world.log(`开始使用 ${displayItemName(item)} -> ${describeTarget(this.world, target)}，需要 ${castMs}ms。`);
  }

  update(): void {
    const now = this.world.nowMs();
    for (const [actorId, actor] of Object.entries(this.world.entities)) {
      const casting = actor.components.casting;
      if (!casting || casting.finishAtMs > now) continue;
      delete actor.components.casting;
      this.completeActivation(actorId, String(casting.itemId ?? ""), casting.target);
    }
  }

  completeActivation(actorId: string, itemId: string, target: Target): void {
    const inventory = this.world.services.inventory.get(actorId);
    const inventoryIndex = inventory.indexOf(itemId);
    const item = this.world.items[itemId];
    if (!item || inventoryIndex < 0) {
      this.world.log("激活失败：物品已经不在背包中。");
      return;
    }

    const activation = item.components.activation;
    if (!activation || (activation.consumeCharge !== false && Number(activation.charges ?? 0) <= 0)) {
      this.world.log(`激活失败：${displayItemName(item)} 已不可用。`);
      return;
    }

    const beforeData: BeforeItemActivationEventData = {
      actorId,
      itemId: item.instanceId,
      inventoryIndex,
      target,
    };
    this.world.bus.emit("BeforeItemActivation", beforeData);
    if (beforeData.cancelReason) {
      this.world.log(String(beforeData.cancelReason));
      return;
    }

    this.world.log(`${displayItemName(item)} 激活成功。`);
    this.world.bus.emit("OnItemActivation", {
      actorId,
      itemId: item.instanceId,
      inventoryIndex,
      target,
    });

    if (activation.consumeCharge !== false) {
      activation.charges = Number(activation.charges ?? 1) - 1;
      if (activation.consumeWhenDepleted && activation.charges <= 0) {
        const itemName = displayItemName(item);
        this.world.services.inventory.removeItem(actorId, item.instanceId);
        this.world.log(`${itemName} 已耗尽并被移除。`);
      }
    }
    if (this.world.items[item.instanceId]) activation._cooldownUntilMs = this.world.nowMs() + Number(activation.cooldownMs ?? 0);
  }

  cancel(actorId: string): void {
    const actor = this.world.entities[actorId];
    const casting = actor?.components.casting;
    if (!casting) {
      this.world.log("当前没有正在使用的物品。");
      return;
    }
    delete actor.components.casting;
    this.world.log(`已取消使用 ${casting.itemName}。`);
  }
}
