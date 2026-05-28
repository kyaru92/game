
import type { Entity, JsonObj, Target } from "../types";
import type { World } from "../world";
import { deepClone, normalizeArray } from "../utils";
import { cloneOptional, roundCoord } from "./common";
import { resolveAreaTargets, resolveEffectTarget } from "./targeting";

export interface ProjectileLaunchOptions {
  sourceEntityId: string;
  sourceItemId?: string;
  target: Target;
  displayName: string;
  color: string;
  glyph: string;
  radius: number;
  payload: JsonObj;
}

export function launchProjectile(world: World, options: ProjectileLaunchOptions): boolean {
  const source = world.entities[options.sourceEntityId];
  const sourcePosition = source?.components.position;
  if (!source || !sourcePosition) {
    world.log(`${options.displayName} 找不到发射者。`);
    return false;
  }

  const target = targetPoint(world, options.target);
  if (!target) {
    world.log(`${options.displayName} 需要有效投射目标。`);
    return false;
  }

  const dx = target.x - sourcePosition.x;
  const dy = target.y - sourcePosition.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= 0.001) {
    world.log(`${options.displayName} 的目标距离太近，无法发射。`);
    return false;
  }

  const payload = cloneOptional(options.payload) ?? {};
  const projectileConfig = payload.projectile ?? {};
  const speed = Math.max(0.1, Number(projectileConfig.speed ?? 12));
  const maxDistance = Math.max(0.1, Number(projectileConfig.maxDistance ?? distance));
  const radius = Math.max(0.01, Number(options.radius ?? projectileConfig.radius ?? 0.08));
  const entityId = world.nextEntityId("projectile");
  world.addEntity({
    entityId,
    name: options.displayName,
    components: {
      display: {
        name: options.displayName,
        glyph: options.glyph,
        color: options.color,
        strokeColor: "#f8fafc",
      },
      position: { x: roundCoord(sourcePosition.x), y: roundCoord(sourcePosition.y) },
      collision: {
        blocksMovement: false,
        shape: "circle",
        radius,
      },
      projectile: {
        sourceEntityId: options.sourceEntityId,
        sourceItemId: options.sourceItemId,
        displayName: options.displayName,
        targetX: roundCoord(target.x),
        targetY: roundCoord(target.y),
        vx: dx / distance,
        vy: dy / distance,
        speed,
        maxDistance,
        remainingDistance: maxDistance,
        radius,
        pierce: Number(projectileConfig.pierce ?? 0),
        color: options.color,
        payload,
      },
    },
  });
  return true;
}

function targetPoint(world: World, target: Target): { x: number; y: number } | undefined {
  if (target.kind === "position" && target.position) return { x: target.position[0], y: target.position[1] };
  if (target.kind === "entity" && target.entityId) return world.entities[target.entityId]?.components.position;
  return undefined;
}

export function buildFirearmProjectilePayload(firearm: JsonObj, round: JsonObj): JsonObj {
  const projectile = { ...(cloneOptional(round.projectile) ?? {}) };
  projectile.speed = Number(projectile.speed ?? firearm.projectileSpeed ?? 18);
  projectile.maxDistance = Number(projectile.maxDistance ?? firearm.maxDistance ?? firearm.range ?? 12);
  projectile.pierce = Number(projectile.pierce ?? firearm.pierce ?? 0);

  const damageAppliers = normalizeArray(round.damage_applier).map((applier) => deepClone(applier));
  const baseDamage = Number(round.damage ?? 0);
  const damage = (baseDamage + Number(firearm.damageBonus ?? 0)) * Number(firearm.damageMultiplier ?? 1);
  if (damage > 0) {
    const radius = Number(round.areaRadius ?? round.impactRadius ?? 0);
    damageAppliers.unshift({
      amount: Number(damage.toFixed(2)),
      damageType: String(round.damageType ?? firearm.damageType ?? "generic"),
      target: radius > 0 ? "impact_area" : "impact_target",
      radius,
    });
  }

  return {
    projectile,
    damage_applier: damageAppliers,
    effect_applier: cloneOptional(round.effect_applier),
    impactRadius: round.impactRadius ?? round.areaRadius,
  };
}

export function projectileConfigFromLauncher(launcher: JsonObj): JsonObj {
  const projectile = { ...(cloneOptional(launcher.projectile) ?? {}) };
  projectile.speed = Number(projectile.speed ?? launcher.speed ?? 10);
  projectile.maxDistance = Number(projectile.maxDistance ?? launcher.maxDistance ?? 12);
  projectile.pierce = Number(projectile.pierce ?? launcher.pierce ?? 0);
  return projectile;
}

