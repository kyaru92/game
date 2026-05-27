import type { Entity, EventData, ItemInstance, JsonObj, Target } from "./types";
import type { World } from "./world";
import {
  displayItemName,
  describeTarget,
  effectColor,
  effectStackCount,
  formatDuration,
  normalizeArray,
  stackedValue,
} from "./utils";

export class ActivationSystem {
  constructor(private readonly world: World) {}

  startUse(actorId: string, inventoryIndex: number, target: Target): void {
    const actor = this.world.entities[actorId];
    if (!actor) {
      this.world.log(`找不到使用者：${actorId}`);
      return;
    }
    const casting = actor.components.casting;
    if (casting) {
      const remaining = Math.max(0, casting.finishAtMs - this.world.nowMs());
      this.world.log(`正在使用 ${casting.itemName}，还需 ${Math.ceil(remaining)}ms。`);
      return;
    }

    const inventory = this.world.inventory(actorId);
    if (inventoryIndex < 0 || inventoryIndex >= inventory.length) {
      this.world.log(`背包索引不存在：${inventoryIndex}`);
      return;
    }

    const item = this.world.items[inventory[inventoryIndex]];
    const activation = item.components.activation;
    if (!activation) {
      this.world.log(`${displayItemName(item)} 没有 activation 组件，无法使用。`);
      return;
    }

    const now = this.world.nowMs();
    const cooldownUntil = Number(activation._cooldownUntilMs ?? 0);
    if (cooldownUntil > now) {
      this.world.log(`${displayItemName(item)} 冷却中，还需 ${Math.ceil(cooldownUntil - now)}ms。`);
      return;
    }
    if (Number(activation.charges ?? 0) <= 0) {
      this.world.log(`${displayItemName(item)} 已无可用次数。`);
      return;
    }

    const error = validateTarget(this.world, item, target, actorId);
    if (error) {
      this.world.log(error);
      return;
    }

    const castMs = Number(activation.castDurationMs ?? 0);
    if (castMs <= 0) {
      this.completeActivation(actorId, inventoryIndex, target);
      return;
    }

    actor.components.casting = {
      inventoryIndex,
      itemId: item.instanceId,
      itemName: displayItemName(item),
      startedAtMs: now,
      finishAtMs: now + castMs,
      target,
    };
    this.world.log(`开始使用 ${displayItemName(item)} -> ${describeTarget(this.world, target)}，需要 ${castMs}ms。`);
  }

  update(): void {
    const now = this.world.nowMs();
    for (const [actorId, actor] of Object.entries(this.world.entities)) {
      const casting = actor.components.casting;
      if (!casting || casting.finishAtMs > now) continue;
      delete actor.components.casting;
      this.completeActivation(actorId, Number(casting.inventoryIndex), casting.target);
    }
  }

  completeActivation(actorId: string, inventoryIndex: number, target: Target): void {
    const inventory = this.world.inventory(actorId);
    if (inventoryIndex < 0 || inventoryIndex >= inventory.length) {
      this.world.log("激活失败：物品已经不在背包中。");
      return;
    }

    const item = this.world.items[inventory[inventoryIndex]];
    const activation = item.components.activation;
    if (!activation || Number(activation.charges ?? 0) <= 0) {
      this.world.log(`激活失败：${displayItemName(item)} 已不可用。`);
      return;
    }

    this.world.log(`${displayItemName(item)} 激活成功。`);
    this.world.bus.emit("OnItemActivation", {
      actorId,
      itemId: item.instanceId,
      inventoryIndex,
      target,
    });

    activation.charges = Number(activation.charges ?? 1) - 1;
    activation._cooldownUntilMs = this.world.nowMs() + Number(activation.cooldownMs ?? 0);
    if (activation.consumeWhenDepleted && activation.charges <= 0) {
      const [removed] = inventory.splice(inventoryIndex, 1);
      this.world.log(`${displayItemName(this.world.items[removed])} 已耗尽并被移除。`);
    }
  }

  cancel(actorId: string): void {
    const actor = this.world.entities[actorId];
    const casting = actor?.components.casting;
    if (!casting) {
      this.world.log("当前没有正在使用的物品。");
      return;
    }
    delete actor.components.casting;
    this.world.log(`已取消使用 ${casting.itemName}。`);
  }
}

