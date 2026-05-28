import type { Entity, EventData, ItemInstance, JsonObj, Target, TargetContext } from "./types";
import type { World } from "./world";
import {
  deepClone,
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
    const itemId = this.world.inventory(actorId)[inventoryIndex];
    if (!itemId) {
      this.world.log(`背包索引不存在：${inventoryIndex}`);
      return;
    }
    this.startUseItem(actorId, itemId, target);
  }

  startUseItem(actorId: string, itemId: string, target: Target): void {
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

    const inventoryIndex = this.world.inventory(actorId).indexOf(itemId);
    const item = this.world.items[itemId];
    if (!item || inventoryIndex < 0) {
      this.world.log(`物品不在背包中：${itemId}`);
      return;
    }

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
    if (activation.consumeCharge !== false && Number(activation.charges ?? 0) <= 0) {
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
      this.completeActivation(actorId, item.instanceId, target);
      return;
    }

    actor.components.casting = {
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
      this.completeActivation(actorId, String(casting.itemId ?? ""), casting.target);
    }
  }

  completeActivation(actorId: string, itemId: string, target: Target): void {
    const inventory = this.world.inventory(actorId);
    const inventoryIndex = inventory.indexOf(itemId);
    const item = this.world.items[itemId];
    if (!item || inventoryIndex < 0) {
      this.world.log("激活失败：物品已经不在背包中。");
      return;
    }

    const activation = item.components.activation;
    if (!activation || (activation.consumeCharge !== false && Number(activation.charges ?? 0) <= 0)) {
      this.world.log(`激活失败：${displayItemName(item)} 已不可用。`);
      return;
    }

    const beforeData: JsonObj = {
      actorId,
      itemId: item.instanceId,
      inventoryIndex,
      target,
    };
    this.world.bus.emit("BeforeItemActivation", beforeData);
    if (beforeData.cancelReason) {
      this.world.log(String(beforeData.cancelReason));
      return;
    }

    this.world.log(`${displayItemName(item)} 激活成功。`);
    this.world.bus.emit("OnItemActivation", {
      actorId,
      itemId: item.instanceId,
      inventoryIndex,
      target,
    });

    if (activation.consumeCharge !== false) {
      activation.charges = Number(activation.charges ?? 1) - 1;
      if (activation.consumeWhenDepleted && activation.charges <= 0) {
        const itemName = displayItemName(item);
        this.world.removeInventoryItem(actorId, item.instanceId);
        this.world.log(`${itemName} 已耗尽并被移除。`);
      }
    }
    if (this.world.items[item.instanceId]) activation._cooldownUntilMs = this.world.nowMs() + Number(activation.cooldownMs ?? 0);
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
    if (item.components.projectile_launcher || item.components.firearm) return;
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

export class DamageApplierSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("OnItemActivation", (event) => this.onItemActivation(event));
  }

  private onItemActivation(event: EventData): void {
    const item = this.world.items[event.data.itemId];
    if (item.components.projectile_launcher || item.components.firearm) return;
    const appliers = normalizeArray(item.components.damage_applier);
    for (const applier of appliers) {
      const amount = Number(applier.amount ?? applier.damage ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        this.world.log(`${displayItemName(item)} 的 damage_applier 缺少有效 amount。`);
        continue;
      }

      const damageType = String(applier.damageType ?? "generic");
      const radius = Number(applier.radius ?? applier.areaRadius ?? 0);
      if (radius > 0) {
        const targets = resolveAreaTargets(this.world, event.data.target, radius);
        if (!targets.length) {
          this.world.log(`${displayItemName(item)} 的范围伤害没有命中目标。`);
          continue;
        }
        for (const targetEntityId of targets) this.world.applyDamage(targetEntityId, amount, damageType, displayItemName(item));
        continue;
      }

      const targetMode = String(applier.target ?? "activation_target");
      const target = resolveEffectTarget(this.world, targetMode, String(event.data.actorId), event.data.target);
      if (target.kind !== "entity" || !target.entityId) {
        this.world.log(`${displayItemName(item)} 需要实体伤害目标。`);
        continue;
      }
      this.world.applyDamage(target.entityId, amount, damageType, displayItemName(item));
    }
  }
}

