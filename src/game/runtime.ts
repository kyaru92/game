import { parse } from "jsonc-parser";
import { ActivationSystem, AttributeSystem, DamageApplierSystem, EffectApplierSystem, EffectSystem, EntitySpawnerSystem, FirearmSystem, LootSystem, ProjectileLauncherSystem, ProjectileSystem, TeleportSystem } from "./systems";
import type { EffectDefinitions, EntityDefinitions, ItemDefinitions } from "../domain/componentTypes";
import type { EffectSummary, Entity, GameRuntime, JsonObj } from "./types";
import { effectColor, effectStackCount, summarizeTiming } from "./utils";
import { World } from "./world";

export function createGameRuntime(effectText: string, itemText: string, entityText: string): GameRuntime {
  const effects = parseJsonc<EffectDefinitions>(effectText, "effect.jsonc");
  const items = parseJsonc<ItemDefinitions>(itemText, "item.jsonc");
  const entities = parseJsonc<EntityDefinitions>(entityText, "entity.jsonc");
  const world = new World(effects, items, entities);

  world.createEntity("player", { entityId: "player" });
  world.createEntity("training-dummy", { entityId: "dummy" });
  createInitialObstacles(world);

  const activationSystem = new ActivationSystem(world);
  const firearmSystem = new FirearmSystem(world);
  new EffectApplierSystem(world);
  new DamageApplierSystem(world);
  new ProjectileLauncherSystem(world);
  new TeleportSystem(world);
  new EntitySpawnerSystem(world);
  const lootSystem = new LootSystem(world);
  const projectileSystem = new ProjectileSystem(world);
  const effectSystem = new EffectSystem(world);
  const attributeSystem = new AttributeSystem(world);
  world.systems.push(activationSystem, firearmSystem, lootSystem, projectileSystem, effectSystem);

  const grantedItems: Record<string, string> = {};
  for (const protoId of ["adrenaline-injector", "regen-serum", "focus-coffee", "toxic-dart", "poison-cloud-grenade", "blink-device", "monster-egg", "impact-hammer", "basic-pistol", "toxic-nine-mm-round", "explosive-nine-mm-round", "nine-mm-round"]) {
    if (world.itemPrototypes[protoId]) grantedItems[protoId] = world.give("player", protoId).instanceId;
  }
  ["basic-pistol", "impact-hammer", "adrenaline-injector", "regen-serum", "poison-cloud-grenade", "blink-device", "monster-egg"].forEach((protoId, index) => {
    const itemId = grantedItems[protoId];
    if (itemId) world.services.inventory.setHotbarSlot("player", index, itemId);
  });
  if (grantedItems["basic-pistol"]) world.services.inventory.equipItem("player", grantedItems["basic-pistol"]);
  world.log("Canvas ECS MVP 已启动：WASD/方向键移动，1-7 快捷栏，B 打开背包，鼠标左键使用当前装备，R 装填枪械。");

  return { world, activationSystem, firearmSystem, lootSystem, effectSystem, attributeSystem };
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

function createInitialObstacles(world: World): void {
  if (world.entityPrototypes["wooden-crate"]) {
    world.createEntity("wooden-crate", { entityId: "crate-1", position: { x: 4.5, y: 2.7 } });
    world.createEntity("wooden-crate", { entityId: "crate-2", position: { x: 6.2, y: 7.6 } });
  }
  if (world.entityPrototypes["stone-block"]) {
    world.createEntity("stone-block", { entityId: "stone-1", position: { x: 9.2, y: 4.8 } });
    world.createEntity("stone-block", { entityId: "stone-2", position: { x: 12.2, y: 8.7 } });
  }
}

function parseJsonc<T>(text: string, label: string): T {
  const errors: any[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`${label} 解析失败：${errors.map((error) => error.error).join(", ")}`);
  return (value ?? {}) as T;
}
