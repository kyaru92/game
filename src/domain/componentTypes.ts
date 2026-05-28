import type { AmmoType, AttributeId, DamageType, DamageTypeFilter, TargetSelector } from "./literals";
export type { AmmoType, AttributeId, DamageType, DamageTypeFilter, TargetSelector } from "./literals";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type UnknownObject = Record<string, unknown>;
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? DeepPartial<U>[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export type Target =
  | { kind: "entity"; entityId: string; position?: never }
  | { kind: "position"; position: [number, number]; entityId?: never }
  | { kind: "none"; entityId?: never; position?: never };

export type AttributeMap = Partial<Record<AttributeId, number>> & Record<string, number | undefined>;

export interface EffectModifier {
  attribute: AttributeId;
  op: "add" | "mul" | "override";
  value: number;
  stackType?: "add" | "mul" | "none";
}

export interface PeriodicEffect {
  intervalMs: number;
  attribute: AttributeId;
  op: "add" | "mul";
  value: number;
  stackType?: "add" | "mul" | "none";
  damageType?: DamageType;
}

export interface EffectStacking {
  maxStacks: number;
  overlapBehavior: "refresh_duration" | "independent" | "none";
  onMax?: "refresh_duration" | "reject" | "replace_oldest";
  onOverlap?: "reject" | "refresh_duration" | "replace";
}

export interface EffectDefinition {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  durationMs: number;
  stacking: EffectStacking;
  modifiers?: EffectModifier[];
  periodicEffect?: PeriodicEffect;
}

export interface EffectOverride extends UnknownObject {
  durationMs?: number;
}

export type EffectDefinitions = Record<string, EffectDefinition>;

export interface EffectApplier {
  kind: string;
  chance?: number;
  target?: TargetSelector;
  radius?: number;
  overrides?: EffectOverride;
}

export interface DamageApplier {
  amount: number;
  damageType: DamageType;
  target?: TargetSelector;
  radius?: number;
}

export type ComponentList<T> = T | T[];

export interface ProjectileConfig {
  speed?: number;
  maxDistance?: number;
  pierce?: number;
  radius?: number;
  color?: string;
  glyph?: string;
}

export interface ProjectilePayload {
  projectile?: ProjectileConfig;
  damage_applier?: ComponentList<DamageApplier>;
  effect_applier?: ComponentList<EffectApplier>;
  impactRadius?: number;
}

export interface ProjectileLauncherComponent {
  speed?: number;
  maxDistance?: number;
  pierce?: number;
  radius?: number;
  impactRadius?: number;
  color?: string;
  glyph?: string;
  projectile?: ProjectileConfig;
  damage_applier?: ComponentList<DamageApplier>;
  effect_applier?: ComponentList<EffectApplier>;
}

export interface ProjectileRuntimeComponent extends UnknownObject {
  sourceEntityId: string;
  sourceItemId?: string;
  displayName?: string;
  targetX: number;
  targetY: number;
  vx: number;
  vy: number;
  speed: number;
  maxDistance?: number;
  remainingDistance: number;
  radius?: number;
  pierce?: number;
  color?: string;
  payload: ProjectilePayload;
  hitEntityIds?: string[];
  lastUpdateMs?: number;
}

export interface AmmoComponent {
  ammoType: AmmoType;
  damage?: number;
  damageType?: DamageType;
  impactRadius?: number;
  projectile?: ProjectileConfig;
  damage_applier?: ComponentList<DamageApplier>;
  effect_applier?: ComponentList<EffectApplier>;
}

export interface AmmoRound {
  ammoProtoId: string;
  displayName: string;
  ammoType: AmmoType;
  damage?: number;
  damageType?: DamageType;
  impactRadius?: number;
  damage_applier?: ComponentList<DamageApplier>;
  effect_applier?: ComponentList<EffectApplier>;
  projectile?: ProjectileConfig;
}

export interface FirearmComponent extends UnknownObject {
  acceptedAmmoTypes: AmmoType[];
  magazineSize: number;
  reloadDurationMs: number;
  partialReload?: boolean;
  allowMixedMagazine?: boolean;
  damageBonus?: number;
  damageMultiplier?: number;
  damageType?: DamageType;
  projectileSpeed?: number;
  maxDistance?: number;
  pierce?: number;
  spreadDeg?: number;
  projectileColor?: string;
  projectileGlyph?: string;
  loadedRounds?: AmmoRound[];
  _reloadFinishAtMs?: number;
  _reloadOwnerId?: string;
}

export interface ActiveEffectLayer extends UnknownObject {
  startedAtMs?: number;
  expiresAtMs?: number | null;
  durationMs?: number;
  nextTickAtMs?: number;
}

export interface ActiveEffectRuntime extends ActiveEffectLayer {
  effectId?: string;
  behavior?: EffectStacking["overlapBehavior"];
  stacks?: number;
  sourceEntityId?: string;
  sourceItemId?: string;
  layers?: ActiveEffectLayer[];
}

export interface CastingRuntimeComponent {
  itemId: string;
  itemName: string;
  startedAtMs: number;
  finishAtMs: number;
  target: Target;
}

export interface ItemDisplayComponent {
  name: string;
  description?: string;
  icon?: string;
}

export interface EntityDisplayComponent extends ItemDisplayComponent {
  glyph?: string;
  color?: string;
  strokeColor?: string;
}

export interface StackingComponent {
  max?: number;
  quantity?: number;
  initialQuantity?: number;
}

export interface ActivationComponent {
  maxCharges?: number;
  charges?: number;
  cooldownMs?: number;
  castDurationMs?: number;
  consumeWhenDepleted?: boolean;
  consumeCharge?: boolean;
  _cooldownUntilMs?: number;
}

export interface TargetingComponent {
  mode: "self" | "entity" | "position";
  range?: number;
  default?: string;
}

export interface CatalogComponent {
  category?: "consumable" | "equipment" | "ammo" | "material" | "quest" | "misc";
  tags?: string[];
}

export interface EquipmentComponent {
  slot?: "hand" | "two_hands" | "tool" | "weapon" | "utility";
  primary?: "activate";
  secondary?: "reload" | "none";
}

export interface EntitySpawnerComponent {
  prototype: string;
  entityId?: string;
  name?: string;
  color?: string;
  allowBlocked?: boolean;
  allowOccupied?: boolean;
  overrides?: DeepPartial<EntityRuntimeComponents>;
}

export interface TeleporterComponent {
  who: "self" | "actor" | "user";
  target: "activation_target";
}

export interface ItemPrototypeComponents extends UnknownObject {
  display?: ItemDisplayComponent;
  stacking?: StackingComponent;
  economy?: { baseValue?: number };
  quality?: { value?: "white" | "green" | "blue" | "purple" | "orange" };
  searchable?: { searchDurationMs?: number };
  catalog?: CatalogComponent;
  equipment?: EquipmentComponent;
  targeting?: TargetingComponent;
  effect_applier?: ComponentList<EffectApplier>;
  damage_applier?: ComponentList<DamageApplier>;
  ammo?: AmmoComponent;
  firearm?: FirearmComponent;
  projectile_launcher?: ProjectileLauncherComponent;
  activation?: ActivationComponent;
  teleporter?: TeleporterComponent;
  entity_spawner?: EntitySpawnerComponent;
}

export interface ItemRuntimeComponents extends ItemPrototypeComponents {}

export interface LootQuantity {
  min?: number;
  max?: number;
}

export interface LootEntry {
  item: string;
  chance?: number;
  quantity?: LootQuantity;
}

export interface LootGuaranteeEntry {
  item: string;
  weight: number;
  quantity?: LootQuantity;
}

export interface LootComponent {
  containerPrototype?: string;
  spawnChance?: number;
  entries?: LootEntry[];
  guarantee?: {
    minItems?: number;
    pool?: LootGuaranteeEntry[];
  };
}

export interface LootContainerRuntime {
  title?: string;
  sourceEntityId?: string;
  sourceEntityName?: string;
  createdAtMs?: number;
  hiddenItemIds: string[];
  revealedItemIds: string[];
  currentSearch?: {
    actorId: string;
    itemId: string;
    startedAtMs: number;
    finishAtMs: number;
    durationMs: number;
  };
}

export interface PositionComponent {
  x: number;
  y: number;
}

export type ResourceMap = Partial<Record<"hp" | "max_hp" | "mana" | "max_mana", number>> & Record<string, number | undefined>;

export interface CollisionComponent {
  blocksMovement?: boolean;
  shape?: "circle" | "box";
  radius?: number;
  width?: number;
  height?: number;
  offsetX?: number;
  offsetY?: number;
}

export interface DamageableComponent {
  destructible?: boolean;
  allowedDamageTypes?: DamageTypeFilter[];
  immuneDamageTypes?: DamageTypeFilter[];
}

export interface InteractableComponent {
  kind: "loot_container";
  range?: number;
}

export interface EntityPrototypeComponents extends UnknownObject {
  display?: EntityDisplayComponent;
  position?: PositionComponent;
  resources?: ResourceMap;
  attributes?: AttributeMap;
  inventory?: string[];
  collision?: CollisionComponent;
  damageable?: DamageableComponent;
  obstacle?: { kind?: "destructible" | "fixed" };
  faction?: { id?: string };
  ai?: UnknownObject;
  interactable?: InteractableComponent;
  loot?: LootComponent;
}

export interface EntityRuntimeComponents extends EntityPrototypeComponents {
  active_effects?: Record<string, ActiveEffectRuntime>;
  casting?: CastingRuntimeComponent;
  hotbar?: {
    size?: number;
    slots?: Array<string | null>;
  };
  loadout?: {
    activeItemId?: string;
  };
  projectile?: ProjectileRuntimeComponent;
  loot_container?: LootContainerRuntime;
  _deathLogged?: boolean;
}

export interface ItemDefinition {
  components: ItemPrototypeComponents;
}

export interface EntityDefinition {
  components: EntityPrototypeComponents;
  name?: string;
}

export type ItemDefinitions = Record<string, ItemDefinition>;
export type EntityDefinitions = Record<string, EntityDefinition>;
