
import type { EventData } from "../types";
import type { World } from "../world";
import { displayItemName, normalizeArray } from "../utils";
import { resolveAreaTargets, resolveEffectTarget } from "./targeting";

export class DamageApplierSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("OnItemActivation", (event) => this.onItemActivation(event));
  }

  private onItemActivation(event: EventData): void {
    const item = this.world.items[event.data.itemId];
    if (item.components.projectile_launcher || item.components.firearm) return;
    const appliers = normalizeArray(item.components.damage_applier);
    for (const applier of appliers) {
      const amount = Number(applier.amount ?? applier.damage ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        this.world.log(`${displayItemName(item)} 的 damage_applier 缺少有效 amount。`);
        continue;
      }

      const damageType = String(applier.damageType ?? "generic");
      const radius = Number(applier.radius ?? applier.areaRadius ?? 0);
      if (radius > 0) {
        const targets = resolveAreaTargets(this.world, event.data.target, radius);
        if (!targets.length) {
          this.world.log(`${displayItemName(item)} 的范围伤害没有命中目标。`);
          continue;
        }
        for (const targetEntityId of targets) this.world.applyDamage(targetEntityId, amount, damageType, displayItemName(item));
        continue;
      }

      const targetMode = String(applier.target ?? "activation_target");
      const target = resolveEffectTarget(this.world, targetMode, String(event.data.actorId), event.data.target);
      if (target.kind !== "entity" || !target.entityId) {
        this.world.log(`${displayItemName(item)} 需要实体伤害目标。`);
        continue;
      }
      this.world.applyDamage(target.entityId, amount, damageType, displayItemName(item));
    }
  }
}
