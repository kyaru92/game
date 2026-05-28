
import type { EventData } from "../types";
import type { World } from "../world";
import { displayItemName } from "../utils";
import { cloneOptional } from "./common";
import { launchProjectile, projectileConfigFromLauncher } from "./projectiles";

export class ProjectileLauncherSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("OnItemActivation", (event) => this.onItemActivation(event));
  }

  private onItemActivation(event: EventData<"OnItemActivation">): void {
    const item = this.world.items[event.data.itemId];
    const launcher = item?.components.projectile_launcher;
    if (!item || !launcher) return;

    launchProjectile(this.world, {
      sourceEntityId: event.data.actorId,
      sourceItemId: item.instanceId,
      target: event.data.target,
      displayName: displayItemName(item),
      color: String(launcher.color ?? "#f8fafc"),
      glyph: String(launcher.glyph ?? "•"),
      radius: Number(launcher.radius ?? 0.09),
      payload: {
        projectile: projectileConfigFromLauncher(launcher),
        damage_applier: cloneOptional(launcher.damage_applier ?? item.components.damage_applier),
        effect_applier: cloneOptional(launcher.effect_applier ?? item.components.effect_applier),
        impactRadius: launcher.impactRadius,
      },
    });
  }
}