export class EffectApplierSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("OnItemActivation", (event) => this.onItemActivation(event));
  }

  private onItemActivation(event: EventData): void {
    const item = this.world.items[event.data.itemId];
    const appliers = normalizeArray(item.components.effect_applier);
    for (const applier of appliers) {
      const chance = Number(applier.chance ?? 1);
      if (Math.random() > chance) {
        this.world.log(`效果 ${applier.kind} 未触发。`);
        continue;
      }
      const targetMode = String(applier.target ?? "activation_target");
      const radius = Number(applier.radius ?? applier.areaRadius ?? 0);
      if (targetMode === "activation_area" || radius > 0) {
        const targets = resolveAreaTargets(this.world, event.data.target, radius || 2);
        if (!targets.length) {
          this.world.log(`范围效果 ${applier.kind} 没有命中目标。`);
          continue;
        }
        this.world.log(`范围效果 ${applier.kind} 命中 ${targets.length} 个目标。`);
        for (const targetEntityId of targets) {
          this.world.bus.emit("ApplyEffectRequest", {
            effectId: applier.kind,
            targetEntityId,
            sourceEntityId: event.data.actorId,
            sourceItemId: item.instanceId,
            effectOverrides: applier.overrides,
          });
        }
        continue;
      }

      const target = resolveEffectTarget(
        this.world,
        targetMode,
        String(event.data.actorId),
        event.data.target,
      );
      if (target.kind !== "entity" || !target.entityId) {
        this.world.log(`效果 ${applier.kind} 需要实体目标，但得到 ${describeTarget(this.world, target)}。`);
        continue;
      }
      this.world.bus.emit("ApplyEffectRequest", {
        effectId: applier.kind,
        targetEntityId: target.entityId,
        sourceEntityId: event.data.actorId,
        sourceItemId: item.instanceId,
        effectOverrides: applier.overrides,
      });
    }
  }
}

export class TeleportSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("OnItemActivation", (event) => this.onItemActivation(event));
  }

  private onItemActivation(event: EventData): void {
    const item = this.world.items[event.data.itemId];
    const teleporter = item.components.teleporter;
    if (!teleporter) return;
    const target = event.data.target as Target;
    if (target.kind !== "position" || !target.position) {
      this.world.log(`${displayItemName(item)} 需要位置目标。`);
      return;
    }
    const actor = this.world.entities[String(event.data.actorId)];
    const from = actor.components.position ?? { x: 0, y: 0 };
    const [x, y] = target.position;
    if (!this.world.isInside(x, y) || this.world.isBlocked(x, y)) {
      this.world.log("闪现目标不可到达。");
      return;
    }
    actor.components.position = { x, y };
    this.world.addTeleportTrail([from.x, from.y], [x, y]);
    this.world.log(`${actor.name} 闪现到 ${describeTarget(this.world, target)}。`);
  }
}

export class EntitySpawnerSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("OnItemActivation", (event) => this.onItemActivation(event));
  }

  private onItemActivation(event: EventData): void {
    const item = this.world.items[event.data.itemId];
    const spawner = item.components.entity_spawner;
    if (!spawner) return;

    const target = event.data.target as Target;
    if (target.kind !== "position" || !target.position) {
      this.world.log(`${displayItemName(item)} 需要位置目标。`);
      return;
    }

    const [x, y] = target.position;
    if (!this.world.isInside(x, y)) {
      this.world.log("生成目标超出地图。");
      return;
    }
    if (!spawner.allowBlocked && this.world.isBlocked(x, y)) {
      this.world.log("生成目标是障碍物，无法孵化。");
      return;
    }
    const occupying = this.world.entityAt(x, y);
    if (!spawner.allowOccupied && occupying) {
      this.world.log(`${occupying.name} 占据了生成位置，无法孵化。`);
      return;
    }

    const prototype = String(spawner.prototype ?? spawner.entity ?? "");
    if (!prototype) {
      this.world.log(`${displayItemName(item)} 的 entity_spawner 缺少 prototype。`);
      return;
    }

    const entity = this.world.createEntity(prototype, {
      entityId: spawner.entityId ? String(spawner.entityId) : undefined,
      name: spawner.name ? String(spawner.name) : undefined,
      position: { x, y },
      overrides: spawner.overrides ?? {},
    });
    const color = String(spawner.color ?? entity.components.display?.color ?? "#fb923c");
    this.world.addBurst(entity.entityId, color);
    this.world.addFloatingText(entity.entityId, entity.name, color);
    this.world.log(`${this.world.entityName(String(event.data.actorId))} 使用 ${displayItemName(item)}，在 (${x},${y}) 生成 ${entity.name}。`);
  }
}

