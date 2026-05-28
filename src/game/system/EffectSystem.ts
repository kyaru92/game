import type { ActiveEffectLayer, ActiveEffectRuntime, EffectDefinition, EffectOverride } from "../../domain/componentTypes";
import type { Entity, EventData } from "../types";
import type { World } from "../world";
import { effectColor, formatDuration } from "../utils";
import { applyPeriodicChange, makeActiveEffect, makeLayer, refreshRuntime } from "./effectRuntime";

type EffectBehavior = NonNullable<ActiveEffectRuntime["behavior"]>;

export class EffectSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("ApplyEffectRequest", (event) => this.onApplyEffectRequest(event));
  }

  private onApplyEffectRequest(event: EventData<"ApplyEffectRequest">): void {
    this.applyEffect(
      event.data.effectId,
      event.data.targetEntityId,
      event.data.sourceEntityId,
      event.data.sourceItemId,
      event.data.effectOverrides,
    );
  }

  applyEffect(effectId: string, targetEntityId: string, sourceEntityId?: string, sourceItemId?: string, effectOverrides?: EffectOverride): void {
    const definition = this.world.effects[effectId];
    if (!definition) {
      this.world.log(`未知效果：${effectId}`);
      return;
    }
    const target = this.world.entities[targetEntityId];
    if (!target) {
      this.world.log(`找不到效果目标：${targetEntityId}`);
      return;
    }
    const effects = (target.components.active_effects ??= {});
    const now = this.world.nowMs();
    const durationMs = Number(effectOverrides?.durationMs ?? definition.durationMs);
    const stacking = definition.stacking;
    const behavior = stacking.overlapBehavior;
    const maxStacks = stacking.maxStacks;
    const name = definition.name;
    const existing = effects[effectId];

    if (behavior === "refresh_duration") {
      if (existing) {
        const oldStacks = Number(existing.stacks ?? 1);
        if (oldStacks < maxStacks) {
          existing.stacks = oldStacks + 1;
          this.world.log(`${target.name} 的 ${name} 叠加到 ${existing.stacks} 层。`);
        } else {
          const onMax = stacking.onMax ?? "refresh_duration";
          if (onMax === "reject") {
            this.world.log(`${target.name} 的 ${name} 已达最大层数 ${maxStacks}，新效果被拒绝。`);
            return;
          }
          this.world.log(`${target.name} 的 ${name} 已达最大层数 ${maxStacks}，刷新持续时间。`);
        }
        refreshRuntime(existing, durationMs, now);
        this.world.services.vfx.addBurst(target.entityId, effectColor(effectId));
        return;
      }
      effects[effectId] = makeActiveEffect(definition, behavior, 1, durationMs, now, sourceEntityId, sourceItemId);
      this.world.log(`${target.name} 获得效果：${name} x1，持续 ${formatDuration(durationMs)}。`);
      this.world.services.vfx.addBurst(target.entityId, effectColor(effectId));
      this.world.services.vfx.addFloatingText(target.entityId, name, effectColor(effectId));
      return;
    }

    if (behavior === "independent") {
      if (existing) {
        const layers = (existing.layers ??= []);
        if (layers.length >= maxStacks) {
          const onMax = stacking.onMax ?? "reject";
          if (onMax === "replace_oldest") {
            layers.sort((a: ActiveEffectLayer, b: ActiveEffectLayer) => Number(a.expiresAtMs ?? 1e18) - Number(b.expiresAtMs ?? 1e18));
            layers.shift();
            this.world.log(`${target.name} 的 ${name} 已达最大层数，替换最早过期的一层。`);
          } else {
            this.world.log(`${target.name} 的 ${name} 已达最大层数 ${maxStacks}，新层被拒绝。`);
            return;
          }
        }
        layers.push(makeLayer(definition, durationMs, now));
        existing.stacks = layers.length;
        this.world.log(`${target.name} 的 ${name} 新增独立层，目前 ${layers.length} 层。`);
        this.world.services.vfx.addBurst(target.entityId, effectColor(effectId));
        return;
      }
      effects[effectId] = makeActiveEffect(definition, behavior, 1, durationMs, now, sourceEntityId, sourceItemId);
      this.world.log(`${target.name} 获得效果：${name} x1，持续 ${formatDuration(durationMs)}。`);
      this.world.services.vfx.addBurst(target.entityId, effectColor(effectId));
      this.world.services.vfx.addFloatingText(target.entityId, name, effectColor(effectId));
      return;
    }

    if (existing) {
      const policy = stacking.onOverlap ?? "reject";
      if (policy === "refresh_duration") {
        refreshRuntime(existing, durationMs, now);
        this.world.log(`${target.name} 已有 ${name}，刷新持续时间。`);
      } else if (policy === "replace") {
        effects[effectId] = makeActiveEffect(definition, "none", 1, durationMs, now, sourceEntityId, sourceItemId);
        this.world.log(`${target.name} 已有 ${name}，被新效果替换。`);
      } else {
        this.world.log(`${target.name} 已有 ${name}，存续期间不允许再次施加。`);
      }
      this.world.services.vfx.addBurst(target.entityId, effectColor(effectId));
      return;
    }

    effects[effectId] = makeActiveEffect(definition, "none", 1, durationMs, now, sourceEntityId, sourceItemId);
    this.world.log(`${target.name} 获得效果：${name}，持续 ${formatDuration(durationMs)}。`);
    this.world.services.vfx.addBurst(target.entityId, effectColor(effectId));
    this.world.services.vfx.addFloatingText(target.entityId, name, effectColor(effectId));
  }

  update(): void {
    const now = this.world.nowMs();
    for (const entity of Object.values(this.world.entities)) {
      const effects = entity.components.active_effects ?? {};
      for (const effectId of Object.keys(effects)) {
        const active = effects[effectId];
        const definition = this.world.effects[effectId];
        if (!definition) continue;
        if (active.behavior === "independent") this.updateIndependent(entity, effectId, active, definition, now);
        else this.updateSimple(entity, effectId, active, definition, now);
      }
    }
  }

  private updateSimple(entity: Entity, effectId: string, active: ActiveEffectRuntime, definition: EffectDefinition, now: number): void {
    this.runPeriodic(entity, definition, active, now, Number(active.stacks ?? 1));
    const expiresAt = active.expiresAtMs;
    if (expiresAt !== null && expiresAt !== undefined && now >= Number(expiresAt)) {
      delete entity.components.active_effects?.[effectId];
      this.world.log(`${entity.name} 的 ${definition.name ?? effectId} 已过期。`);
    }
  }

  private updateIndependent(entity: Entity, effectId: string, active: ActiveEffectRuntime, definition: EffectDefinition, now: number): void {
    const layers: ActiveEffectLayer[] = active.layers ?? [];
    const alive: ActiveEffectLayer[] = [];
    let expiredCount = 0;
    for (const layer of layers) {
      this.runPeriodic(entity, definition, layer, now, 1);
      const expiresAt = layer.expiresAtMs;
      if (expiresAt !== null && expiresAt !== undefined && now >= Number(expiresAt)) expiredCount += 1;
      else alive.push(layer);
    }
    if (expiredCount) this.world.log(`${entity.name} 的 ${definition.name ?? effectId} 过期 ${expiredCount} 层。`);
    if (alive.length) {
      active.layers = alive;
      active.stacks = alive.length;
    } else {
      delete entity.components.active_effects?.[effectId];
    }
  }

  private runPeriodic(entity: Entity, definition: EffectDefinition, runtime: ActiveEffectRuntime | ActiveEffectLayer, now: number, stacks: number): void {
    const periodic = definition.periodicEffect;
    if (!periodic) return;
    const interval = Number(periodic.intervalMs ?? 1000);
    runtime.nextTickAtMs ??= now + interval;
    let tickCount = 0;
    while (now >= Number(runtime.nextTickAtMs)) {
      tickCount += 1;
      runtime.nextTickAtMs = Number(runtime.nextTickAtMs) + interval;
      if (tickCount > 30) {
        runtime.nextTickAtMs = now + interval;
        break;
      }
      applyPeriodicChange(this.world, entity, definition, periodic, stacks);
    }
  }
}
