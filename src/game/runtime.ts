import { parse } from "jsonc-parser";
import { ActivationSystem, AttributeSystem, EffectApplierSystem, EffectSystem, EntitySpawnerSystem, TeleportSystem } from "./systems";
import type { EffectSummary, Entity, GameRuntime, JsonObj } from "./types";
import { effectColor, effectStackCount, summarizeTiming } from "./utils";
import { World } from "./world";

export function createGameRuntime(effectText: string, itemText: string, entityText: string): GameRuntime {
  const effects = parseJsonc(effectText, "effect.jsonc");
  const items = parseJsonc(itemText, "item.jsonc");
  const entities = parseJsonc(entityText, "entity.jsonc");
  const world = new World(effects, items, entities);

  world.createEntity("player", { entityId: "player" });
  world.createEntity("training-dummy", { entityId: "dummy" });

  const activationSystem = new ActivationSystem(world);
  new EffectApplierSystem(world);
  new TeleportSystem(world);
  new EntitySpawnerSystem(world);
  const effectSystem = new EffectSystem(world);
  const attributeSystem = new AttributeSystem(world);
  world.systems.push(activationSystem, effectSystem);

  for (const protoId of ["adrenaline-injector", "regen-serum", "focus-coffee", "toxic-dart", "poison-cloud-grenade", "blink-device", "monster-egg"]) {
    if (world.itemPrototypes[protoId]) world.give("player", protoId);
  }
  world.log("Canvas ECS MVP 已启动：WASD/方向键移动，点击格子选择目标，数字键 1-9 使用物品；输入 help 查看指令。");

  return { world, activationSystem, effectSystem, attributeSystem };
}

export function getEffectSummaries(world: World, entity: Entity): EffectSummary[] {
  const now = world.nowMs();
  return Object.entries<JsonObj>(entity.components.active_effects ?? {}).map(([effectId, runtime]) => {
    const definition = world.effects[effectId] ?? {};
    const stacks = effectStackCount(runtime);
    const timing = summarizeTiming(runtime, now);
    return {
      id: effectId,
      name: String(definition.name ?? effectId),
      description: String(definition.description ?? ""),
      stacks,
      remainingText: timing.remainingText,
      remainingMs: timing.remainingMs,
      durationMs: timing.durationMs,
      progress: timing.progress,
      color: effectColor(effectId),
      modifiers: definition.modifiers ?? [],
      periodicEffect: definition.periodicEffect,
      behavior: String(runtime.behavior ?? "none"),
    };
  });
}

function parseJsonc(text: string, label: string): JsonObj {
  const errors: any[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`${label} 解析失败：${errors.map((error) => error.error).join(", ")}`);
  return value ?? {};
}
