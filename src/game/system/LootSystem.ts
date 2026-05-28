import type { LootComponent, LootContainerRuntime, LootEntry, LootGuaranteeEntry } from "../../domain/componentTypes";
import type { Entity, EventData, ItemInstance } from "../types";
import type { World } from "../world";
import { displayItemName, itemCategory } from "../utils";

const DEFAULT_CONTAINER_PROTO_ID = "loot-crate";
const DEFAULT_INTERACTION_RANGE = 1.2;
const DEFAULT_SEARCH_DURATION_MS = 1200;
const SEARCH_DURATION_RANDOM_MIN = 0.75;
const SEARCH_DURATION_RANDOM_MAX = 1.35;

export interface RevealedLootItemView {
  itemId: string;
  name: string;
  description: string;
  category: string;
  protoId: string;
  quantity?: number;
  canTake: boolean;
}

export interface LootContainerView {
  containerId: string;
  title: string;
  isSearching: boolean;
  canSearchNext: boolean;
  hasMoreUnknownItems: boolean;
  revealedItems: RevealedLootItemView[];
}

interface GeneratedLoot {
  protoId: string;
  quantity?: number;
}

export class LootSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("OnEntityDeath", (event) => this.onEntityDeath(event));
  }

  update(): void {
    const now = this.world.nowMs();
    for (const entity of Object.values(this.world.entities)) {
      const container = lootContainer(entity);
      const current = container?.currentSearch;
      if (!container || !current || now < current.finishAtMs) continue;
      this.revealCurrentSearch(entity, container);
    }
  }

  nearestContainer(actorId: string): Entity | undefined {
    const actor = this.world.entities[actorId];
    const actorPosition = actor?.components.position;
    if (!actor || !actorPosition) return undefined;

    let nearest: Entity | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const entity of Object.values(this.world.entities)) {
      const container = lootContainer(entity);
      if (!container) continue;
      const position = entity.components.position;
      if (!position) continue;
      const range = interactionRange(entity);
      const distance = Math.hypot(actorPosition.x - position.x, actorPosition.y - position.y);
      if (distance > range || distance >= nearestDistance) continue;
      nearest = entity;
      nearestDistance = distance;
    }
    return nearest;
  }

  canInteract(actorId: string, containerId: string): boolean {
    const actorPosition = this.world.entities[actorId]?.components.position;
    const container = this.world.entities[containerId];
    const containerPosition = container?.components.position;
    if (!actorPosition || !container || !containerPosition || !lootContainer(container)) return false;
    return Math.hypot(actorPosition.x - containerPosition.x, actorPosition.y - containerPosition.y) <= interactionRange(container);
  }

  beginAutoSearch(actorId: string, containerId: string): boolean {
    const containerEntity = this.world.entities[containerId];
    const container = containerEntity ? lootContainer(containerEntity) : undefined;
    if (!containerEntity || !container) {
      this.world.log("找不到可搜索的箱子。");
      return false;
    }
    if (!this.canInteract(actorId, containerId)) {
      this.world.log("距离箱子太远，无法搜索。");
      return false;
    }
    if (container.currentSearch) return true;
    if (!container.hiddenItemIds.some((itemId) => Boolean(this.world.items[itemId]))) return false;
    return this.startSearchNext(actorId, containerId);
  }

  startSearchNext(actorId: string, containerId: string): boolean {
    const containerEntity = this.world.entities[containerId];
    const container = containerEntity ? lootContainer(containerEntity) : undefined;
    if (!containerEntity || !container) {
      this.world.log("找不到可搜索的箱子。");
      return false;
    }
    if (!this.canInteract(actorId, containerId)) {
      this.world.log("距离箱子太远，无法搜索。");
      return false;
    }
    if (this.isActorSearching(actorId)) {
      this.world.log(`${this.world.entityName(actorId)} 已经在搜索。`);
      return false;
    }
    if (container.currentSearch) {
      this.world.log("这个箱子正在被搜索。");
      return false;
    }
    const itemId = container.hiddenItemIds[0];
    if (!itemId) return false;
    const item = this.world.items[itemId];
    if (!item) {
      container.hiddenItemIds.shift();
      return this.startSearchNext(actorId, containerId);
    }

    const durationMs = searchDurationMs(item);
    const now = this.world.nowMs();
    container.currentSearch = {
      actorId,
      itemId,
      startedAtMs: now,
      finishAtMs: now + durationMs,
      durationMs,
    };
    this.world.log(`${this.world.entityName(actorId)} 开始搜索 ${container.title ?? containerEntity.name}……`);
    return true;
  }

  cancelSearch(actorId: string, containerId?: string, reason = "搜索已中断"): boolean {
    const entities = containerId ? [this.world.entities[containerId]].filter((entity): entity is Entity => Boolean(entity)) : Object.values(this.world.entities);
    for (const entity of entities) {
      const container = lootContainer(entity);
      if (!container?.currentSearch || container.currentSearch.actorId !== actorId) continue;
      delete container.currentSearch;
      this.world.log(`${this.world.entityName(actorId)} ${reason}，当前搜索进度已重置。`);
      return true;
    }
    return false;
  }

  isActorSearching(actorId: string): boolean {
    return Object.values(this.world.entities).some((entity) => lootContainer(entity)?.currentSearch?.actorId === actorId);
  }

  takeRevealedItem(actorId: string, containerId: string, itemId: string): boolean {
    const containerEntity = this.world.entities[containerId];
    const container = containerEntity ? lootContainer(containerEntity) : undefined;
    if (!containerEntity || !container) {
      this.world.log("找不到箱子。");
      return false;
    }
    if (!this.canInteract(actorId, containerId)) {
      this.world.log("距离箱子太远，无法拿取。");
      return false;
    }
    const index = container.revealedItemIds.indexOf(itemId);
    if (index < 0) {
      this.world.log("该物品尚未被搜索出来，无法拿取。");
      return false;
    }
    const item = this.world.items[itemId];
    if (!item) {
      container.revealedItemIds.splice(index, 1);
      return false;
    }

    container.revealedItemIds.splice(index, 1);
    this.world.services.inventory.addItem(actorId, item, { verb: "拾取", merge: false, autoHotbar: false });
    this.removeContainerIfEmpty(containerEntity, container);
    return true;
  }

  containerView(actorId: string, containerId: string): LootContainerView | undefined {
    const containerEntity = this.world.entities[containerId];
    const container = containerEntity ? lootContainer(containerEntity) : undefined;
    if (!containerEntity || !container) return undefined;
    const inRange = this.canInteract(actorId, containerId);
    return {
      containerId,
      title: container.title ?? containerEntity.name,
      isSearching: Boolean(container.currentSearch),
      canSearchNext: inRange && !container.currentSearch && container.hiddenItemIds.some((itemId) => Boolean(this.world.items[itemId])),
      hasMoreUnknownItems: container.hiddenItemIds.some((itemId) => Boolean(this.world.items[itemId])) || Boolean(container.currentSearch),
      revealedItems: container.revealedItemIds.map((itemId) => this.revealedItemView(itemId, inRange)).filter((item): item is RevealedLootItemView => Boolean(item)),
    };
  }

  private onEntityDeath(event: EventData<"OnEntityDeath">): void {
    const entity = event.data.entity;
    if (entity.entityId === "player") return;
    const loot = entity.components.loot;
    if (!loot) return;

    const spawnChance = clamp01(Number(loot.spawnChance ?? 1));
    if (Math.random() > spawnChance) return;

    const position = event.data.position;
    if (!position) return;

    const generated = this.rollLoot(loot);
    if (!generated.length) return;

    const containerProtoId = loot.containerPrototype ?? DEFAULT_CONTAINER_PROTO_ID;
    if (!this.world.entityPrototypes[containerProtoId]) {
      this.world.log(`${entity.name} 的 loot.containerPrototype 不存在：${containerProtoId}`);
      return;
    }

    const spawnPosition = this.findContainerPosition(containerProtoId, position, event.data.bounds);
    const container = this.world.createEntity(containerProtoId, {
      position: spawnPosition,
      overrides: {
        loot_container: {
          title: `${entity.name} 的掉落箱`,
          sourceEntityId: entity.entityId,
          sourceEntityName: entity.name,
          createdAtMs: this.world.nowMs(),
          hiddenItemIds: [],
          revealedItemIds: [],
        },
      },
    });
    const runtime = lootContainer(container);
    if (!runtime) return;

    runtime.hiddenItemIds = generated.map((entry) => this.createLootItem(entry).instanceId);
    this.world.services.vfx.addBurst(container.entityId, String(container.components.display?.color ?? "#f59e0b"));
    this.world.services.vfx.addFloatingText(container.entityId, "掉落箱", "#facc15");
    this.world.log(`${entity.name} 掉落了一个箱子。`);
  }

  private findContainerPosition(containerProtoId: string, origin: { x: number; y: number }, sourceBounds?: { width?: number; height?: number }): { x: number; y: number } {
    const probe = this.world.createEntity(containerProtoId, { position: origin, overrides: { collision: { blocksMovement: false } } });
    const probeId = probe.entityId;
    const sourceRadius = Math.max(Number(sourceBounds?.width ?? 0), Number(sourceBounds?.height ?? 0)) / 2;
    const offsets = [
      [0, 0],
      [sourceRadius + 0.65, 0],
      [-(sourceRadius + 0.65), 0],
      [0, sourceRadius + 0.65],
      [0, -(sourceRadius + 0.65)],
      [sourceRadius + 0.65, sourceRadius + 0.65],
      [-(sourceRadius + 0.65), sourceRadius + 0.65],
      [sourceRadius + 0.65, -(sourceRadius + 0.65)],
      [-(sourceRadius + 0.65), -(sourceRadius + 0.65)],
    ];
    for (const [dx, dy] of offsets) {
      const x = origin.x + dx;
      const y = origin.y + dy;
      if (!this.world.services.spatial.isInside(x, y, 0.45)) continue;
      if (this.world.services.spatial.canEntityOccupy(probeId, x, y)) {
        delete this.world.entities[probeId];
        return { x, y };
      }
    }
    delete this.world.entities[probeId];
    return origin;
  }

  private rollLoot(loot: LootComponent): GeneratedLoot[] {
    const generated: GeneratedLoot[] = [];
    for (const entry of loot.entries ?? []) {
      if (Math.random() > clamp01(Number(entry.chance ?? 1))) continue;
      generated.push(this.generatedLoot(entry));
    }

    const guarantee = loot.guarantee;
    const minItems = Math.max(1, Math.floor(Number(guarantee?.minItems ?? 1)));
    const pool = guarantee?.pool ?? [];
    while (generated.length < minItems && pool.length) {
      const picked = weightedPick(pool);
      if (!picked) break;
      generated.push(this.generatedLoot(picked));
    }
    return generated;
  }

  private generatedLoot(entry: LootEntry | LootGuaranteeEntry): GeneratedLoot {
    return {
      protoId: entry.item,
      quantity: rollQuantity(entry.quantity),
    };
  }

  private createLootItem(entry: GeneratedLoot): ItemInstance {
    const item = this.world.createItem(entry.protoId);
    if (entry.quantity !== undefined && item.components.stacking) {
      const max = Math.max(1, Number(item.components.stacking.max ?? entry.quantity));
      item.components.stacking.quantity = Math.max(1, Math.min(max, entry.quantity));
    }
    return item;
  }

  private revealCurrentSearch(containerEntity: Entity, container: LootContainerRuntime): void {
    const current = container.currentSearch;
    if (!current) return;
    delete container.currentSearch;
    const hiddenIndex = container.hiddenItemIds.indexOf(current.itemId);
    if (hiddenIndex >= 0) container.hiddenItemIds.splice(hiddenIndex, 1);
    if (this.world.items[current.itemId] && !container.revealedItemIds.includes(current.itemId)) {
      container.revealedItemIds.push(current.itemId);
      const item = this.world.items[current.itemId];
      this.world.log(`${this.world.entityName(current.actorId)} 搜索完成：发现 ${displayItemName(item)}。`);
    }
    if (container.hiddenItemIds.some((itemId) => Boolean(this.world.items[itemId])) && this.canInteract(current.actorId, containerEntity.entityId)) {
      this.beginAutoSearch(current.actorId, containerEntity.entityId);
      return;
    }
    this.removeContainerIfEmpty(containerEntity, container);
  }

  private revealedItemView(itemId: string, canTake: boolean): RevealedLootItemView | undefined {
    const item = this.world.items[itemId];
    if (!item) return undefined;
    const stacking = item.components.stacking;
    const quantity = stacking && Number(stacking.max ?? 1) > 1 ? Number(stacking.quantity ?? 1) : undefined;
    return {
      itemId,
      name: displayItemName(item),
      description: String(item.components.display?.description ?? item.protoId),
      category: itemCategory(item),
      protoId: item.protoId,
      quantity,
      canTake,
    };
  }

  private removeContainerIfEmpty(containerEntity: Entity, container: LootContainerRuntime): void {
    const hasHidden = container.hiddenItemIds.some((itemId) => Boolean(this.world.items[itemId]));
    const hasRevealed = container.revealedItemIds.some((itemId) => Boolean(this.world.items[itemId]));
    if (!hasHidden && !hasRevealed && !container.currentSearch) this.world.removeEntity(containerEntity.entityId, "已被搜空并消失");
  }
}