export class FirearmSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("BeforeItemActivation", (event) => this.onBeforeItemActivation(event));
    world.bus.subscribe("OnItemActivation", (event) => this.onItemActivation(event));
  }

  reload(actorId: string, inventoryIndex: number): void {
    const itemId = this.world.inventory(actorId)[inventoryIndex];
    if (!itemId) {
      this.world.log(`背包索引不存在：${inventoryIndex}`);
      return;
    }
    this.reloadItem(actorId, itemId);
  }

  reloadItem(actorId: string, itemId: string): void {
    const item = this.world.items[itemId];
    if (!item || !this.world.inventory(actorId).includes(itemId)) {
      this.world.log(`物品不在背包中：${itemId}`);
      return;
    }
    if (!item.components.firearm) {
      this.world.log(`${displayItemName(item)} 不是枪械。`);
      return;
    }
    this.startReload(actorId, item, true);
  }

  update(): void {
    const now = this.world.nowMs();
    for (const item of Object.values(this.world.items)) {
      const firearm = item.components.firearm;
      if (!firearm || !firearm._reloadFinishAtMs || Number(firearm._reloadFinishAtMs) > now) continue;
      this.finishReload(item);
    }
  }

  private onBeforeItemActivation(event: EventData): void {
    const item = this.world.items[event.data.itemId];
    const firearm = item?.components.firearm;
    if (!item || !firearm) return;

    const now = this.world.nowMs();
    const reloadFinishAt = Number(firearm._reloadFinishAtMs ?? 0);
    if (reloadFinishAt > now) {
      event.data.cancelReason = `${displayItemName(item)} 正在装填，还需 ${Math.ceil(reloadFinishAt - now)}ms。`;
      return;
    }

    if (magazineRounds(firearm).length > 0) return;
    const started = this.startReload(String(event.data.actorId), item, false);
    event.data.cancelReason = started
      ? `${displayItemName(item)} 弹匣为空，开始装填。`
      : `${displayItemName(item)} 弹匣为空，且背包里没有可用弹药。`;
  }

  private onItemActivation(event: EventData): void {
    const item = this.world.items[event.data.itemId];
    const firearm = item?.components.firearm;
    if (!item || !firearm) return;

    const round = magazineRounds(firearm).shift();
    if (!round) {
      this.world.log(`${displayItemName(item)} 弹匣为空。`);
      return;
    }

    const launched = launchProjectile(this.world, {
      sourceEntityId: String(event.data.actorId),
      sourceItemId: item.instanceId,
      target: event.data.target as Target,
      displayName: `${displayItemName(item)} / ${round.displayName ?? round.ammoProtoId ?? "子弹"}`,
      color: String(firearm.projectileColor ?? round.projectile?.color ?? "#facc15"),
      glyph: String(firearm.projectileGlyph ?? round.projectile?.glyph ?? "•"),
      radius: Number(firearm.projectileRadius ?? round.projectile?.radius ?? 0.07),
      payload: buildFirearmProjectilePayload(firearm, round),
    });
    if (!launched) return;
    this.world.log(`${this.world.entityName(String(event.data.actorId))} 使用 ${displayItemName(item)} 发射 ${round.displayName ?? "子弹"}，弹匣剩余 ${magazineRounds(firearm).length}/${magazineSize(firearm)}。`);
  }

  private startReload(actorId: string, item: ItemInstance, announce: boolean): boolean {
    const firearm = item.components.firearm;
    if (!firearm) return false;
    const loaded = magazineRounds(firearm).length;
    const capacity = magazineSize(firearm);
    if (loaded >= capacity) {
      if (announce) this.world.log(`${displayItemName(item)} 弹匣已满。`);
      return false;
    }
    if (!this.availableAmmoCount(actorId, firearm, item.instanceId)) {
      if (announce) this.world.log(`${displayItemName(item)} 没有可装填的弹药。`);
      return false;
    }

    const reloadMs = Math.max(0, Number(firearm.reloadDurationMs ?? 0));
    firearm._reloadOwnerId = actorId;
    if (reloadMs <= 0) {
      this.finishReload(item);
      return true;
    }
    firearm._reloadFinishAtMs = this.world.nowMs() + reloadMs;
    if (announce) this.world.log(`${displayItemName(item)} 开始装填，需要 ${reloadMs}ms。`);
    return true;
  }

  private finishReload(item: ItemInstance): void {
    const firearm = item.components.firearm;
    if (!firearm) return;
    const ownerId = String(firearm._reloadOwnerId ?? "player");
    const capacity = magazineSize(firearm);
    const needed = Math.max(0, capacity - magazineRounds(firearm).length);
    const rounds = this.takeAmmoRounds(ownerId, firearm, item.instanceId, needed);
    delete firearm._reloadFinishAtMs;
    delete firearm._reloadOwnerId;
    if (!rounds.length) {
      this.world.log(`${displayItemName(item)} 装填失败：没有可用弹药。`);
      return;
    }
    magazineRounds(firearm).push(...rounds);
    this.world.log(`${displayItemName(item)} 装填 ${rounds.length} 发，弹匣 ${magazineRounds(firearm).length}/${capacity}。`);
  }

  private availableAmmoCount(ownerId: string, firearm: JsonObj, firearmItemId: string): number {
    let count = 0;
    for (const itemId of this.world.inventory(ownerId)) {
      if (itemId === firearmItemId) continue;
      const item = this.world.items[itemId];
      if (!item?.components.ammo || !acceptsAmmo(firearm, item.components.ammo)) continue;
      count += itemQuantity(item);
    }
    return count;
  }

  private takeAmmoRounds(ownerId: string, firearm: JsonObj, firearmItemId: string, count: number): JsonObj[] {
    const rounds: JsonObj[] = [];
    const inventory = this.world.inventory(ownerId);
    for (const itemId of [...inventory]) {
      if (rounds.length >= count || itemId === firearmItemId) continue;
      const item = this.world.items[itemId];
      if (!item?.components.ammo || !acceptsAmmo(firearm, item.components.ammo)) continue;
      const quantity = itemQuantity(item);
      const take = Math.min(quantity, count - rounds.length);
      for (let index = 0; index < take; index += 1) rounds.push(makeAmmoRound(item));
      consumeItemQuantity(this.world, ownerId, item, take);
    }
    return rounds;
  }
}