export class EffectSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("ApplyEffectRequest", (event) => this.onApplyEffectRequest(event));
  }

  private onApplyEffectRequest(event: EventData): void {
    this.applyEffect(
      String(event.data.effectId),
      String(event.data.targetEntityId),
      event.data.sourceEntityId,
      event.data.sourceItemId,
      event.data.effectOverrides,
    );
  }

  applyEffect(effectId: string, targetEntityId: string, sourceEntityId?: string, sourceItemId?: string, effectOverrides?: JsonObj): void {
    const definition = this.world.effects[effectId];
    if (!definition) {
      this.world.log(`未知效果：${effectId}`);
      return;
    }
    const target = this.world.entities[targetEntityId];
    if (!target) {
      this.world.log(`找不到效果目标：${targetEntityId}`);
      return;
    }
    const effects = (target.components.active_effects ??= {});
    const now = this.world.nowMs();
    const durationMs = Number(effectOverrides?.durationMs ?? definition.durationMs ?? -1);    const stacking = definition.stacking ?? {};
    const behavior = String(stacking.overlapBehavior ?? "none");
    const maxStacks = Number(stacking.maxStacks ?? 1);
    const name = String(definition.name ?? effectId);
    const existing = effects[effectId];

    if (behavior === "refresh_duration") {
      if (existing) {
        const oldStacks = Number(existing.stacks ?? 1);
        if (oldStacks < maxStacks) {
          existing.stacks = oldStacks + 1;
          this.world.log(`${target.name} 的 ${name} 叠加到 ${existing.stacks} 层。`);
        } else {
          const onMax = String(stacking.onMax ?? "refresh_duration");
          if (onMax === "reject") {
            this.world.log(`${target.name} 的 ${name} 已达最大层数 ${maxStacks}，新效果被拒绝。`);
            return;
          }
          this.world.log(`${target.name} 的 ${name} 已达最大层数 ${maxStacks}，刷新持续时间。`);
        }
        refreshRuntime(existing, durationMs, now);
        this.world.addBurst(target.entityId, effectColor(effectId));
        return;
      }
      effects[effectId] = makeActiveEffect(definition, behavior, 1, durationMs, now, sourceEntityId, sourceItemId);
      this.world.log(`${target.name} 获得效果：${name} x1，持续 ${formatDuration(durationMs)}。`);
      this.world.addBurst(target.entityId, effectColor(effectId));
      this.world.addFloatingText(target.entityId, name, effectColor(effectId));
      return;
    }

    if (behavior === "independent") {
      if (existing) {
        const layers = (existing.layers ??= []);
        if (layers.length >= maxStacks) {
          const onMax = String(stacking.onMax ?? "reject");
          if (onMax === "replace_oldest") {
            layers.sort((a: JsonObj, b: JsonObj) => Number(a.expiresAtMs ?? 1e18) - Number(b.expiresAtMs ?? 1e18));
            layers.shift();
            this.world.log(`${target.name} 的 ${name} 已达最大层数，替换最早过期的一层。`);
          } else {
            this.world.log(`${target.name} 的 ${name} 已达最大层数 ${maxStacks}，新层被拒绝。`);
            return;
          }
        }
        layers.push(makeLayer(definition, durationMs, now));
        existing.stacks = layers.length;
        this.world.log(`${target.name} 的 ${name} 新增独立层，目前 ${layers.length} 层。`);
        this.world.addBurst(target.entityId, effectColor(effectId));
        return;
      }
      effects[effectId] = makeActiveEffect(definition, behavior, 1, durationMs, now, sourceEntityId, sourceItemId);
      this.world.log(`${target.name} 获得效果：${name} x1，持续 ${formatDuration(durationMs)}。`);
      this.world.addBurst(target.entityId, effectColor(effectId));
      this.world.addFloatingText(target.entityId, name, effectColor(effectId));
      return;
    }

    if (existing) {
      const policy = String(stacking.onOverlap ?? "reject");
      if (policy === "refresh_duration") {
        refreshRuntime(existing, durationMs, now);
        this.world.log(`${target.name} 已有 ${name}，刷新持续时间。`);
      } else if (policy === "replace") {
        effects[effectId] = makeActiveEffect(definition, "none", 1, durationMs, now, sourceEntityId, sourceItemId);
        this.world.log(`${target.name} 已有 ${name}，被新效果替换。`);
      } else {
        this.world.log(`${target.name} 已有 ${name}，存续期间不允许再次施加。`);
      }
      this.world.addBurst(target.entityId, effectColor(effectId));
      return;
    }

    effects[effectId] = makeActiveEffect(definition, "none", 1, durationMs, now, sourceEntityId, sourceItemId);
    this.world.log(`${target.name} 获得效果：${name}，持续 ${formatDuration(durationMs)}。`);
    this.world.addBurst(target.entityId, effectColor(effectId));
    this.world.addFloatingText(target.entityId, name, effectColor(effectId));
  }

  update(): void {
    const now = this.world.nowMs();
    for (const entity of Object.values(this.world.entities)) {
      const effects = entity.components.active_effects ?? {};
      for (const effectId of Object.keys(effects)) {
        const active = effects[effectId];
        const definition = this.world.effects[effectId];
        if (!definition) continue;
        if (active.behavior === "independent") this.updateIndependent(entity, effectId, active, definition, now);
        else this.updateSimple(entity, effectId, active, definition, now);
      }
    }
  }

  private updateSimple(entity: Entity, effectId: string, active: JsonObj, definition: JsonObj, now: number): void {
    this.runPeriodic(entity, definition, active, now, Number(active.stacks ?? 1));
    const expiresAt = active.expiresAtMs;
    if (expiresAt !== null && expiresAt !== undefined && now >= Number(expiresAt)) {
      delete entity.components.active_effects[effectId];
      this.world.log(`${entity.name} 的 ${definition.name ?? effectId} 已过期。`);
    }
  }

  private updateIndependent(entity: Entity, effectId: string, active: JsonObj, definition: JsonObj, now: number): void {
    const layers: JsonObj[] = active.layers ?? [];
    const alive: JsonObj[] = [];
    let expiredCount = 0;
    for (const layer of layers) {
      this.runPeriodic(entity, definition, layer, now, 1);
      const expiresAt = layer.expiresAtMs;
      if (expiresAt !== null && expiresAt !== undefined && now >= Number(expiresAt)) expiredCount += 1;
      else alive.push(layer);
    }
    if (expiredCount) this.world.log(`${entity.name} 的 ${definition.name ?? effectId} 过期 ${expiredCount} 层。`);
    if (alive.length) {
      active.layers = alive;
      active.stacks = alive.length;
    } else {
      delete entity.components.active_effects[effectId];
    }
  }

  private runPeriodic(entity: Entity, definition: JsonObj, runtime: JsonObj, now: number, stacks: number): void {
    const periodic = definition.periodicEffect;
    if (!periodic) return;
    const interval = Number(periodic.intervalMs ?? 1000);
    runtime.nextTickAtMs ??= now + interval;
    let tickCount = 0;
    while (now >= Number(runtime.nextTickAtMs)) {
      tickCount += 1;
      runtime.nextTickAtMs = Number(runtime.nextTickAtMs) + interval;
      if (tickCount > 30) {
        runtime.nextTickAtMs = now + interval;
        break;
      }
      applyPeriodicChange(this.world, entity, definition, periodic, stacks);
    }
  }
}

