import type { ItemInstance } from "../types";
import type { World } from "../world";
import { displayItemName, isEquipmentItem, itemCategory } from "../utils";

export interface AddInventoryItemOptions {
  verb?: string;
  merge?: boolean;
  autoHotbar?: boolean;
  log?: boolean;
}

export class InventoryService {
  constructor(private readonly world: World) {}

  get(entityId = "player"): string[] {
    const entity = this.world.entities[entityId];
    if (!entity) return [];
    entity.components.inventory ??= [];
    return entity.components.inventory;
  }

  itemAt(entityId: string, inventoryIndex: number): string | undefined {
    return this.get(entityId)[inventoryIndex];
  }

  indexOf(entityId: string, itemId: string): number {
    return this.get(entityId).indexOf(itemId);
  }

  has(entityId: string, itemId: string): boolean {
    return this.get(entityId).includes(itemId);
  }

  hotbar(entityId = "player"): Array<string | null> {
    const entity = this.world.entities[entityId];
    if (!entity) return [];
    const inventory = this.get(entityId);
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
      if (typeof itemId !== "string" || !inventory.includes(itemId) || !this.world.items[itemId]) slots[index] = null;
    }
    return slots;
  }

  setHotbarSlot(entityId: string, slotIndex: number, itemId: string | null): boolean {
    const slots = this.hotbar(entityId);
    if (slotIndex < 0 || slotIndex >= slots.length) {
      this.world.log(`快捷栏槽位不存在：${slotIndex + 1}`);
      return false;
    }
    if (itemId && (!this.world.items[itemId] || !this.has(entityId, itemId))) {
      this.world.log(`不能把不在背包中的物品放入快捷栏：${itemId}`);
      return false;
    }
    if (itemId && !this.world.items[itemId].components.activation && !isEquipmentItem(this.world.items[itemId])) {
      this.world.log(`${displayItemName(this.world.items[itemId])} 不能放入快捷栏。`);
      return false;
    }
    slots[slotIndex] = itemId;
    return true;
  }

  equipItem(entityId: string, itemId: string): boolean {
    const entity = this.world.entities[entityId];
    if (!entity || !this.world.items[itemId] || !this.has(entityId, itemId)) {
      this.world.log(`不能装备不在背包中的物品：${itemId}`);
      return false;
    }
    entity.components.loadout ??= {};
    entity.components.loadout.activeItemId = itemId;
    return true;
  }

  activeItemId(entityId = "player"): string | undefined {
    const entity = this.world.entities[entityId];
    const itemId = entity?.components.loadout?.activeItemId;
    if (typeof itemId !== "string") return undefined;
    if (this.world.items[itemId] && this.has(entityId, itemId)) return itemId;
    if (entity?.components.loadout) delete entity.components.loadout.activeItemId;
    return undefined;
  }

  addItem(entityId: string, item: ItemInstance, options: AddInventoryItemOptions = {}): ItemInstance {
    const verb = options.verb ?? "获得";
    const shouldLog = options.log ?? true;
    const receivedText = stackDisplaySuffix(item);
    if (options.merge ?? true) {
      const merged = this.tryMergeStack(entityId, item);
      if (merged) {
        delete this.world.items[item.instanceId];
        if (shouldLog) this.world.log(`${this.world.entityName(entityId)} ${verb}：${displayItemName(merged)}${receivedText}。`);
        return merged;
      }
    }
    this.get(entityId).push(item.instanceId);
    if (options.autoHotbar ?? true) this.autoHotbarItem(entityId, item.instanceId);
    if (shouldLog) this.world.log(`${this.world.entityName(entityId)} ${verb}：${displayItemName(item)}${receivedText}。`);
    return item;
  }

  removeItem(entityId: string, itemId: string): void {
    const inventory = this.get(entityId);
    const index = inventory.indexOf(itemId);
    if (index >= 0) inventory.splice(index, 1);
    this.clearItemReferences(entityId, itemId);
    delete this.world.items[itemId];
  }

  organize(entityId: string): void {
    const inventory = this.get(entityId);
    const beforeCount = inventory.length;
    let mergedCount = 0;

    for (let i = 0; i < inventory.length; i += 1) {
      const itemId = inventory[i];
      const item = this.world.items[itemId];
      if (!item || !canManualMerge(item)) continue;
      for (let j = i + 1; j < inventory.length; j += 1) {
        const otherId = inventory[j];
        const other = this.world.items[otherId];
        if (!other || other.protoId !== item.protoId || !canManualMerge(other)) continue;
        const space = stackMax(item) - stackQuantity(item);
        if (space <= 0) break;
        const otherQuantity = stackQuantity(other);
        const moved = Math.min(space, otherQuantity);
        const remaining = otherQuantity - moved;
        item.components.stacking ??= {};
        other.components.stacking ??= {};
        item.components.stacking.quantity = stackQuantity(item) + moved;
        other.components.stacking.quantity = remaining;
        if (remaining <= 0) {
          inventory.splice(j, 1);
          this.clearItemReferences(entityId, otherId);
          delete this.world.items[otherId];
          mergedCount += 1;
          j -= 1;
        }
      }
    }

    inventory.sort((a, b) => compareInventoryItems(this.world.items[a], this.world.items[b]));
    this.world.log(`${this.world.entityName(entityId)} 整理背包：${beforeCount} -> ${inventory.length} 格，合并 ${mergedCount} 组。`);
  }

  private autoHotbarItem(entityId: string, itemId: string): void {
    const item = this.world.items[itemId];
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
    const entity = this.world.entities[entityId];
    if (entity?.components.loadout?.activeItemId === itemId) delete entity.components.loadout.activeItemId;
  }

  private tryMergeStack(entityId: string, item: ItemInstance): ItemInstance | undefined {
    let remaining = stackQuantity(item);
    const max = stackMax(item);
    if (max <= 1 || remaining <= 0 || item.components.activation) return undefined;
    let lastMerged: ItemInstance | undefined;
    for (const itemId of this.get(entityId)) {
      const existing = this.world.items[itemId];
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
}

export function stackMax(item: ItemInstance): number {
  return Math.max(1, Number(item.components.stacking?.max ?? 1));
}

export function stackQuantity(item: ItemInstance): number {
  return Math.max(0, Number(item.components.stacking?.quantity ?? 1));
}

function stackDisplaySuffix(item: ItemInstance): string {
  const max = stackMax(item);
  return max > 1 ? ` ×${stackQuantity(item)}` : "";
}

function canManualMerge(item: ItemInstance): boolean {
  return stackMax(item) > 1 && !item.components.activation;
}

function compareInventoryItems(a: ItemInstance | undefined, b: ItemInstance | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const groupDelta = inventoryGroup(a) - inventoryGroup(b);
  if (groupDelta !== 0) return groupDelta;
  const nameDelta = displayItemName(a).localeCompare(displayItemName(b), "zh-CN");
  if (nameDelta !== 0) return nameDelta;
  return a.instanceId.localeCompare(b.instanceId);
}

function inventoryGroup(item: ItemInstance): number {
  const category = itemCategory(item);
  if (category === "equipment") return 0;
  if (category === "consumable") return 1;
  if (category === "ammo") return 2;
  if (category === "material") return 3;
  return 4;
}