export class ProjectileLauncherSystem {
  constructor(private readonly world: World) {
    world.bus.subscribe("OnItemActivation", (event) => this.onItemActivation(event));
  }

  private onItemActivation(event: EventData): void {
    const item = this.world.items[event.data.itemId];
    const launcher = item?.components.projectile_launcher;
    if (!item || !launcher) return;

    launchProjectile(this.world, {
      sourceEntityId: String(event.data.actorId),
      sourceItemId: item.instanceId,
      target: event.data.target as Target,
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
    if (distanceToTarget <= moveDistance || projectile.remainingDistance <= 0 || !this.world.isInside(next.x, next.y)) {
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
    this.world.addBurst(projectileEntity.entityId, String(projectile.color ?? "#f8fafc"));

    if (hitEntity && Number(projectile.pierce ?? 0) > 0) {
      projectile.pierce = Number(projectile.pierce) - 1;
      projectile.hitEntityIds = [...(projectile.hitEntityIds ?? []), hitEntity.entityId];
      return;
    }
    delete this.world.entities[projectileEntity.entityId];
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
    if (!actor) return;
    const from = actor.components.position ?? { x: 0, y: 0 };
    const [x, y] = target.position;
    if (!this.world.canEntityOccupy(actor.entityId, x, y)) {
      const occupying = this.world.blockingEntityFor(actor.entityId, x, y);
      this.world.log(occupying ? `${occupying.name} 占据了闪现目标。` : "闪现目标不可到达。");
      return;
    }
    actor.components.position = { x: roundCoord(x), y: roundCoord(y) };
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
    if (!this.world.isInside(x, y, this.world.defaultEntityRadius)) {
      this.world.log("生成目标超出地图。");
      return;
    }
    if (!spawner.allowBlocked && this.world.isBlocked(x, y)) {
      this.world.log("生成目标是障碍物，无法孵化。");
      return;
    }
    const occupying = this.world.entityAt(x, y, this.world.defaultEntityRadius);
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
      delete entity.components.active_effects?.[effectId];
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
      delete entity.components.active_effects?.[effectId];
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
      const distance = Math.hypot(actorPosition.x - targetPosition.x, actorPosition.y - targetPosition.y);
      if (distance > range) return `${displayItemName(item)} 超出射程：${formatDistance(distance)}/${range}。`;
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
  const areaCenter = center;

  return Object.values(world.entities)
    .filter((entity) => {
      const position = entity.components.position;
      if (!position || entity.components.projectile) return false;
      const distance = Math.hypot(position.x - areaCenter.x, position.y - areaCenter.y);
      return distance <= radius;
    })
    .map((entity) => entity.entityId);
}

interface ProjectileLaunchOptions {
  sourceEntityId: string;
  sourceItemId?: string;
  target: Target;
  displayName: string;
  color: string;
  glyph: string;
  radius: number;
  payload: JsonObj;
}

function launchProjectile(world: World, options: ProjectileLaunchOptions): boolean {
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

function buildFirearmProjectilePayload(firearm: JsonObj, round: JsonObj): JsonObj {
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

function projectileConfigFromLauncher(launcher: JsonObj): JsonObj {
  const projectile = { ...(cloneOptional(launcher.projectile) ?? {}) };
  projectile.speed = Number(projectile.speed ?? launcher.speed ?? 10);
  projectile.maxDistance = Number(projectile.maxDistance ?? launcher.maxDistance ?? 12);
  projectile.pierce = Number(projectile.pierce ?? launcher.pierce ?? 0);
  return projectile;
}

function magazineRounds(firearm: JsonObj): JsonObj[] {
  firearm.loadedRounds ??= [];
  return firearm.loadedRounds;
}

function magazineSize(firearm: JsonObj): number {
  return Math.max(1, Number(firearm.magazineSize ?? firearm.capacity ?? 1));
}

function acceptsAmmo(firearm: JsonObj, ammo: JsonObj): boolean {
  const accepted = stringList(firearm.acceptedAmmoTypes ?? firearm.ammoTypes ?? firearm.ammoType);
  const ammoType = String(ammo.ammoType ?? "").trim().toLowerCase();
  return accepted.length === 0 || accepted.includes(ammoType);
}

function makeAmmoRound(item: ItemInstance): JsonObj {
  const ammo = item.components.ammo;
  if (!ammo) return { ammoProtoId: item.protoId, displayName: displayItemName(item), ammoType: item.protoId, projectile: {} };
  return {
    ammoProtoId: item.protoId,
    displayName: displayItemName(item),
    ammoType: String(ammo.ammoType ?? item.protoId),
    damage: Number(ammo.damage ?? 0),
    damageType: String(ammo.damageType ?? "generic"),
    areaRadius: ammo.areaRadius,
    impactRadius: ammo.impactRadius,
    damage_applier: cloneOptional(ammo.damage_applier),
    effect_applier: cloneOptional(ammo.effect_applier),
    projectile: cloneOptional(ammo.projectile) ?? {},
  };
}

function itemQuantity(item: ItemInstance): number {
  return Math.max(1, Number(item.components.stacking?.quantity ?? 1));
}

function consumeItemQuantity(world: World, ownerId: string, item: ItemInstance, amount: number): void {
  if (amount <= 0) return;
  const stacking = item.components.stacking;
  if (!stacking || Number(stacking.max ?? 1) <= 1) {
    world.removeInventoryItem(ownerId, item.instanceId);
    return;
  }
  const remaining = itemQuantity(item) - amount;
  if (remaining > 0) {
    stacking.quantity = remaining;
    return;
  }
  world.removeInventoryItem(ownerId, item.instanceId);
}

function findProjectileHit(world: World, projectileEntity: Entity, from: { x: number; y: number }, to: { x: number; y: number }): { entity: Entity; position: { x: number; y: number } } | undefined {
  const projectile = projectileEntity.components.projectile;
  if (!projectile) return undefined;
  const ignored = new Set<string>([projectileEntity.entityId, String(projectile.sourceEntityId ?? ""), ...(projectile.hitEntityIds ?? [])]);
  let best: { entity: Entity; position: { x: number; y: number }; distanceAlong: number } | undefined;
  for (const entity of Object.values(world.entities)) {
    if (ignored.has(entity.entityId) || entity.components.projectile) continue;
    const position = entity.components.position;
    if (!position) continue;
    const hitRadius = world.entityRadius(entity) + Number(projectile.radius ?? 0.05);
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

function applyProjectilePayload(world: World, projectile: JsonObj, impactTarget: Target, impactPosition: [number, number]): void {
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
    for (const targetEntityId of targets) world.applyDamage(targetEntityId, amount, damageType, sourceName);
    return;
  }
  const target = resolveProjectileTarget(world, targetMode, sourceEntityId, impactTarget);
  if (target.kind === "entity" && target.entityId) world.applyDamage(target.entityId, amount, damageType, sourceName);
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

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : deepClone(value);
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  if (typeof value === "string") return [value.trim().toLowerCase()].filter(Boolean);
  return [];
}

function formatDistance(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function roundCoord(value: number): number {
  return Number(value.toFixed(3));
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
  if (attr === "hp" && amount < 0) {
    const damageType = String(periodic.damageType ?? definition.damageType ?? definition.id ?? "effect");
    world.applyDamage(entity.entityId, -amount, damageType, effectName);
    return;
  }
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
