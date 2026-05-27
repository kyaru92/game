import { parse } from "jsonc-parser";
import { ActivationSystem, AttributeSystem, EffectApplierSystem, EffectSystem, EntitySpawnerSystem, TeleportSystem } from "./systems";
import type { EffectSummary, Entity, GameRuntime, JsonObj } from "./types";
import { effectColor, effectStackCount, summarizeTiming } from "./utils";
import { World } from "./world";

export function createGameRuntime(effectText: string, itemText: string): GameRuntime {
  const effects = parseJsonc(effectText, "effect.jsonc");
  const items = parseJsonc(itemText, "item.jsonc");
  const world = new World(effects, items);

  world.addEntity({
    entityId: "player",
    name: "玩家",
    components: {
      resources: { hp: 90, max_hp: 100 },
      attributes: { move_speed: 100, attack_speed: 1.0 },
      position: { x: 1, y: 1 },
      inventory: [],
      active_effects: {},
    },
  });
  world.addEntity({
    entityId: "dummy",
    name: "训练假人",
    components: {
      resources: { hp: 60, max_hp: 60 },
      attributes: { move_speed: 50, attack_speed: 0.5 },
      position: { x: 11, y: 5 },
      active_effects: {},
    },
  });

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
