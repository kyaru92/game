import type { FromSchema } from "json-schema-to-ts";
import type {
  activeEffectLayerSchema,
  activeEffectRuntimeSchema,
  ammoRoundSchema,
  ammoSchema,
  castingRuntimeSchema,
  damageApplierSchema,
  effectApplierSchema,
  effectDefinitionSchema,
  effectModifierSchema,
  entityPrototypeComponentsSchema,
  entityRuntimeComponentsSchema,
  firearmRuntimeSchema,
  itemPrototypeComponentsSchema,
  itemRuntimeComponentsSchema,
  periodicEffectSchema,
  projectileConfigSchema,
  projectileLauncherSchema,
  projectileRuntimeSchema,
} from "./componentSchemas";

export type SchemaTypeOptions = {
  keepDefaultedPropertiesOptional: true;
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Target =
  | { kind: "entity"; entityId: string; position?: never }
  | { kind: "position"; position: [number, number]; entityId?: never }
  | { kind: "none"; entityId?: never; position?: never };

export type EffectModifier = FromSchema<typeof effectModifierSchema, SchemaTypeOptions>;
export type PeriodicEffect = FromSchema<typeof periodicEffectSchema, SchemaTypeOptions>;
export type EffectDefinition = FromSchema<typeof effectDefinitionSchema, SchemaTypeOptions>;
export type EffectDefinitions = Record<string, EffectDefinition>;

export type EffectApplier = FromSchema<typeof effectApplierSchema, SchemaTypeOptions>;
export type DamageApplier = FromSchema<typeof damageApplierSchema, SchemaTypeOptions>;
export type ComponentList<T> = T | T[];

export type ProjectileConfig = FromSchema<typeof projectileConfigSchema, SchemaTypeOptions>;
export type ProjectileLauncherComponent = FromSchema<typeof projectileLauncherSchema, SchemaTypeOptions>;
export type ProjectileRuntimeComponent = FromSchema<typeof projectileRuntimeSchema, SchemaTypeOptions> & Record<string, unknown>;
export type AmmoComponent = FromSchema<typeof ammoSchema, SchemaTypeOptions>;
export type AmmoRound = FromSchema<typeof ammoRoundSchema, SchemaTypeOptions>;
export type FirearmComponent = FromSchema<typeof firearmRuntimeSchema, SchemaTypeOptions>;
export type ActiveEffectLayer = FromSchema<typeof activeEffectLayerSchema, SchemaTypeOptions> & Record<string, unknown>;
export type ActiveEffectRuntime = FromSchema<typeof activeEffectRuntimeSchema, SchemaTypeOptions> & Record<string, unknown>;

export type CastingRuntimeComponent = Omit<FromSchema<typeof castingRuntimeSchema, SchemaTypeOptions>, "target"> & {
  target: Target;
};

export type ItemPrototypeComponents = FromSchema<typeof itemPrototypeComponentsSchema, SchemaTypeOptions> & Record<string, unknown>;
export type ItemRuntimeComponents = FromSchema<typeof itemRuntimeComponentsSchema, SchemaTypeOptions> & Record<string, unknown>;
export type EntityPrototypeComponents = FromSchema<typeof entityPrototypeComponentsSchema, SchemaTypeOptions> & Record<string, unknown>;
export type EntityRuntimeComponents = FromSchema<typeof entityRuntimeComponentsSchema, SchemaTypeOptions> & {
  active_effects?: Record<string, ActiveEffectRuntime>;
  casting?: CastingRuntimeComponent;
} & Record<string, unknown>;

export interface ItemDefinition {
  components: ItemPrototypeComponents;
}

export interface EntityDefinition {
  components: EntityPrototypeComponents;
  name?: string;
}

export type ItemDefinitions = Record<string, ItemDefinition>;
export type EntityDefinitions = Record<string, EntityDefinition>;
