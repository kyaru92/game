
import type { Entity, JsonObj } from "../types";
import type { World } from "../world";
import { stackedValue } from "../utils";

type PeriodicStackType = Parameters<typeof stackedValue>[2];

export function makeLayer(definition: JsonObj, durationMs: number, now: number): JsonObj {
  const interval = definition.periodicEffect ? Number(definition.periodicEffect.intervalMs ?? 1000) : undefined;
  return {
    startedAtMs: now,
    expiresAtMs: durationMs < 0 ? null : now + durationMs,
    durationMs,
    nextTickAtMs: interval === undefined ? undefined : now + interval,
  };
}

export function makeActiveEffect(definition: JsonObj, behavior: string, stacks: number, durationMs: number, now: number, sourceEntityId?: string, sourceItemId?: string): JsonObj {
  const active: JsonObj = {
    effectId: definition.id,
    behavior,
    stacks,
    sourceEntityId,
    sourceItemId,
  };
  if (behavior === "independent") active.layers = [makeLayer(definition, durationMs, now)];
  else Object.assign(active, makeLayer(definition, durationMs, now));
  return active;
}

export function refreshRuntime(runtime: JsonObj, durationMs: number, now: number): void {
  runtime.startedAtMs = now;
  runtime.expiresAtMs = durationMs < 0 ? null : now + durationMs;
  runtime.durationMs = durationMs;
}

export function applyPeriodicChange(world: World, entity: Entity, definition: JsonObj, periodic: JsonObj, stacks: number): void {
  const attr = String(periodic.attribute);
  const op = String(periodic.op ?? "add");
  const value = Number(periodic.value ?? 0);
  const stackType = periodicStackType(periodic.stackType);
  const amount = stackedValue(value, stacks, stackType);
  const effectName = String(definition.name ?? definition.id ?? "effect");

  const resources = (entity.components.resources ??= {});
  if (attr === "hp" && amount < 0) {
    const damageType = String(periodic.damageType ?? definition.damageType ?? definition.id ?? "effect");
    world.services.damage.applyDamage(entity.entityId, -amount, damageType, effectName);
    return;
  }
  if (attr in resources) {
    const before = Number(resources[attr]);
    const maxKey = `max_${attr}`;
    let after = op === "mul" ? before * (1 + amount) : before + amount;
    if (maxKey in resources) after = Math.min(after, Number(resources[maxKey]));
    after = Math.max(0, after);
    resources[attr] = Number.isInteger(after) ? Math.trunc(after) : Number(after.toFixed(2));
    const delta = Number(resources[attr]) - before;
    const sign = delta >= 0 ? "+" : "";
    const color = delta >= 0 ? "#4ade80" : "#fb7185";
    const deltaText = Number.isInteger(delta) ? String(delta) : delta.toFixed(2);
    world.log(`${entity.name} 受到 ${effectName} 周期效果：${attr} ${sign}${deltaText} -> ${resources[attr]}`);
    world.services.vfx.addFloatingText(entity.entityId, `${sign}${deltaText} ${attr}`, color);
    return;
  }

  const attrs = (entity.components.attributes ??= {});
  const before = Number(attrs[attr] ?? 0);
  const after = op === "mul" ? before * (1 + amount) : before + amount;
  attrs[attr] = Number(after.toFixed(2));
  world.log(`${entity.name} 的 ${attr} 周期变化 ${before} -> ${attrs[attr]}`);
}

function periodicStackType(value: unknown): PeriodicStackType {
  return value === "none" || value === "mul" ? value : "add";
}
