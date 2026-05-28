import { EventBus } from "./eventBus";
import type { EffectDefinitions, EntityDefinitions, ItemDefinitions } from "../domain/componentTypes";
import type { Entity, ItemInstance, JsonObj, VisualEvent } from "./types";
import { deepClone, deepMerge, displayItemName, initEntityRuntimeState, initItemRuntimeState, isEquipmentItem } from "./utils";

export interface CreateEntityOptions {
  entityId?: string;
  name?: string;
  position?: { x: number; y: number };
  overrides?: JsonObj;
}

export interface MoveOptions {
  logFailure?: boolean;
}

export interface CollisionBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export class World {
  readonly width = 16;
  readonly height = 12;
  readonly defaultEntityRadius = 0.35;
  readonly selectionRadius = 0.45;
  readonly effects: EffectDefinitions;
  readonly itemPrototypes: ItemDefinitions;
  readonly customItemPrototypes: ItemDefinitions = {};
  readonly entityPrototypes: EntityDefinitions;
  readonly bus = new EventBus();
  readonly entities: Record<string, Entity> = {};
  readonly items: Record<string, ItemInstance> = {};
  readonly messages: string[] = [];
  readonly visualEvents: VisualEvent[] = [];
  readonly systems: Array<{ update?: () => void }> = [];

  private nextItemNo = 1;
  private nextVisualNo = 1;
  private nextEntityNo = 1;

  constructor(effects: EffectDefinitions, itemPrototypes: ItemDefinitions, entityPrototypes: EntityDefinitions = {}) {
    this.effects = effects;
    this.itemPrototypes = itemPrototypes;
    this.entityPrototypes = entityPrototypes;
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
    initEntityRuntimeState(entity);
    this.entities[entity.entityId] = entity;
  }

  createEntity(protoId: string, options: CreateEntityOptions = {}): Entity {
    const proto = this.entityPrototypes[protoId];
    if (!proto) throw new Error(`未知实体原型：${protoId}`);
    const components = deepMerge(deepClone(proto.components ?? {}), options.overrides ?? {});
    if (options.position) components.position = { x: options.position.x, y: options.position.y };
    const entity: Entity = {
      entityId: options.entityId ?? this.nextEntityId(protoId),
      name: options.name ?? components.display?.name ?? proto.name ?? protoId,
      components,
    };
    this.addEntity(entity);
    return entity;
  }