export class AttributeSystem {
  constructor(private readonly world: World) {}

  finalAttributes(entity: Entity): JsonObj {
    const attrs: JsonObj = JSON.parse(JSON.stringify(entity.components.attributes ?? {}));
    for (const [effectId, active] of Object.entries<JsonObj>(entity.components.active_effects ?? {})) {
      const definition = this.world.effects[effectId];
      if (!definition) continue;
      const stacks = effectStackCount(active);
      for (const modifier of definition.modifiers ?? []) {
        const attr = modifier.attribute;
        attrs[attr] ??= 0;
        const op = String(modifier.op ?? "add");
        const value = Number(modifier.value ?? 0);
        const stackType = String(modifier.stackType ?? "none");
        const effectiveValue = stackedValue(value, stacks, stackType);
        if (op === "add") attrs[attr] = Number(attrs[attr]) + effectiveValue;
        else if (op === "mul") attrs[attr] = Number(attrs[attr]) * (1 + effectiveValue);
        else if (op === "override") attrs[attr] = effectiveValue;
      }
    }
    return attrs;
  }
}

export function targetForItem(world: World, item: ItemInstance, selectedTarget: Target): Target {
  const targeting = item.components.targeting;
  const mode = String(targeting?.mode ?? "self");
  if (mode === "self") return { kind: "entity", entityId: "player" };
  if (mode === "entity") {
    if (selectedTarget.kind === "entity" && selectedTarget.entityId && world.entities[selectedTarget.entityId]) return selectedTarget;
    const defaultSelector = targeting?.default;
    const defaultEntity = typeof defaultSelector === "string" ? world.findEntity(defaultSelector) : undefined;
    return { kind: "entity", entityId: defaultEntity ?? Object.keys(world.entities).find((id) => id !== "player") };
  }
  if (mode === "position") {
    if (selectedTarget.kind === "position" && selectedTarget.position) return selectedTarget;
    if (selectedTarget.kind === "entity" && selectedTarget.entityId) {
      const position = world.entities[selectedTarget.entityId]?.components.position;
      if (position) return { kind: "position", position: [position.x, position.y] };
    }
    const playerPosition = world.player().components.position ?? { x: 0, y: 0 };
    return { kind: "position", position: [playerPosition.x, playerPosition.y] };
  }
  return { kind: "none" };
}


