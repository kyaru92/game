
import type { EventData } from "../types";
import type { World } from "../world";
import { describeTarget, displayItemName } from "../utils";
import { roundCoord } from "./common";

export class TeleportSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("OnItemActivation", (event) => this.onItemActivation(event));
  }

  private onItemActivation(event: EventData<"OnItemActivation">): void {
    const item = this.world.items[event.data.itemId];
    const teleporter = item.components.teleporter;
    if (!teleporter) return;
    const target = event.data.target;
    if (target.kind !== "position" || !target.position) {
      this.world.log(`${displayItemName(item)} 需要位置目标。`);
      return;
    }
    const actor = this.world.entities[event.data.actorId];
    if (!actor) return;
    const from = actor.components.position ?? { x: 0, y: 0 };
    const [x, y] = target.position;
    if (!this.world.services.spatial.canEntityOccupy(actor.entityId, x, y)) {
      const occupying = this.world.services.spatial.blockingEntityFor(actor.entityId, x, y);
      this.world.log(occupying ? `${occupying.name} 占据了闪现目标。` : "闪现目标不可到达。");
      return;
    }
    actor.components.position = { x: roundCoord(x), y: roundCoord(y) };
    this.world.services.vfx.addTeleportTrail([from.x, from.y], [x, y]);
    this.world.log(`${actor.name} 闪现到 ${describeTarget(this.world, target)}。`);
  }
}
