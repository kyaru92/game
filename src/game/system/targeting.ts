
import type { ItemInstance, Target, TargetContext } from "../types";
import type { World } from "../world";
import { displayItemName } from "../utils";
import { formatDistance } from "./common";

export function targetForItem(world: World, item: ItemInstance, contextOrTarget: Target | TargetContext): Target {
  const context: TargetContext = isTarget(contextOrTarget) ? { selectedTarget: contextOrTarget } : contextOrTarget;
  const targeting = item.components.targeting;
  const actorId = context.actorId ?? "player";
  const selectedTarget = context.selectedTarget ?? { kind: "none" };
  const mode = String(targeting?.mode ?? "self");
  if (mode === "self") return { kind: "entity", entityId: actorId };
  if (mode === "entity") {
    if (selectedTarget.kind === "entity" && selectedTarget.entityId && world.entities[selectedTarget.entityId]) return selectedTarget;
    if (context.requireExplicitEntity) return { kind: "none" };
    const defaultSelector = targeting?.default;
    const defaultEntity = typeof defaultSelector === "string" ? world.findEntity(defaultSelector) : undefined;
    const fallback = defaultEntity ?? Object.keys(world.entities).find((id) => id !== actorId);
    return fallback ? { kind: "entity", entityId: fallback } : { kind: "none" };
  }
  if (mode === "position") {
    if (context.cursorPosition) return { kind: "position", position: context.cursorPosition };
    if (selectedTarget.kind === "position" && selectedTarget.position) return selectedTarget;
    if (selectedTarget.kind === "entity" && selectedTarget.entityId) {
      const position = world.entities[selectedTarget.entityId]?.components.position;
      if (position) return { kind: "position", position: [position.x, position.y] };
    }
    const playerPosition = world.entities[actorId]?.components.position ?? { x: 0, y: 0 };
    return { kind: "position", position: [playerPosition.x, playerPosition.y] };
  }
  return { kind: "none" };
}

function isTarget(value: Target | TargetContext): value is Target {
  return "kind" in value;
}

export function validateTarget(world: World, item: ItemInstance, target: Target, actorId: string): string | undefined {
  const targeting = item.components.targeting;
  if (!targeting) {
    if (target.kind !== "entity" || target.entityId !== actorId) return `${displayItemName(item)} 默认只能对自己使用。`;
    return undefined;
  }

  const mode = String(targeting.mode ?? "self");
  if (mode === "self" && (target.kind !== "entity" || target.entityId !== actorId)) return `${displayItemName(item)} 只能对自己使用。`;
  if (mode === "entity" && (target.kind !== "entity" || !target.entityId || !world.entities[target.entityId])) return `${displayItemName(item)} 需要有效实体目标。`;
  if (mode === "position" && (target.kind !== "position" || !target.position)) return `${displayItemName(item)} 需要位置目标。`;

  const range = Number(targeting.range ?? 0);
  if (range > 0) {
    const actorPosition = world.entities[actorId].components.position ?? { x: 0, y: 0 };
    const targetPosition = target.kind === "entity" && target.entityId
      ? world.entities[target.entityId]?.components.position
      : target.kind === "position" && target.position
        ? { x: target.position[0], y: target.position[1] }
        : undefined;
    if (targetPosition) {
      const distance = Math.hypot(actorPosition.x - targetPosition.x, actorPosition.y - targetPosition.y);
      if (distance > range) return `${displayItemName(item)} 超出射程：${formatDistance(distance)}/${range}。`;
    }
  }

  return undefined;
}

export function resolveEffectTarget(world: World, mode: string, actorId: string, activationTarget: Target): Target {
  if (["self", "actor", "user"].includes(mode)) return { kind: "entity", entityId: actorId };
  if (mode === "activation_target") return activationTarget;
  if (mode.startsWith("@")) {
    const entityId = world.findEntity(mode);
    return entityId ? { kind: "entity", entityId } : { kind: "none" };
  }
  return activationTarget;
}

export function resolveAreaTargets(world: World, activationTarget: Target, radius: number): string[] {
  let center: { x: number; y: number } | undefined;
  if (activationTarget.kind === "position" && activationTarget.position) {
    center = { x: activationTarget.position[0], y: activationTarget.position[1] };
  } else if (activationTarget.kind === "entity" && activationTarget.entityId) {
    const targetEntity = world.entities[activationTarget.entityId];
    center = targetEntity ? world.services.spatial.positionOf(targetEntity) : undefined;
  }
  if (!center) return [];
  const areaCenter = center;

  return Object.values(world.entities)
    .filter((entity) => {
      const position = world.services.spatial.positionOf(entity); // 延迟补偿：回溯时取历史位置
      if (!position || entity.components.projectile) return false;
      const distance = Math.hypot(position.x - areaCenter.x, position.y - areaCenter.y);
      return distance <= radius;
    })
    .map((entity) => entity.entityId);
}
