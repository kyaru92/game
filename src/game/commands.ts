import { parse, type ParseError } from "jsonc-parser";
import { applyItemPatches, getCommandSuggestions, parseGiveCommandLine } from "./commandLanguage";
import type { CommandSuggestion } from "./commandLanguage";
import { parseDamageType } from "../domain/literals";
import type { DeepPartial, EntityRuntimeComponents, ItemRuntimeComponents } from "../domain/componentTypes";
import type { GameRuntime } from "./types";
import { deepClone, formatCoord } from "./utils";

const COMMAND_HELP = [
  "指令：",
  "  help",
  "  spawn <entityProtoId> [entityId] [x y] [component-overrides-json]",
  "    例：spawn hatched-monster slime_1 6 6 {\"resources\":{\"hp\":50,\"max_hp\":50}}",
  "  component <entity> <componentName> <json-value>   # 给实体写入/覆盖自定义 component",
  "    例：component slime ai {\"state\":\"patrol\",\"range\":5}",
  "  item <owner> <protoId> <components-json>          # 创建自定义 component 物品并放入背包",
  "    例：item @player debug-potion {\"display\":{\"name\":\"调试药水\"},\"targeting\":{\"mode\":\"self\"},\"activation\":{\"maxCharges\":3},\"effect_applier\":[{\"kind\":\"regeneration\",\"target\":\"self\"}]}",
  "  give <entity> <itemProtoId>[component:field=value;!component]",
  "    例：give @player poison-cloud-grenade[targeting:range=60;activation:maxCharges=5,cooldownMs=300;!economy]",
  "    例：give @player debug-potion[display:name=调试药水;targeting:mode=self;activation:maxCharges=3]  # 注册运行时自定义 prototype 并给予实例",
  "  reload <entity> [slotIndex]                       # 装填指定槽位枪械；slotIndex 从 1 开始",
  "  apply <effectId> <entity>",
  "  damage <entity> <amount> [damageType] / heal <entity> <amount>",
  "    例：damage crate-1 15 impact   # 木箱只接受 impact/fire 等允许类型",
  "  remove <entity>",
  "  entities",
].join("\n");