export function findProjectileHit(world: World, projectileEntity: Entity, from: { x: number; y: number }, to: { x: number; y: number }): { entity: Entity; position: { x: number; y: number } } | undefined {
  const projectile = projectileEntity.components.projectile;
  if (!projectile) return undefined;
  const ignored = new Set<string>([projectileEntity.entityId, String(projectile.sourceEntityId ?? ""), ...(projectile.hitEntityIds ?? [])]);
  let best: { entity: Entity; position: { x: number; y: number }; distanceAlong: number } | undefined;
  for (const entity of Object.values(world.entities)) {
    if (ignored.has(entity.entityId) || entity.components.projectile) continue;
    const position = entity.components.position;
    if (!position) continue;
    const hitRadius = world.services.spatial.entityRadius(entity) + Number(projectile.radius ?? 0.05);
    const segment = distanceToSegment(position.x, position.y, from, to);
    if (segment.distance > hitRadius) continue;
    if (!best || segment.distanceAlong < best.distanceAlong) {
      best = {
        entity,
        position: { x: roundCoord(segment.x), y: roundCoord(segment.y) },
        distanceAlong: segment.distanceAlong,
      };
    }
  }
  return best;
}

function distanceToSegment(px: number, py: number, from: { x: number; y: number }, to: { x: number; y: number }): { distance: number; distanceAlong: number; x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0.000001) {
    return { distance: Math.hypot(px - from.x, py - from.y), distanceAlong: 0, x: from.x, y: from.y };
  }
  const t = Math.max(0, Math.min(1, ((px - from.x) * dx + (py - from.y) * dy) / lengthSq));
  const x = from.x + dx * t;
  const y = from.y + dy * t;
  return {
    distance: Math.hypot(px - x, py - y),
    distanceAlong: Math.sqrt(lengthSq) * t,
    x,
    y,
  };
}

export function applyProjectilePayload(world: World, projectile: JsonObj, impactTarget: Target, impactPosition: [number, number]): void {
  const payload = projectile.payload ?? {};
  const sourceEntityId = String(projectile.sourceEntityId ?? "");
  const sourceName = String(projectile.displayName ?? "投射物");
  for (const applier of normalizeArray(payload.damage_applier)) {
    applyProjectileDamage(world, applier, sourceEntityId, sourceName, impactTarget, impactPosition);
  }
  for (const applier of normalizeArray(payload.effect_applier)) {
    applyProjectileEffect(world, applier, sourceEntityId, projectile.sourceItemId, impactTarget, impactPosition);
  }
}

function applyProjectileDamage(world: World, applier: JsonObj, sourceEntityId: string, sourceName: string, impactTarget: Target, impactPosition: [number, number]): void {
  const amount = Number(applier.amount ?? applier.damage ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return;
  const damageType = String(applier.damageType ?? "generic");
  const targetMode = String(applier.target ?? "impact_target");
  const radius = Number(applier.radius ?? applier.areaRadius ?? 0);
  if (targetMode === "impact_area" || targetMode === "activation_area" || radius > 0) {
    const targets = resolveAreaTargets(world, { kind: "position", position: impactPosition }, radius || 2);
    if (!targets.length) world.log(`${sourceName} 的范围伤害没有命中目标。`);
    for (const targetEntityId of targets) world.services.damage.applyDamage(targetEntityId, amount, damageType, sourceName);
    return;
  }
  const target = resolveProjectileTarget(world, targetMode, sourceEntityId, impactTarget);
  if (target.kind === "entity" && target.entityId) world.services.damage.applyDamage(target.entityId, amount, damageType, sourceName);
}

function applyProjectileEffect(world: World, applier: JsonObj, sourceEntityId: string, sourceItemId: string | undefined, impactTarget: Target, impactPosition: [number, number]): void {
  const chance = Number(applier.chance ?? 1);
  if (Math.random() > chance) return;
  const effectId = String(applier.kind ?? applier.effectId ?? "");
  if (!effectId) return;
  const targetMode = String(applier.target ?? "impact_target");
  const radius = Number(applier.radius ?? applier.areaRadius ?? 0);
  if (targetMode === "impact_area" || targetMode === "activation_area" || radius > 0) {
    const targets = resolveAreaTargets(world, { kind: "position", position: impactPosition }, radius || 2);
    if (!targets.length) world.log(`范围效果 ${effectId} 没有命中目标。`);
    for (const targetEntityId of targets) {
      world.bus.emit("ApplyEffectRequest", {
        effectId,
        targetEntityId,
        sourceEntityId,
        sourceItemId,
        effectOverrides: applier.overrides,
      });
    }
    return;
  }
  const target = resolveProjectileTarget(world, targetMode, sourceEntityId, impactTarget);
  if (target.kind !== "entity" || !target.entityId) return;
  world.bus.emit("ApplyEffectRequest", {
    effectId,
    targetEntityId: target.entityId,
    sourceEntityId,
    sourceItemId,
    effectOverrides: applier.overrides,
  });
}

function resolveProjectileTarget(world: World, mode: string, sourceEntityId: string, impactTarget: Target): Target {
  if (mode === "impact_target" || mode === "activation_target") return impactTarget;
  return resolveEffectTarget(world, mode, sourceEntityId, impactTarget);
}
