import { parseDamageType, parseDamageTypeFilter } from "../../domain/literals";
import type { DamageType, DamageTypeFilter, EntityRuntimeComponents } from "../../domain/componentTypes";
import type { World } from "../world";

type DamageableComponent = NonNullable<EntityRuntimeComponents["damageable"]>;

export class DamageService {
  constructor(private readonly world: World) {}

  applyDamage(entityId: string, amount: number, damageType: DamageType = "generic", sourceName = "伤害"): boolean {
    const entity = this.world.entities[entityId];
    if (!entity || !Number.isFinite(amount) || amount <= 0) return false;

    const damageable = entity.components.damageable ?? {};
    if (damageable.destructible === false) {
      this.world.log(`${entity.name} 是固定障碍，无法被破坏。`);
      return false;
    }

    const normalizedType = parseDamageType(damageType) ?? "generic";
    if (!isDamageTypeAllowed(damageable, normalizedType)) {
      this.world.log(`${entity.name} 不会受到 ${normalizedType} 类型伤害。`);
      return false;
    }

    const resources = entity.components.resources;
    if (!resources || typeof resources.hp !== "number") {
      this.world.log(`${entity.name} 没有可被伤害的生命资源。`);
      return false;
    }

    const before = Number(resources.hp ?? 0);
    const maxHp = Number(resources.max_hp ?? Math.max(before, amount));
    resources.max_hp ??= maxHp;
    resources.hp = Math.max(0, before - amount);
    const delta = before - Number(resources.hp);
    if (delta <= 0) return false;

    this.world.services.vfx.addFloatingText(entityId, `-${formatNumber(delta)} hp`, "#fb7185");
    this.world.log(`${entity.name} 受到 ${sourceName}：${normalizedType} ${formatNumber(delta)}，hp ${formatNumber(before)} -> ${formatNumber(resources.hp)}。`);
    return true;
  }
}

function isDamageTypeAllowed(damageable: DamageableComponent, damageType: DamageType): boolean {
  const allowed = stringList(damageable.allowedDamageTypes);
  const immune = stringList(damageable.immuneDamageTypes);
  if (immune.includes("*") || immune.includes(damageType)) return false;
  return allowed.length === 0 || allowed.includes("*") || allowed.includes(damageType);
}

function stringList(value: DamageTypeFilter[] | undefined): DamageTypeFilter[] {
  return value ? value.map((item) => parseDamageTypeFilter(item)).filter((item): item is DamageTypeFilter => Boolean(item)) : [];
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