  nextEntityId(prefix: string): string {
    const normalized = normalizeEntityId(prefix) || "entity";
    let id = `${normalized}-${this.nextEntityNo++}`;
    while (this.entities[id]) id = `${normalized}-${this.nextEntityNo++}`;
    return id;
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

  hotbar(entityId = "player"): Array<string | null> {
    const entity = this.entities[entityId];
    if (!entity) return [];
    const inventory = this.inventory(entityId);
    const hotbar = (entity.components.hotbar ??= {});
    const rawSize = Number(hotbar.size ?? 7);
    const size = Math.max(1, Math.min(12, Number.isFinite(rawSize) ? Math.floor(rawSize) : 7));
    const slots: Array<string | null> = Array.isArray(hotbar.slots) ? hotbar.slots : [];
    hotbar.size = size;
    hotbar.slots = slots;
    while (slots.length < size) slots.push(null);
    if (slots.length > size) slots.length = size;
    for (let index = 0; index < slots.length; index += 1) {
      const itemId = slots[index];
      if (typeof itemId !== "string" || !inventory.includes(itemId) || !this.items[itemId]) slots[index] = null;
    }
    return slots;
  }

  setHotbarSlot(entityId: string, slotIndex: number, itemId: string | null): boolean {
    const slots = this.hotbar(entityId);
    if (slotIndex < 0 || slotIndex >= slots.length) {
      this.log(`快捷栏槽位不存在：${slotIndex + 1}`);
      return false;
    }
    if (itemId && (!this.items[itemId] || !this.inventory(entityId).includes(itemId))) {
      this.log(`不能把不在背包中的物品放入快捷栏：${itemId}`);
      return false;
    }
    if (itemId && !this.items[itemId].components.activation && !isEquipmentItem(this.items[itemId])) {
      this.log(`${displayItemName(this.items[itemId])} 不能放入快捷栏。`);
      return false;
    }
    slots[slotIndex] = itemId;
    return true;
  }

  equipItem(entityId: string, itemId: string): boolean {
    const entity = this.entities[entityId];
    if (!entity || !this.items[itemId] || !this.inventory(entityId).includes(itemId)) {
      this.log(`不能装备不在背包中的物品：${itemId}`);
      return false;
    }
    entity.components.loadout ??= {};
    entity.components.loadout.activeItemId = itemId;
    return true;
  }

  activeItemId(entityId = "player"): string | undefined {
    const entity = this.entities[entityId];
    const itemId = entity?.components.loadout?.activeItemId;
    if (typeof itemId !== "string") return undefined;
    if (this.items[itemId] && this.inventory(entityId).includes(itemId)) return itemId;
    if (entity?.components.loadout) delete entity.components.loadout.activeItemId;
    return undefined;
  }

  findEntity(selector: string): string | undefined {
    const aliases: Record<string, string> = {
      "@player": "player",
      "@me": "player",
      "@self": "player",
      "@who": "player",
      "@dummy": "dummy",
      "@training-dummy": "dummy",
    };
    const alias = aliases[selector];
    if (alias && this.entities[alias]) return alias;
    if (this.entities[selector]) return selector;
    const lower = selector.toLowerCase();
    return Object.values(this.entities).find((entity) => entity.name.toLowerCase() === lower || String(entity.components.display?.name ?? "").toLowerCase() === lower)?.entityId;
  }

  itemPrototype(protoId: string): ItemDefinitions[string] | undefined {
    return this.itemPrototypes[protoId] ?? this.customItemPrototypes[protoId];
  }

  createItem(protoId: string): ItemInstance {
    const proto = this.itemPrototype(protoId);
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
    return this.addInventoryItem(entityId, item, "获得");
  }

  giveCustomItem(entityId: string, protoId: string, components: JsonObj): ItemInstance {
    const item = this.createCustomItem(protoId, components);
    return this.addInventoryItem(entityId, item, "获得自定义物品");
  }

  removeInventoryItem(entityId: string, itemId: string): void {
    const inventory = this.inventory(entityId);
    const index = inventory.indexOf(itemId);
    if (index >= 0) inventory.splice(index, 1);
    this.clearItemReferences(entityId, itemId);
    delete this.items[itemId];
  }

  private addInventoryItem(entityId: string, item: ItemInstance, verb: string): ItemInstance {
    const receivedText = stackDisplaySuffix(item);
    const merged = this.tryMergeStack(entityId, item);
    if (merged) {
      delete this.items[item.instanceId];
      this.log(`${this.entityName(entityId)} ${verb}：${displayItemName(merged)}${receivedText}。`);
      return merged;
    }
    this.inventory(entityId).push(item.instanceId);
    this.autoHotbarItem(entityId, item.instanceId);
    this.log(`${this.entityName(entityId)} ${verb}：${displayItemName(item)}${receivedText}。`);
    return item;
  }

  private autoHotbarItem(entityId: string, itemId: string): void {
    const item = this.items[itemId];
    if (!item || (!item.components.activation && !isEquipmentItem(item))) return;
    const slots = this.hotbar(entityId);
    if (slots.includes(itemId)) return;
    const emptyIndex = slots.findIndex((slot) => !slot);
    if (emptyIndex >= 0) slots[emptyIndex] = itemId;
  }

  private clearItemReferences(entityId: string, itemId: string): void {
    const slots = this.hotbar(entityId);
    for (const [index, slotItemId] of slots.entries()) {
      if (slotItemId === itemId) slots[index] = null;
    }
    const entity = this.entities[entityId];
    if (entity?.components.loadout?.activeItemId === itemId) delete entity.components.loadout.activeItemId;
  }

  private tryMergeStack(entityId: string, item: ItemInstance): ItemInstance | undefined {
    let remaining = stackQuantity(item);
    const max = stackMax(item);
    if (max <= 1 || remaining <= 0 || item.components.activation) return undefined;
    let lastMerged: ItemInstance | undefined;
    for (const itemId of this.inventory(entityId)) {
      const existing = this.items[itemId];
      if (!existing || existing.protoId !== item.protoId || stackMax(existing) <= 1 || existing.components.activation) continue;
      const existingQuantity = stackQuantity(existing);
      const space = stackMax(existing) - existingQuantity;
      if (space <= 0) continue;
      const moved = Math.min(space, remaining);
      existing.components.stacking ??= {};
      item.components.stacking ??= {};
      existing.components.stacking.quantity = existingQuantity + moved;
      remaining -= moved;
      item.components.stacking.quantity = remaining;
      lastMerged = existing;
      if (remaining <= 0) return lastMerged;
    }
    return remaining <= 0 ? lastMerged : undefined;
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
      this.removeEntity(entity.entityId, entity.components.obstacle ? "被摧毁" : "生命归零并消失");
    }
  }