function lootContainer(entity: Entity | undefined): LootContainerRuntime | undefined {
  return entity?.components.loot_container;
}

function interactionRange(entity: Entity): number {
  return Math.max(0, Number(entity.components.interactable?.range ?? DEFAULT_INTERACTION_RANGE));
}

function searchDurationMs(item: ItemInstance): number {
  const configured = Number(item.components.searchable?.searchDurationMs ?? DEFAULT_SEARCH_DURATION_MS);
  const base = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_SEARCH_DURATION_MS;
  const factor = SEARCH_DURATION_RANDOM_MIN + Math.random() * (SEARCH_DURATION_RANDOM_MAX - SEARCH_DURATION_RANDOM_MIN);
  return Math.max(0, Math.round(base * factor));
}

function rollQuantity(quantity: LootEntry["quantity"] | LootGuaranteeEntry["quantity"]): number | undefined {
  if (!quantity) return undefined;
  const min = Math.max(1, Math.floor(Number(quantity.min ?? 1)));
  const max = Math.max(min, Math.floor(Number(quantity.max ?? min)));
  return min + Math.floor(Math.random() * (max - min + 1));
}

function weightedPick<T extends { weight?: number }>(items: readonly T[]): T | undefined {
  const weighted = items.map((item) => ({ item, weight: Math.max(0, Number(item.weight ?? 0)) })).filter((entry) => entry.weight > 0);
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return undefined;
  let roll = Math.random() * total;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll <= 0) return entry.item;
  }
  return weighted[weighted.length - 1]?.item;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
