import { EventBus } from "./eventBus";
import type { Entity, ItemInstance, JsonObj, VisualEvent } from "./types";
import { deepClone, displayItemName, initItemRuntimeState } from "./utils";

export class World {
  readonly gridWidth = 16;
  readonly gridHeight = 12;
  readonly effects: JsonObj;
  readonly itemPrototypes: JsonObj;
  readonly bus = new EventBus();
  readonly entities: Record<string, Entity> = {};
  readonly items: Record<string, ItemInstance> = {};
  readonly messages: string[] = [];
  readonly visualEvents: VisualEvent[] = [];
  readonly systems: Array<{ update?: () => void }> = [];
  readonly blockers = new Set<string>([
    "4,2",
    "5,2",
    "6,2",
    "9,4",
    "9,5",
    "9,6",
    "2,8",
    "3,8",
    "12,8",
    "13,8",
    "13,9",
  ]);

  private nextItemNo = 1;
  private nextVisualNo = 1;

  constructor(effects: JsonObj, itemPrototypes: JsonObj) {
    this.effects = effects;
    this.itemPrototypes = itemPrototypes;
  }

  nowMs(): number {
    return performance.now();
  }

  log(message: string): void {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    this.messages.push(`[${time}] ${message}`);
    if (this.messages.length > 120) this.messages.splice(0, this.messages.length - 120);
  }

  addEntity(entity: Entity): void {
    this.entities[entity.entityId] = entity;
  }

  removeEntity(entityId: string, reason = "消失"): void {
    const entity = this.entities[entityId];
    if (!entity) return;
    delete this.entities[entityId];
    this.log(`${entity.name} ${reason}。`);
  }

  entityName(entityId: string): string {
    return this.entities[entityId]?.name ?? entityId;
  }

  player(): Entity {
    return this.entities.player;
  }

  inventory(entityId = "player"): string[] {
    const entity = this.entities[entityId];
    if (!entity) return [];
    entity.components.inventory ??= [];
    return entity.components.inventory;
  }

  findEntity(selector: string): string | undefined {
    const aliases: Record<string, string> = {
      "@player": "player",
      "@me": "player",
      "@self": "player",
      "@who": "player",
      "@dummy": "dummy",
    };
    const alias = aliases[selector];
    if (alias && this.entities[alias]) return alias;
    if (this.entities[selector]) return selector;
    const lower = selector.toLowerCase();
    return Object.values(this.entities).find((entity) => entity.name.toLowerCase() === lower)?.entityId;
  }

  createItem(protoId: string): ItemInstance {
    const proto = this.itemPrototypes[protoId];
    if (!proto) throw new Error(`未知物品原型：${protoId}`);
    const item = this.createCustomItem(protoId, deepClone(proto.components ?? {}));
    return item;
  }

  createCustomItem(protoId: string, components: JsonObj): ItemInstance {
    const item: ItemInstance = {
      instanceId: `item_${this.nextItemNo++}`,
      protoId,
      components: deepClone(components),
    };
    initItemRuntimeState(item);
    this.items[item.instanceId] = item;
    return item;
  }

  give(entityId: string, protoId: string): ItemInstance {
    const item = this.createItem(protoId);
    this.inventory(entityId).push(item.instanceId);
    this.log(`${this.entityName(entityId)} 获得：${displayItemName(item)}。`);
    return item;
  }

  giveCustomItem(entityId: string, protoId: string, components: JsonObj): ItemInstance {
    const item = this.createCustomItem(protoId, components);
    this.inventory(entityId).push(item.instanceId);
    this.log(`${this.entityName(entityId)} 获得自定义物品：${displayItemName(item)}。`);
    return item;
  }

  tick(): void {
    for (const system of this.systems) system.update?.();
    this.removeDeadEntities();
    const now = this.nowMs();
    for (let i = this.visualEvents.length - 1; i >= 0; i -= 1) {
      const event = this.visualEvents[i];
      if (now - event.createdAtMs > event.durationMs) this.visualEvents.splice(i, 1);
    }
  }

  removeDeadEntities(): void {
    for (const entity of Object.values(this.entities)) {
      const resources = entity.components.resources;
      if (!resources || typeof resources.hp !== "number" || resources.hp > 0) continue;
      if (entity.entityId === "player") {
        if (!entity.components._deathLogged) {
          entity.components._deathLogged = true;
          this.log("玩家生命归零，进入濒死状态。可以用指令 heal @player 100 恢复。 ");
        }
        continue;
      }
      this.addBurst(entity.entityId, "#f43f5e");
      this.removeEntity(entity.entityId, "生命归零并消失");
    }
  }

  isInside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.gridWidth && y < this.gridHeight;
  }

  isBlocked(x: number, y: number): boolean {
    return this.blockers.has(`${x},${y}`);
  }

  entityAt(x: number, y: number): Entity | undefined {
    return Object.values(this.entities).find((entity) => {
      const position = entity.components.position ?? { x: 0, y: 0 };
      return position.x === x && position.y === y;
    });
  }

  tryMove(entityId: string, dx: number, dy: number): boolean {
    const entity = this.entities[entityId];
    if (!entity) return false;
    const position = entity.components.position ?? { x: 0, y: 0 };
    const nextX = position.x + dx;
    const nextY = position.y + dy;
    if (!this.isInside(nextX, nextY)) {
      this.log("已经到达世界边界。");
      return false;
    }
    if (this.isBlocked(nextX, nextY)) {
      this.log("这里有障碍物，无法通行。");
      return false;
    }
    const other = this.entityAt(nextX, nextY);
    if (other && other.entityId !== entityId) {
      this.log(`${other.name} 挡住了去路。`);
      return false;
    }
    entity.components.position = { x: nextX, y: nextY };
    return true;
  }

  addFloatingText(entityId: string, text: string, color: string): void {
    const entity = this.entities[entityId];
    const position = entity?.components.position ?? { x: 0, y: 0 };
    this.visualEvents.push({
      id: this.nextVisualNo++,
      kind: "text",
      x: position.x,
      y: position.y,
      text,
      color,
      createdAtMs: this.nowMs(),
      durationMs: 1150,
    });
  }

  addBurst(entityId: string, color: string): void {
    const entity = this.entities[entityId];
    const position = entity?.components.position ?? { x: 0, y: 0 };
    this.visualEvents.push({
      id: this.nextVisualNo++,
      kind: "burst",
      x: position.x,
      y: position.y,
      color,
      createdAtMs: this.nowMs(),
      durationMs: 700,
    });
  }

  addTeleportTrail(from: [number, number], to: [number, number]): void {
    this.visualEvents.push({
      id: this.nextVisualNo++,
      kind: "teleport",
      x: from[0],
      y: from[1],
      color: "#60a5fa",
      createdAtMs: this.nowMs(),
      durationMs: 600,
    });
    this.visualEvents.push({
      id: this.nextVisualNo++,
      kind: "burst",
      x: to[0],
      y: to[1],
      color: "#93c5fd",
      createdAtMs: this.nowMs(),
      durationMs: 700,
    });
  }
}
