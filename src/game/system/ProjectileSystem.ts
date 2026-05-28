
import type { Entity, Target } from "../types";
import type { World } from "../world";
import { roundCoord } from "./common";
import { applyProjectilePayload, findProjectileHit } from "./projectiles";

export class ProjectileSystem {
  constructor(private readonly world: World) {}

  update(): void {
    const now = this.world.nowMs();
    for (const entity of Object.values(this.world.entities)) {
      if (!entity.components.projectile) continue;
      this.updateProjectile(entity, now);
    }
  }

  private updateProjectile(entity: Entity, now: number): void {
    const projectile = entity.components.projectile;
    if (!projectile) return;
    const position = entity.components.position ?? { x: 0, y: 0 };
    const lastUpdateMs = Number(projectile.lastUpdateMs ?? now);
    projectile.lastUpdateMs = now;
    const deltaSeconds = Math.min(0.05, Math.max(0, (now - lastUpdateMs) / 1000));
    if (deltaSeconds <= 0) return;

    const speed = Math.max(0, Number(projectile.speed ?? 0));
    const moveDistance = speed * deltaSeconds;
    if (moveDistance <= 0) return;

    const targetX = Number(projectile.targetX);
    const targetY = Number(projectile.targetY);
    const distanceToTarget = Number.isFinite(targetX) && Number.isFinite(targetY)
      ? Math.hypot(targetX - position.x, targetY - position.y)
      : Number.POSITIVE_INFINITY;
    const travel = Math.min(moveDistance, Number(projectile.remainingDistance ?? moveDistance), distanceToTarget);
    const next = {
      x: roundCoord(position.x + Number(projectile.vx ?? 0) * travel),
      y: roundCoord(position.y + Number(projectile.vy ?? 0) * travel),
    };
    projectile.remainingDistance = Math.max(0, Number(projectile.remainingDistance ?? 0) - travel);

    const hit = findProjectileHit(this.world, entity, position, next);
    if (hit) {
      entity.components.position = hit.position;
      this.impact(entity, hit.entity);
      return;
    }

    entity.components.position = next;
    if (distanceToTarget <= moveDistance || projectile.remainingDistance <= 0 || !this.world.services.spatial.isInside(next.x, next.y)) {
      this.impact(entity, undefined);
    }
  }

  private impact(projectileEntity: Entity, hitEntity: Entity | undefined): void {
    const projectile = projectileEntity.components.projectile;
    if (!projectile) return;
    const position = projectileEntity.components.position ?? { x: 0, y: 0 };
    const impactTarget: Target = hitEntity
      ? { kind: "entity", entityId: hitEntity.entityId }
      : { kind: "position", position: [position.x, position.y] };
    applyProjectilePayload(this.world, projectile, impactTarget, [position.x, position.y]);
    this.world.services.vfx.addBurst(projectileEntity.entityId, String(projectile.color ?? "#f8fafc"));

    if (hitEntity && Number(projectile.pierce ?? 0) > 0) {
      projectile.pierce = Number(projectile.pierce) - 1;
      projectile.hitEntityIds = [...(projectile.hitEntityIds ?? []), hitEntity.entityId];
      return;
    }
    delete this.world.entities[projectileEntity.entityId];
  }
}
