
import type { EventData } from "../types";
import type { World } from "../world";
import { describeTarget, normalizeArray } from "../utils";
import { resolveAreaTargets, resolveEffectTarget } from "./targeting";

export class EffectApplierSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("OnItemActivation", (event) => this.onItemActivation(event));
  }

  private onItemActivation(event: EventData<"OnItemActivation">): void {
    const item = this.world.items[event.data.itemId];
    if (item.components.projectile_launcher || item.components.firearm) return;
    const appliers = normalizeArray(item.components.effect_applier);
    for (const applier of appliers) {
      const chance = Number(applier.chance ?? 1);
      if (Math.random() > chance) {
        this.world.log(`效果 ${applier.kind} 未触发。`);
        continue;
      }
      const targetMode = applier.target ?? "activation_target";
      const radius = Number(applier.radius ?? 0);
      if (targetMode === "activation_area" || radius > 0) {
        const targets = resolveAreaTargets(this.world, event.data.target, radius || 2);
        if (!targets.length) {
          this.world.log(`范围效果 ${applier.kind} 没有命中目标。`);
          continue;
        }
        this.world.log(`范围效果 ${applier.kind} 命中 ${targets.length} 个目标。`);
        for (const targetEntityId of targets) {
          this.world.bus.emit("ApplyEffectRequest", {
            effectId: applier.kind,
            targetEntityId,
            sourceEntityId: event.data.actorId,
            sourceItemId: item.instanceId,
            effectOverrides: applier.overrides,
          });
        }
        continue;
      }

      const target = resolveEffectTarget(
        this.world,
        targetMode,
        event.data.actorId,
        event.data.target,
      );
      if (target.kind !== "entity" || !target.entityId) {
        this.world.log(`效果 ${applier.kind} 需要实体目标，但得到 ${describeTarget(this.world, target)}。`);
        continue;
      }
      this.world.bus.emit("ApplyEffectRequest", {
        effectId: applier.kind,
        targetEntityId: target.entityId,
        sourceEntityId: event.data.actorId,
        sourceItemId: item.instanceId,
        effectOverrides: applier.overrides,
      });
    }
  }
}