function validateTarget(world: World, item: ItemInstance, target: Target, actorId: string): string | undefined {
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
      const distance = Math.abs(actorPosition.x - targetPosition.x) + Math.abs(actorPosition.y - targetPosition.y);
      if (distance > range) return `${displayItemName(item)} 超出射程：${distance}/${range}。`;
    }
  }

  return undefined;
}

function resolveEffectTarget(world: World, mode: string, actorId: string, activationTarget: Target): Target {
  if (["self", "actor", "user"].includes(mode)) return { kind: "entity", entityId: actorId };
  if (mode === "activation_target") return activationTarget;
  if (mode.startsWith("@")) {
    const entityId = world.findEntity(mode);
    return entityId ? { kind: "entity", entityId } : { kind: "none" };
  }
  return activationTarget;
}

function resolveAreaTargets(world: World, activationTarget: Target, radius: number): string[] {
  let center: { x: number; y: number } | undefined;
  if (activationTarget.kind === "position" && activationTarget.position) {
    center = { x: activationTarget.position[0], y: activationTarget.position[1] };
  } else if (activationTarget.kind === "entity" && activationTarget.entityId) {
    center = world.entities[activationTarget.entityId]?.components.position;
  }
  if (!center) return [];

  return Object.values(world.entities)
    .filter((entity) => {
      const position = entity.components.position;
      if (!position) return false;
      const distance = Math.abs(position.x - center.x) + Math.abs(position.y - center.y);
      return distance <= radius;
    })
    .map((entity) => entity.entityId);
}

function makeLayer(definition: JsonObj, durationMs: number, now: number): JsonObj {
  const interval = definition.periodicEffect ? Number(definition.periodicEffect.intervalMs ?? 1000) : undefined;
  return {
    startedAtMs: now,
    expiresAtMs: durationMs < 0 ? null : now + durationMs,
    durationMs,
    nextTickAtMs: interval === undefined ? undefined : now + interval,
  };
}

function makeActiveEffect(definition: JsonObj, behavior: string, stacks: number, durationMs: number, now: number, sourceEntityId?: string, sourceItemId?: string): JsonObj {
  const active: JsonObj = {
    effectId: definition.id,
    behavior,
    stacks,
    sourceEntityId,
    sourceItemId,
  };
  if (behavior === "independent") active.layers = [makeLayer(definition, durationMs, now)];
  else Object.assign(active, makeLayer(definition, durationMs, now));
  return active;
}

function refreshRuntime(runtime: JsonObj, durationMs: number, now: number): void {
  runtime.startedAtMs = now;
  runtime.expiresAtMs = durationMs < 0 ? null : now + durationMs;
  runtime.durationMs = durationMs;
}

function applyPeriodicChange(world: World, entity: Entity, definition: JsonObj, periodic: JsonObj, stacks: number): void {
  const attr = String(periodic.attribute);
  const op = String(periodic.op ?? "add");
  const value = Number(periodic.value ?? 0);
  const stackType = String(periodic.stackType ?? "add");
  const amount = stackedValue(value, stacks, stackType);
  const effectName = String(definition.name ?? definition.id ?? "effect");

  const resources = (entity.components.resources ??= {});
  if (attr in resources) {
    const before = Number(resources[attr]);
    const maxKey = `max_${attr}`;
    let after = op === "mul" ? before * (1 + amount) : before + amount;
    if (maxKey in resources) after = Math.min(after, Number(resources[maxKey]));
    after = Math.max(0, after);
    resources[attr] = Number.isInteger(after) ? Math.trunc(after) : Number(after.toFixed(2));
    const delta = Number(resources[attr]) - before;
    const sign = delta >= 0 ? "+" : "";
    const color = delta >= 0 ? "#4ade80" : "#fb7185";
    const deltaText = Number.isInteger(delta) ? String(delta) : delta.toFixed(2);
    world.log(`${entity.name} 受到 ${effectName} 周期效果：${attr} ${sign}${deltaText} -> ${resources[attr]}`);
    world.addFloatingText(entity.entityId, `${sign}${deltaText} ${attr}`, color);
    return;
  }

  const attrs = (entity.components.attributes ??= {});
  const before = Number(attrs[attr] ?? 0);
  const after = op === "mul" ? before * (1 + amount) : before + amount;
  attrs[attr] = Number(after.toFixed(2));
  world.log(`${entity.name} 的 ${attr} 周期变化 ${before} -> ${attrs[attr]}`);
}