  isInside(x: number, y: number, radius = 0): boolean {
    return x >= radius && y >= radius && x <= this.width - radius && y <= this.height - radius;
  }

  isBlocked(_x: number, _y: number): boolean {
    return false;
  }

  entityBounds(entity: Entity, position = entity.components.position ?? { x: 0, y: 0 }): CollisionBox {
    return collisionBox(entity.components, position, this.defaultEntityRadius);
  }

  entityRadius(entity: Entity): number {
    const bounds = this.entityBounds(entity);
    return Math.max(bounds.width, bounds.height) / 2;
  }

  entityAt(x: number, y: number, padding = this.selectionRadius, exceptEntityId?: string): Entity | undefined {
    let closest: Entity | undefined;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const entity of Object.values(this.entities)) {
      if (entity.entityId === exceptEntityId) continue;
      const position = entity.components.position;
      if (!position) continue;
      const bounds = expandBox(this.entityBounds(entity), padding);
      if (!pointInBox(x, y, bounds)) continue;
      const distance = distanceToBoxCenter(x, y, bounds);
      if (distance < closestDistance) {
        closest = entity;
        closestDistance = distance;
      }
    }
    return closest;
  }

  canEntityOccupy(entityId: string, x: number, y: number): boolean {
    const entity = this.entities[entityId];
    return Boolean(entity) && this.canOccupy(entityId, entity, x, y);
  }

  blockingEntityFor(entityId: string, x: number, y: number): Entity | undefined {
    const entity = this.entities[entityId];
    return entity ? this.blockingEntityAt(entityId, this.entityBounds(entity, { x, y })) : undefined;
  }

  applyDamage(entityId: string, amount: number, damageType = "generic", sourceName = "伤害"): boolean {
    const entity = this.entities[entityId];
    if (!entity || !Number.isFinite(amount) || amount <= 0) return false;

    const damageable = entity.components.damageable ?? {};
    if (damageable.destructible === false) {
      this.log(`${entity.name} 是固定障碍，无法被破坏。`);
      return false;
    }

    const normalizedType = damageType.trim().toLowerCase() || "generic";
    if (!isDamageTypeAllowed(damageable, normalizedType)) {
      this.log(`${entity.name} 不会受到 ${normalizedType} 类型伤害。`);
      return false;
    }

    const resources = entity.components.resources;
    if (!resources || typeof resources.hp !== "number") {
      this.log(`${entity.name} 没有可被伤害的生命资源。`);
      return false;
    }

    const before = Number(resources.hp ?? 0);
    const maxHp = Number(resources.max_hp ?? Math.max(before, amount));
    resources.max_hp ??= maxHp;
    resources.hp = Math.max(0, before - amount);
    const delta = before - Number(resources.hp);
    if (delta <= 0) return false;

    this.addFloatingText(entityId, `-${formatNumber(delta)} hp`, "#fb7185");
    this.log(`${entity.name} 受到 ${sourceName}：${normalizedType} ${formatNumber(delta)}，hp ${formatNumber(before)} -> ${formatNumber(resources.hp)}。`);
    return true;
  }

  tryMove(entityId: string, dx: number, dy: number, options: MoveOptions = {}): boolean {
    const entity = this.entities[entityId];
    if (!entity || !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const position = entity.components.position ?? { x: 0, y: 0 };
    const target = this.clampToWorld(entity, position.x + dx, position.y + dy);
    if (samePosition(position, target)) {
      if (options.logFailure ?? true) this.log("已经到达世界边界。");
      return false;
    }
    if (this.canOccupy(entityId, entity, target.x, target.y)) {
      this.setPosition(entity, target.x, target.y);
      return true;
    }

    const axisTargets = [
      this.clampToWorld(entity, position.x + dx, position.y),
      this.clampToWorld(entity, position.x, position.y + dy),
    ];
    for (const axisTarget of axisTargets) {
      if (samePosition(position, axisTarget)) continue;
      if (!this.canOccupy(entityId, entity, axisTarget.x, axisTarget.y)) continue;
      this.setPosition(entity, axisTarget.x, axisTarget.y);
      return true;
    }

    if (options.logFailure ?? true) {
      const other = this.blockingEntityFor(entityId, target.x, target.y);
      this.log(other ? `${other.name} 挡住了去路。` : "无法移动到该位置。");
    }
    return false;
  }

  private clampToWorld(entity: Entity, x: number, y: number): { x: number; y: number } {
    const bounds = this.entityBounds(entity, { x, y });
    let clampedX = x;
    let clampedY = y;
    if (bounds.left < 0) clampedX -= bounds.left;
    if (bounds.right > this.width) clampedX -= bounds.right - this.width;
    if (bounds.top < 0) clampedY -= bounds.top;
    if (bounds.bottom > this.height) clampedY -= bounds.bottom - this.height;
    return { x: clampedX, y: clampedY };
  }

  private canOccupy(entityId: string, entity: Entity, x: number, y: number): boolean {
    const bounds = this.entityBounds(entity, { x, y });
    return this.isBoxInsideWorld(bounds) && !this.isBlocked(x, y) && !this.blockingEntityAt(entityId, bounds);
  }

  private blockingEntityAt(entityId: string, bounds: CollisionBox): Entity | undefined {
    return Object.values(this.entities).find((other) => {
      if (other.entityId === entityId || other.components.collision?.blocksMovement === false) return false;
      const position = other.components.position;
      if (!position) return false;
      return boxesIntersect(bounds, this.entityBounds(other, position));
    });
  }

  private isBoxInsideWorld(bounds: CollisionBox): boolean {
    return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= this.width && bounds.bottom <= this.height;
  }

  private setPosition(entity: Entity, x: number, y: number): void {
    entity.components.position = { x: roundCoord(x), y: roundCoord(y) };
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

function stackMax(item: ItemInstance): number {
  return Math.max(1, Number(item.components.stacking?.max ?? 1));
}

function stackQuantity(item: ItemInstance): number {
  return Math.max(1, Number(item.components.stacking?.quantity ?? 1));
}

function stackDisplaySuffix(item: ItemInstance): string {
  const max = stackMax(item);
  return max > 1 ? ` ×${stackQuantity(item)}` : "";
}

function collisionBox(components: JsonObj, position: { x: number; y: number }, defaultRadius: number): CollisionBox {
  const collision = components.collision ?? {};
  const radius = positiveNumber(collision.radius, defaultRadius);
  const width = positiveNumber(collision.width, radius * 2);
  const height = positiveNumber(collision.height, radius * 2);
  const offsetX = finiteNumber(collision.offsetX, 0);
  const offsetY = finiteNumber(collision.offsetY, 0);
  const centerX = position.x + offsetX;
  const centerY = position.y + offsetY;
  return {
    left: centerX - width / 2,
    top: centerY - height / 2,
    right: centerX + width / 2,
    bottom: centerY + height / 2,
    width,
    height,
  };
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function expandBox(box: CollisionBox, padding: number): CollisionBox {
  return {
    left: box.left - padding,
    top: box.top - padding,
    right: box.right + padding,
    bottom: box.bottom + padding,
    width: box.width + padding * 2,
    height: box.height + padding * 2,
  };
}

function pointInBox(x: number, y: number, box: CollisionBox): boolean {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

function distanceToBoxCenter(x: number, y: number, box: CollisionBox): number {
  return Math.hypot(x - (box.left + box.right) / 2, y - (box.top + box.bottom) / 2);
}

function boxesIntersect(a: CollisionBox, b: CollisionBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function isDamageTypeAllowed(damageable: JsonObj, damageType: string): boolean {
  const allowed = stringList(damageable.allowedDamageTypes ?? damageable.vulnerableTo);
  const immune = stringList(damageable.immuneDamageTypes ?? damageable.immuneTo);
  if (immune.includes("*") || immune.includes(damageType)) return false;
  return allowed.length === 0 || allowed.includes("*") || allowed.includes(damageType);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim().toLowerCase()).filter(Boolean) : [];
}

function samePosition(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) < 0.0001 && Math.abs(a.y - b.y) < 0.0001;
}

function roundCoord(value: number): number {
  return Number(value.toFixed(3));
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function normalizeEntityId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}
