import { EventBus } from "./eventBus";
import { SeededRng } from "./rng";
import type {
  DeepPartial,
  EffectDefinitions,
  EntityDefinitions,
  EntityRuntimeComponents,
  ItemDefinitions,
  ItemRuntimeComponents,
  UnknownObject,
} from "../domain/componentTypes";
import type { Entity, ItemInstance } from "./types";
import type { SimEvent } from "./net/events";
import { deepClone, deepMerge, initEntityRuntimeState, initItemRuntimeState } from "./utils";
import { DamageService, InventoryService, SpatialService } from "./services";
import type { CollisionBox } from "./services";

export type { AddInventoryItemOptions, CollisionBox, MoveOptions } from "./services";

export interface CreateEntityOptions {
  entityId?: string;
  name?: string;
  position?: { x: number; y: number };
  overrides?: DeepPartial<EntityRuntimeComponents>;
}

export interface GameServices {
  inventory: InventoryService;
  spatial: SpatialService;
  damage: DamageService;
}

export class World {
  readonly width = 16;
  readonly height = 12;
  readonly defaultEntityRadius = 0.35;
  readonly selectionRadius = 0.45;
  /** 模拟频率：固定步长，确定性推进。 */
  readonly tickRateHz = 30;
  /** 单 tick 的逻辑时长（毫秒）。所有 nowMs() 派生时间都基于它。 */
  readonly tickIntervalMs = 1000 / 30;
  /** 已推进的模拟 tick 数。权威时间来源。 */
  currentTick = 0;
  /** 确定性随机源。游戏逻辑禁止直接用 Math.random，一律走 world.rng。 */
  readonly rng: SeededRng;
  readonly effects: EffectDefinitions;
  readonly itemPrototypes: ItemDefinitions;
  readonly customItemPrototypes: ItemDefinitions = {};
  readonly entityPrototypes: EntityDefinitions;
  readonly bus = new EventBus();
  readonly entities: Record<string, Entity> = {};
  readonly items: Record<string, ItemInstance> = {};
  /**
   * 每 tick 临时事件缓冲：权威模拟产出的领域事实。
   * 服务端每 tick 抽干随 snapshot 下行；客户端 PresentationDeriver 据此派生表现。
   * 不进 snapshot（瞬时缓冲，非持久状态）。
   */
  readonly simEvents: SimEvent[] = [];
  readonly systems: Array<{ update?: () => void }> = [];
  readonly services: GameServices;

  /**
   * 历史位置环（服务端专用，docs/networking.md §4.3 延迟补偿）：tick → 各实体位置。
   * 仅服务端 ServerSession 写入；不进 snapshot（客户端用不到）。
   */
  readonly positionHistory = new Map<number, Map<string, { x: number; y: number }>>();
  /** 当前正在处理的命令所携带的客户端 tick；发射体据此打 firedAtClientTick。服务端专用。 */
  activeCommandClientTick: number | null = null;

  private nextItemNo = 1;
  private nextEntityNo = 1;

  constructor(effects: EffectDefinitions, itemPrototypes: ItemDefinitions, entityPrototypes: EntityDefinitions = {}, seed = 0x9e3779b9) {
    this.effects = effects;
    this.itemPrototypes = itemPrototypes;
    this.entityPrototypes = entityPrototypes;
    this.rng = new SeededRng(seed);
    this.services = {
      inventory: new InventoryService(this),
      spatial: new SpatialService(this),
      damage: new DamageService(this),
    };
  }

  /** 产出一条领域事件（权威事实）。表现由客户端从这些事件本地派生。 */
  emitSim(event: SimEvent): void {
    this.simEvents.push(event);
  }

  /** 抽干本 tick 累积的领域事件并清空缓冲。 */
  drainSimEvents(): SimEvent[] {
    return this.simEvents.splice(0, this.simEvents.length);
  }

  /**
   * 生成计数器快照。nextItemNo / nextEntityNo 决定后续生成的 id，
   * 是权威状态，必须随 snapshot 同步，否则两端生成的 id 会发散。
   */
  get counters(): { nextItemNo: number; nextEntityNo: number } {
    return { nextItemNo: this.nextItemNo, nextEntityNo: this.nextEntityNo };
  }

  /** 从 snapshot 恢复生成计数器。 */
  setCounters(counters: { nextItemNo: number; nextEntityNo: number }): void {
    this.nextItemNo = counters.nextItemNo;
    this.nextEntityNo = counters.nextEntityNo;
  }

  /**
   * 逻辑时间（毫秒），由 currentTick 派生而非墙钟。
   * 保证同样的 tick 序列在任意机器上得到相同的时间，是确定性模拟的基础。
   */
  nowMs(): number {
    return this.currentTick * this.tickIntervalMs;
  }

  /**
   * 记录一条叙事日志。
   * 现在作为领域事件下发（日志是权威叙事事实，非像素 VFX），
   * 客户端从事件流派生到日志面板。保留方法签名，约 50 处调用点不变。
   */
  log(message: string): void {
    this.emitSim({ type: "log", text: message });
  }

  addEntity(entity: Entity): void {
    initEntityRuntimeState(entity);
    this.entities[entity.entityId] = entity;
  }

  createEntity(protoId: string, options: CreateEntityOptions = {}): Entity {
    const proto = this.entityPrototypes[protoId];
    if (!proto) throw new Error(`未知实体原型：${protoId}`);
    const components = deepMerge(deepClone(proto.components ?? {}), (options.overrides ?? {}) as UnknownObject) as EntityRuntimeComponents;
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
    return this.createCustomItem(protoId, deepClone(proto.components ?? {}) as ItemRuntimeComponents);
  }

  createCustomItem(protoId: string, components: ItemRuntimeComponents): ItemInstance {
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

  giveCustomItem(entityId: string, protoId: string, components: ItemRuntimeComponents): ItemInstance {
    const item = this.createCustomItem(protoId, components);
    return this.services.inventory.addItem(entityId, item, { verb: "获得自定义物品" });
  }

  tick(): void {
    this.currentTick += 1;
    for (const system of this.systems) system.update?.();
    this.removeDeadEntities();
  }

  /**
   * 记录当前 tick 各实体位置进历史环（服务端在每 tick 后调用），并裁剪到 maxTicks。
   * 供命中判定回溯目标在客户端 tick 时的位置。
   */
  recordPositionHistory(maxTicks = 32): void {
    const positions = new Map<string, { x: number; y: number }>();
    for (const entity of Object.values(this.entities)) {
      const position = entity.components.position;
      if (position) positions.set(entity.entityId, { x: position.x, y: position.y });
    }
    this.positionHistory.set(this.currentTick, positions);
    const cutoff = this.currentTick - maxTicks;
    for (const tick of this.positionHistory.keys()) {
      if (tick < cutoff) this.positionHistory.delete(tick);
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
      this.emitSim({ type: "died", entityId: entity.entityId, x: position?.x ?? 0, y: position?.y ?? 0 });
      this.removeEntity(entity.entityId, entity.components.obstacle ? "被摧毁" : "生命归零并消失");
    }
  }
}

function normalizeEntityId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}