export function executeCommand(runtime: GameRuntime, line: string): void {
  const world = runtime.world;
  const raw = line.trim();
  if (!raw) return;

  const tokens = raw.split(/\s+/);
  const cmd = tokens[0]?.toLowerCase();

  try {
    switch (cmd) {
      case "help":
      case "?":
        world.log(COMMAND_HELP);
        return;
      case "entities":
        world.log(Object.values(world.entities).map((entity) => {
          const pos = entity.components.position ?? { x: 0, y: 0 };
          const res = entity.components.resources;
          const hp = res ? ` hp=${res.hp ?? "?"}/${res.max_hp ?? "?"}` : "";
          return `${entity.entityId}: ${entity.name} @(${formatCoord(pos.x)},${formatCoord(pos.y)})${hp}`;
        }).join("\n") || "没有实体。");
        return;
      case "spawn":
      case "entity":
        spawnEntity(runtime, raw, tokens);
        return;
      case "component":
      case "comp":
      case "setcomp":
        setComponent(runtime, raw, tokens);
        return;
      case "item":
      case "custom-item":
        createCustomItem(runtime, raw, tokens);
        return;
      case "give":
        giveItem(runtime, raw);
        return;
      case "reload":
        reloadFirearm(runtime, tokens);
        return;
      case "apply":
      case "effect":
        applyEffect(runtime, tokens);
        return;
      case "damage":
        changeHp(runtime, tokens, -1);
        return;
      case "heal":
        changeHp(runtime, tokens, 1);
        return;
      case "remove":
      case "kill":
        removeEntity(runtime, tokens);
        return;
      default:
        world.log(`未知指令：${cmd}。输入 help 查看指令。`);
    }
  } catch (error) {
    world.log(`指令执行失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function spawnEntity(runtime: GameRuntime, raw: string, tokens: string[]): void {
  const world = runtime.world;
  const protoId = normalizeId(tokens[1] ?? "");
  if (!protoId) throw new Error("用法：spawn <entityProtoId> [entityId] [x y] [component-overrides-json]");
  if (!world.entityPrototypes[protoId]) throw new Error(`未知实体原型：${protoId}`);

  const jsonStart = findJsonStart(raw);
  const prefix = (jsonStart >= 0 ? raw.slice(0, jsonStart) : raw).trim().split(/\s+/);
  const maybeEntityId = prefix[2] && !isNumber(prefix[2]) ? normalizeId(prefix[2]) : undefined;
  if (maybeEntityId && world.entities[maybeEntityId]) throw new Error(`实体已存在：${maybeEntityId}`);
  const xyStart = maybeEntityId ? 3 : 2;
  const fallback = findSpawnPosition(runtime);
  const x = isNumber(prefix[xyStart]) ? Number(prefix[xyStart]) : fallback[0];
  const y = isNumber(prefix[xyStart + 1]) ? Number(prefix[xyStart + 1]) : fallback[1];
  if (!world.services.spatial.isInside(x, y, world.defaultEntityRadius)) throw new Error("生成坐标超出地图");

  const overrides = jsonStart >= 0 ? parseJsonValue(raw.slice(jsonStart)) : {};
  if (typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("component-overrides-json 必须是对象");

  const entity = world.createEntity(protoId, {
    entityId: maybeEntityId,
    position: { x, y },
    overrides: overrides as DeepPartial<EntityRuntimeComponents>,
  });
  if (!world.services.spatial.canEntityOccupy(entity.entityId, x, y)) {
    delete world.entities[entity.entityId];
    throw new Error("生成位置被占用或碰撞箱超出地图");
  }
  const position = entity.components.position ?? { x, y };
  world.services.vfx.addBurst(entity.entityId, String(entity.components.display?.color ?? "#38bdf8"));
  world.log(`生成实体：${entity.entityId} / ${entity.name} <${protoId}> @(${formatCoord(position.x)},${formatCoord(position.y)})。`);
}

function setComponent(runtime: GameRuntime, raw: string, tokens: string[]): void {
  const world = runtime.world;
  const entityId = world.findEntity(tokens[1] ?? "");
  const componentName = tokens[2];
  if (!entityId || !componentName) throw new Error("用法：component <entity> <componentName> <json-value>");
  const jsonStart = findJsonStart(raw);
  if (jsonStart < 0) throw new Error("缺少 json-value");
  const value = parseJsonValue(raw.slice(jsonStart));
  world.entities[entityId].components[componentName] = value;
  if (componentName === "resources" && typeof value === "object") delete world.entities[entityId].components._deathLogged;
  world.log(`${world.entityName(entityId)} 写入 component.${componentName}。`);
}

function createCustomItem(runtime: GameRuntime, raw: string, tokens: string[]): void {
  const world = runtime.world;
  const ownerId = world.findEntity(tokens[1] ?? "");
  const protoId = normalizeId(tokens[2] ?? "custom-item");
  if (!ownerId || !protoId) throw new Error("用法：item <owner> <protoId> <components-json>");
  const jsonStart = findJsonStart(raw);
  if (jsonStart < 0) throw new Error("缺少 components-json");
  const components = parseJsonValue(raw.slice(jsonStart));
  if (typeof components !== "object" || Array.isArray(components)) throw new Error("components-json 必须是对象");
  world.giveCustomItem(ownerId, protoId, components as ItemRuntimeComponents);
}

function giveItem(runtime: GameRuntime, raw: string): void {
  const world = runtime.world;
  const parsed = parseGiveCommandLine(raw);
  const entityId = world.findEntity(parsed.entitySelector);
  if (!entityId) throw new Error(`找不到实体：${parsed.entitySelector}`);

  if (!parsed.hasPatches) {
    world.give(entityId, parsed.protoId);
    return;
  }

  const existingPrototype = world.itemPrototype(parsed.protoId);
  const baseComponents = existingPrototype?.components ? deepClone(existingPrototype.components) : {};
  const components = applyItemPatches(baseComponents, parsed.patches);
  preventVariantAutoStack(components);
  if (!existingPrototype) world.customItemPrototypes[parsed.protoId] = { components: deepClone(components) };
  world.giveCustomItem(entityId, parsed.protoId, components);
}

function preventVariantAutoStack(components: ItemRuntimeComponents): void {
  const stacking = components.stacking;
  if (stacking && typeof stacking === "object" && !Array.isArray(stacking)) {
    stacking.max = 1;
    stacking.quantity = 1;
    delete stacking.initialQuantity;
    return;
  }
  components.stacking = { max: 1, quantity: 1 };
}

export function getCommandCompletions(runtime: GameRuntime, line: string, cursor = line.length): CommandSuggestion[] {
  return getCommandSuggestions(runtime, line, cursor);
}

function reloadFirearm(runtime: GameRuntime, tokens: string[]): void {
  const world = runtime.world;
  const entityId = world.findEntity(tokens[1] ?? "");
  if (!entityId) throw new Error("用法：reload <entity> [slotIndex]");
  const inventory = world.services.inventory.get(entityId);
  const explicitIndex = isNumber(tokens[2]) ? Number(tokens[2]) - 1 : undefined;
  const inventoryIndex = explicitIndex ?? inventory.findIndex((itemId) => Boolean(world.items[itemId]?.components.firearm));
  if (!Number.isInteger(inventoryIndex) || inventoryIndex < 0 || inventoryIndex >= inventory.length) throw new Error("找不到可装填的枪械槽位");
  runtime.firearmSystem.reload(entityId, inventoryIndex);
}

function applyEffect(runtime: GameRuntime, tokens: string[]): void {
  const effectId = tokens[1];
  const entityId = runtime.world.findEntity(tokens[2] ?? "");
  if (!effectId || !entityId) throw new Error("用法：apply <effectId> <entity>");
  runtime.effectSystem.applyEffect(effectId, entityId, "command", undefined, undefined);
}

function changeHp(runtime: GameRuntime, tokens: string[], sign: 1 | -1): void {
  const world = runtime.world;
  const entityId = world.findEntity(tokens[1] ?? "");
  const amount = Number(tokens[2]);
  if (!entityId || !Number.isFinite(amount)) throw new Error("用法：damage <entity> <amount> [damageType] / heal <entity> <amount>");
  if (sign < 0) {
    const damageType = parseDamageType(tokens[3]) ?? "generic";
    world.services.damage.applyDamage(entityId, amount, damageType, "指令伤害");
    return;
  }
  const entity = world.entities[entityId];
  const resources = (entity.components.resources ??= { hp: 1, max_hp: 1 });
  const before = Number(resources.hp ?? 0);
  const maxHp = Number(resources.max_hp ?? Math.max(before, amount));
  resources.max_hp ??= maxHp;
  resources.hp = Math.max(0, Math.min(maxHp, before + sign * amount));
  if (resources.hp > 0) delete entity.components._deathLogged;
  const delta = Number(resources.hp) - before;
  world.services.vfx.addFloatingText(entityId, `${delta >= 0 ? "+" : ""}${delta} hp`, delta >= 0 ? "#4ade80" : "#fb7185");
  world.log(`${entity.name} hp ${before} -> ${resources.hp}`);
}

function removeEntity(runtime: GameRuntime, tokens: string[]): void {
  const entityId = runtime.world.findEntity(tokens[1] ?? "");
  if (!entityId) throw new Error("用法：remove <entity>");
  if (entityId === "player") throw new Error("不能移除玩家");
  runtime.world.removeEntity(entityId, "被指令移除");
}

function findJsonStart(raw: string): number {
  const objectStart = raw.indexOf("{");
  const arrayStart = raw.indexOf("[");
  if (objectStart < 0) return arrayStart;
  if (arrayStart < 0) return objectStart;
  return Math.min(objectStart, arrayStart);
}

function parseJsonValue(text: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error("JSON/JSONC 解析失败");
  return value;
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function isNumber(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "" && Number.isFinite(Number(value));
}

function findSpawnPosition(runtime: GameRuntime): [number, number] {
  const world = runtime.world;
  for (let y = 1; y < world.height; y += 1) {
    for (let x = 1; x < world.width; x += 1) {
      if (world.services.spatial.isInside(x, y, world.defaultEntityRadius) && !world.services.spatial.entityAt(x, y)) return [x, y];
    }
  }
  return [1, 1];
}
