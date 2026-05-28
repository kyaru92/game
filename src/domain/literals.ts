export const ATTRIBUTE_IDS = [
  "hp",
  "max_hp",
  "move_speed",
  "attack_speed",
  "armor",
  "mana",
  "max_mana",
] as const;

export type AttributeId = (typeof ATTRIBUTE_IDS)[number];

export const DAMAGE_TYPES = [
  "generic",
  "impact",
  "piercing",
  "fire",
  "poison",
] as const;

export type DamageType = (typeof DAMAGE_TYPES)[number];

export const DAMAGE_TYPE_FILTER_VALUES = ["*", ...DAMAGE_TYPES] as const;
export type DamageTypeFilter = (typeof DAMAGE_TYPE_FILTER_VALUES)[number];

export const AMMO_TYPES = ["9mm"] as const;
export type AmmoType = (typeof AMMO_TYPES)[number];

export const targetSelectorValues = [
  "self",
  "actor",
  "user",
  "activation_target",
  "impact_target",
  "impact_area",
  "activation_area",
  "@player",
  "@me",
  "@who",
  "@dummy",
] as const;

export type TargetSelector = (typeof targetSelectorValues)[number];

const DAMAGE_TYPE_SET: ReadonlySet<string> = new Set(DAMAGE_TYPES);
const DAMAGE_TYPE_FILTER_SET: ReadonlySet<string> = new Set(DAMAGE_TYPE_FILTER_VALUES);

export function parseDamageType(value: string | undefined): DamageType | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && DAMAGE_TYPE_SET.has(normalized) ? (normalized as DamageType) : undefined;
}

export function parseDamageTypeFilter(value: string | undefined): DamageTypeFilter | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && DAMAGE_TYPE_FILTER_SET.has(normalized) ? (normalized as DamageTypeFilter) : undefined;
}
