import { parse } from "jsonc-parser";
import type { Entity, GameRuntime, JsonObj } from "./types";

const COMMAND_HELP = [
  "指令：",
  "  help",
  "  spawn <id> [name] [x y] [components-json]",
  "    例：spawn slime 史莱姆 6 6 {\"resources\":{\"hp\":25,\"max_hp\":25},\"attributes\":{\"move_speed\":70}}",
  "  component <entity> <componentName> <json-value>   # 给实体写入/覆盖自定义 component",
  "    例：component slime ai {\"state\":\"patrol\",\"range\":5}",
  "  item <owner> <protoId> <components-json>          # 创建自定义 component 物品并放入背包",
  "    例：item @player debug-potion {\"display\":{\"name\":\"调试药水\"},\"targeting\":{\"mode\":\"self\"},\"activation\":{\"max\":3},\"effect_applier\":[{\"kind\":\"regeneration\",\"target\":\"self\"}]}",
  "  give <entity> <itemProtoId>",
  "  apply <effectId> <entity>",
  "  damage <entity> <amount> / heal <entity> <amount>",
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
          return `${entity.entityId}: ${entity.name} @(${pos.x},${pos.y})${hp}`;
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
        giveItem(runtime, tokens);
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
  const id = normalizeId(tokens[1] ?? "entity");
  if (!id) throw new Error("spawn 需要 entity id");
  if (world.entities[id]) throw new Error(`实体已存在：${id}`);

  const jsonStart = findJsonStart(raw);
  const prefix = (jsonStart >= 0 ? raw.slice(0, jsonStart) : raw).trim().split(/\s+/);
  const name = prefix[2] && !isNumber(prefix[2]) ? prefix[2] : id;
  const xyStart = name === id ? 2 : 3;
  const x = isNumber(prefix[xyStart]) ? Number(prefix[xyStart]) : findSpawnX(worldEntitiesPositions(runtime), runtime.world.gridWidth, runtime.world.gridHeight)[0];
  const y = isNumber(prefix[xyStart + 1]) ? Number(prefix[xyStart + 1]) : findSpawnX(worldEntitiesPositions(runtime), runtime.world.gridWidth, runtime.world.gridHeight)[1];
  if (!world.isInside(x, y)) throw new Error("生成坐标超出地图");

  const overrides = jsonStart >= 0 ? parseJsonValue(raw.slice(jsonStart)) : {};
  if (typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("components-json 必须是对象");

  const entity: Entity = {
    entityId: id,
    name,
    components: {
      resources: { hp: 40, max_hp: 40 },
      attributes: { move_speed: 60, attack_speed: 0.8 },
      position: { x, y },
      active_effects: {},
      ...overrides,
    },
  };
  entity.components.position ??= { x, y };
  entity.components.active_effects ??= {};
  world.addEntity(entity);
  world.addBurst(id, "#38bdf8");
  world.log(`生成实体：${id} / ${name} @(${entity.components.position.x},${entity.components.position.y})。`);
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
  world.giveCustomItem(ownerId, protoId, components as JsonObj);
}

function giveItem(runtime: GameRuntime, tokens: string[]): void {
  const world = runtime.world;
  const entityId = world.findEntity(tokens[1] ?? "");
  const protoId = tokens[2];
  if (!entityId || !protoId) throw new Error("用法：give <entity> <itemProtoId>");
  world.give(entityId, protoId);
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
  if (!entityId || !Number.isFinite(amount)) throw new Error("用法：damage/heal <entity> <amount>");
  const entity = world.entities[entityId];
  const resources = (entity.components.resources ??= { hp: 1, max_hp: 1 });
  const before = Number(resources.hp ?? 0);
  const maxHp = Number(resources.max_hp ?? Math.max(before, amount));
  resources.max_hp ??= maxHp;
  resources.hp = Math.max(0, Math.min(maxHp, before + sign * amount));
  if (resources.hp > 0) delete entity.components._deathLogged;
  const delta = Number(resources.hp) - before;
  world.addFloatingText(entityId, `${delta >= 0 ? "+" : ""}${delta} hp`, delta >= 0 ? "#4ade80" : "#fb7185");
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
  const errors: any[] = [];
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

function worldEntitiesPositions(runtime: GameRuntime): Set<string> {
  const positions = new Set<string>();
  for (const entity of Object.values(runtime.world.entities)) {
    const position = entity.components.position;
    if (position) positions.add(`${position.x},${position.y}`);
  }
  return positions;
}

function findSpawnX(occupied: Set<string>, width: number, height: number): [number, number] {
  for (let y = 1; y < height; y += 1) {
    for (let x = 1; x < width; x += 1) {
      if (!occupied.has(`${x},${y}`)) return [x, y];
    }
  }
  return [1, 1];
}
