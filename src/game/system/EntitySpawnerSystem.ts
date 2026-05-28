
import type { DeepPartial, EntityRuntimeComponents } from "../../domain/componentTypes";
import type { EventData } from "../types";
import type { World } from "../world";
import { displayItemName } from "../utils";

export class EntitySpawnerSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("OnItemActivation", (event) => this.onItemActivation(event));
  }

  private onItemActivation(event: EventData<"OnItemActivation">): void {
    const item = this.world.items[event.data.itemId];
    const spawner = item.components.entity_spawner;
    if (!spawner) return;

    const target = event.data.target;
    if (target.kind !== "position" || !target.position) {
      this.world.log(`${displayItemName(item)} 需要位置目标。`);
      return;
    }

    const [x, y] = target.position;
    if (!this.world.services.spatial.isInside(x, y, this.world.defaultEntityRadius)) {
      this.world.log("生成目标超出地图。");
      return;
    }
    if (!spawner.allowBlocked && this.world.services.spatial.isBlocked(x, y)) {
      this.world.log("生成目标是障碍物，无法孵化。");
      return;
    }
    const occupying = this.world.services.spatial.entityAt(x, y, this.world.defaultEntityRadius);
    if (!spawner.allowOccupied && occupying) {
      this.world.log(`${occupying.name} 占据了生成位置，无法孵化。`);
      return;
    }

    const entity = this.world.createEntity(spawner.prototype, {
      entityId: spawner.entityId,
      name: spawner.name,
      position: { x, y },
      overrides: (spawner.overrides ?? {}) as DeepPartial<EntityRuntimeComponents>,
    });
    const color = String(spawner.color ?? entity.components.display?.color ?? "#fb923c");
    this.world.services.vfx.addBurst(entity.entityId, color);
    this.world.services.vfx.addFloatingText(entity.entityId, entity.name, color);
    this.world.log(`${this.world.entityName(event.data.actorId)} 使用 ${displayItemName(item)}，在 (${x},${y}) 生成 ${entity.name}。`);
  }
}
