import { EventBus } from "./eventBus";
import type { EffectDefinitions, EntityDefinitions, ItemDefinitions } from "../domain/componentTypes";
import type { Entity, ItemInstance, JsonObj, VisualEvent } from "./types";
import { deepClone, deepMerge, initEntityRuntimeState, initItemRuntimeState } from "./utils";
import { DamageService, InventoryService, SpatialService, VisualEventService } from "./services";
import type { AddInventoryItemOptions, CollisionBox, MoveOptions } from "./services";

export type { AddInventoryItemOptions, CollisionBox, MoveOptions } from "./services";

export interface CreateEntityOptions {
  entityId?: string;
  name?: string;
  position?: { x: number; y: number };
  overrides?: JsonObj;
}

export interface GameServices {
  inventory: InventoryService;
  spatial: SpatialService;
  damage: DamageService;
  vfx: VisualEventService;
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
  readonly services: GameServices;

  private nextItemNo = 1;
  private nextVisualNo = 1;
  private nextEntityNo = 1;

  constructor(effects: EffectDefinitions, itemPrototypes: ItemDefinitions, entityPrototypes: EntityDefinitions = {}) {
    this.effects = effects;
    this.itemPrototypes = itemPrototypes;
    this.entityPrototypes = entityPrototypes;
    this.services = {
      inventory: new InventoryService(this),
      spatial: new SpatialService(this),
      damage: new DamageService(this),
      vfx: new VisualEventService(this),
    };
  }

  get inventoryService(): InventoryService {
    return this.services.inventory;
  }

  get spatial(): SpatialService {
    return this.services.spatial;
  }

  get damage(): DamageService {
    return this.services.damage;
  }

  get vfx(): VisualEventService {
    return this.services.vfx;
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

  nextVisualId(): number {
    return this.nextVisualNo++;
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
    return this.services.inventory.addItem(entityId, item, { verb: "获得" });
  }

  giveCustomItem(entityId: string, protoId: string, components: JsonObj): ItemInstance {
    const item = this.createCustomItem(protoId, components);
    return this.services.inventory.addItem(entityId, item, { verb: "获得自定义物品" });
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
      const position = entity.components.position ? { ...entity.components.position } : undefined;
      const bounds = this.services.spatial.entityBounds(entity);
      this.bus.emit("OnEntityDeath", { entityId: entity.entityId, entity, position, bounds });
      this.services.vfx.addBurst(entity.entityId, "#f43f5e");
      this.removeEntity(entity.entityId, entity.components.obstacle ? "被摧毁" : "生命归零并消失");
    }
  }

  /** Compatibility wrappers. New game logic should prefer world.services.* directly. */
  inventory(entityId = "player"): string[] {
    return this.services.inventory.get(entityId);
  }

  hotbar(entityId = "player"): Array<string | null> {
    return this.services.inventory.hotbar(entityId);
  }

  setHotbarSlot(entityId: string, slotIndex: number, itemId: string | null): boolean {
    return this.services.inventory.setHotbarSlot(entityId, slotIndex, itemId);
  }

  equipItem(entityId: string, itemId: string): boolean {
    return this.services.inventory.equipItem(entityId, itemId);
  }

  activeItemId(entityId = "player"): string | undefined {
    return this.services.inventory.activeItemId(entityId);
  }

  addInventoryItem(entityId: string, item: ItemInstance, options: AddInventoryItemOptions = {}): ItemInstance {
    return this.services.inventory.addItem(entityId, item, options);
  }

  removeInventoryItem(entityId: string, itemId: string): void {
    this.services.inventory.removeItem(entityId, itemId);
  }

  organizeInventory(entityId: string): void {
    this.services.inventory.organize(entityId);
  }

  isInside(x: number, y: number, radius = 0): boolean {
    return this.services.spatial.isInside(x, y, radius);
  }

  isBlocked(x: number, y: number): boolean {
    return this.services.spatial.isBlocked(x, y);
  }

  entityBounds(entity: Entity, position = entity.components.position ?? { x: 0, y: 0 }): CollisionBox {
    return this.services.spatial.entityBounds(entity, position);
  }

  entityRadius(entity: Entity): number {
    return this.services.spatial.entityRadius(entity);
  }

  entityAt(x: number, y: number, padding = this.selectionRadius, exceptEntityId?: string): Entity | undefined {
    return this.services.spatial.entityAt(x, y, padding, exceptEntityId);
  }

  canEntityOccupy(entityId: string, x: number, y: number): boolean {
    return this.services.spatial.canEntityOccupy(entityId, x, y);
  }

  blockingEntityFor(entityId: string, x: number, y: number): Entity | undefined {
    return this.services.spatial.blockingEntityFor(entityId, x, y);
  }

  applyDamage(entityId: string, amount: number, damageType = "generic", sourceName = "伤害"): boolean {
    return this.services.damage.applyDamage(entityId, amount, damageType, sourceName);
  }

  tryMove(entityId: string, dx: number, dy: number, options: MoveOptions = {}): boolean {
    return this.services.spatial.tryMove(entityId, dx, dy, options);
  }

  addFloatingText(entityId: string, text: string, color: string): void {
    this.services.vfx.addFloatingText(entityId, text, color);
  }

  addBurst(entityId: string, color: string): void {
    this.services.vfx.addBurst(entityId, color);
  }

  addTeleportTrail(from: [number, number], to: [number, number]): void {
    this.services.vfx.addTeleportTrail(from, to);
  }
}

function normalizeEntityId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}
