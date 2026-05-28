import type { EntityRuntimeComponents } from "../../domain/componentTypes";
import type { Entity } from "../types";
import type { World } from "../world";

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

export class SpatialService {
  constructor(private readonly world: World) {}

  isInside(x: number, y: number, radius = 0): boolean {
    return x >= radius && y >= radius && x <= this.world.width - radius && y <= this.world.height - radius;
  }

  isBlocked(_x: number, _y: number): boolean {
    return false;
  }

  entityBounds(entity: Entity, position = entity.components.position ?? { x: 0, y: 0 }): CollisionBox {
    return collisionBox(entity.components, position, this.world.defaultEntityRadius);
  }

  entityRadius(entity: Entity): number {
    const bounds = this.entityBounds(entity);
    return Math.max(bounds.width, bounds.height) / 2;
  }

  entityAt(x: number, y: number, padding = this.world.selectionRadius, exceptEntityId?: string): Entity | undefined {
    let closest: Entity | undefined;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const entity of Object.values(this.world.entities)) {
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
    const entity = this.world.entities[entityId];
    return Boolean(entity) && this.canOccupy(entityId, entity, x, y);
  }

  blockingEntityFor(entityId: string, x: number, y: number): Entity | undefined {
    const entity = this.world.entities[entityId];
    return entity ? this.blockingEntityAt(entityId, this.entityBounds(entity, { x, y })) : undefined;
  }

  tryMove(entityId: string, dx: number, dy: number, options: MoveOptions = {}): boolean {
    const entity = this.world.entities[entityId];
    if (!entity || !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const position = entity.components.position ?? { x: 0, y: 0 };
    const target = this.clampToWorld(entity, position.x + dx, position.y + dy);
    if (samePosition(position, target)) {
      if (options.logFailure ?? true) this.world.log("已经到达世界边界。");
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
      this.world.log(other ? `${other.name} 挡住了去路。` : "无法移动到该位置。");
    }
    return false;
  }

  private clampToWorld(entity: Entity, x: number, y: number): { x: number; y: number } {
    const bounds = this.entityBounds(entity, { x, y });
    let clampedX = x;
    let clampedY = y;
    if (bounds.left < 0) clampedX -= bounds.left;
    if (bounds.right > this.world.width) clampedX -= bounds.right - this.world.width;
    if (bounds.top < 0) clampedY -= bounds.top;
    if (bounds.bottom > this.world.height) clampedY -= bounds.bottom - this.world.height;
    return { x: clampedX, y: clampedY };
  }

  private canOccupy(entityId: string, entity: Entity, x: number, y: number): boolean {
    const bounds = this.entityBounds(entity, { x, y });
    return this.isBoxInsideWorld(bounds) && !this.isBlocked(x, y) && !this.blockingEntityAt(entityId, bounds);
  }

  private blockingEntityAt(entityId: string, bounds: CollisionBox): Entity | undefined {
    return Object.values(this.world.entities).find((other) => {
      if (other.entityId === entityId || other.components.collision?.blocksMovement === false) return false;
      const position = other.components.position;
      if (!position) return false;
      return boxesIntersect(bounds, this.entityBounds(other, position));
    });
  }

  private isBoxInsideWorld(bounds: CollisionBox): boolean {
    return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= this.world.width && bounds.bottom <= this.world.height;
  }

  private setPosition(entity: Entity, x: number, y: number): void {
    entity.components.position = { x: roundCoord(x), y: roundCoord(y) };
  }
}

export function collisionBox(components: EntityRuntimeComponents, position: { x: number; y: number }, defaultRadius: number): CollisionBox {
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

function samePosition(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) < 0.0001 && Math.abs(a.y - b.y) < 0.0001;
}

function roundCoord(value: number): number {
  return Number(value.toFixed(3));
}
