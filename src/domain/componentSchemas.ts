import type { JSONSchema } from "json-schema-to-ts";
import { AMMO_TYPES, ATTRIBUTE_IDS, DAMAGE_TYPE_FILTER_VALUES, DAMAGE_TYPES, targetSelectorValues } from "./literals";
export { AMMO_TYPES, ATTRIBUTE_IDS, DAMAGE_TYPE_FILTER_VALUES, DAMAGE_TYPES, targetSelectorValues } from "./literals";
export type { AttributeId, AmmoType, DamageType, DamageTypeFilter, TargetSelector } from "./literals";

type SchemaObject = Exclude<JSONSchema, boolean>;

const prototypeIdPattern = "^[a-z0-9][a-z0-9_-]*$";
const numberSchema = { type: "number" } as const satisfies JSONSchema;
const nonNegativeNumberSchema = { type: "number", minimum: 0 } as const satisfies JSONSchema;
const nonNegativeIntegerSchema = { type: "integer", minimum: 0 } as const satisfies JSONSchema;
const positiveIntegerSchema = { type: "integer", minimum: 1 } as const satisfies JSONSchema;
const intMsSchema = { type: "integer", minimum: -1 } as const satisfies JSONSchema;
const looseObjectSchema = { type: "object", additionalProperties: true } as const satisfies JSONSchema;
const numericMapSchema = { type: "object", additionalProperties: { type: "number" } } as const satisfies JSONSchema;
const damageTypeSchema = { type: "string", enum: DAMAGE_TYPES } as const satisfies JSONSchema;
const damageTypeFilterSchema = { type: "string", enum: DAMAGE_TYPE_FILTER_VALUES } as const satisfies JSONSchema;
const ammoTypeSchema = { type: "string", enum: AMMO_TYPES } as const satisfies JSONSchema;

export const effectModifierSchema = {
  type: "object",
  additionalProperties: false,
  required: ["attribute", "op", "value"],
  properties: {
    attribute: {
      type: "string",
      enum: ATTRIBUTE_IDS,
      description: "要修改的属性 id。",
    },
    op: {
      type: "string",
      enum: ["add", "mul", "override"],
      description: "add=加法；mul=乘法，value=0.1 表示 +10%；override=覆盖。",
    },
    value: {
      ...numberSchema,
      description: "修改量。add 表示增减固定数值；mul 表示按比例调整；override 表示直接覆盖为该值。",
    },
    stackType: {
      type: "string",
      enum: ["add", "mul", "none"],
      default: "none",
      description: "多层同类 modifier 合并方式。",
    },
  },
} as const satisfies JSONSchema;

export const periodicEffectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["intervalMs", "attribute", "op", "value"],
  properties: {
    intervalMs: { type: "integer", minimum: 1, description: "周期触发间隔，单位毫秒。" },
    attribute: { type: "string", enum: ATTRIBUTE_IDS, description: "周期效果影响的属性 id。" },
    op: { type: "string", enum: ["add", "mul"], description: "周期效果的运算方式。" },
    value: { ...numberSchema, description: "每次周期触发时应用的数值。" },
    stackType: { type: "string", enum: ["add", "mul", "none"], default: "add", description: "多个周期效果叠加时 value 的合并方式。" },
    damageType: { ...damageTypeSchema, description: "当 periodicEffect 扣减 hp 时使用的伤害类型。" },
  },
} as const satisfies JSONSchema;

export const effectStackingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["maxStacks", "overlapBehavior"],
  properties: {
    maxStacks: { type: "integer", minimum: 1, description: "同一 effect 在同一目标上允许同时存在的最大层数。" },
    overlapBehavior: {
      type: "string",
      enum: ["refresh_duration", "independent", "none"],
      description: "重复施加时的基础叠加策略。",
    },
    onMax: {
      type: "string",
      enum: ["refresh_duration", "reject", "replace_oldest"],
      description: "达到 maxStacks 后如何处理新的施加请求。",
    },
    onOverlap: {
      type: "string",
      enum: ["reject", "refresh_duration", "replace"],
      description: "overlapBehavior=none 时，已有 effect 存续期间如何处理新的施加请求。",
    },
  },
} as const satisfies JSONSchema;

export const effectDefinitionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "durationMs", "stacking"],
  properties: {
    id: { type: "string", pattern: prototypeIdPattern, description: "effect 的唯一标识；建议与根对象 key 保持一致。" },
    name: { type: "string", description: "面向玩家或策划展示的效果名称。" },
    description: { type: "string", description: "效果说明文本。" },
    icon: { type: "string", description: "效果图标资源路径或图标 id。" },
    durationMs: { ...intMsSchema, description: "效果持续时间，单位毫秒；-1 表示永久。" },
    stacking: { ...effectStackingSchema, description: "效果叠加与重复施加规则。" },
    modifiers: { type: "array", items: effectModifierSchema, default: [], description: "效果生效期间持续附加的属性修改列表。" },
    periodicEffect: { ...periodicEffectSchema, description: "周期性结算的属性变化。" },
  },
} as const satisfies JSONSchema;

export const activeEffectLayerSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    startedAtMs: { type: "number" },
    expiresAtMs: { type: ["number", "null"] },
    durationMs: { type: "number" },
    nextTickAtMs: { type: "number" },
  },
} as const satisfies JSONSchema;

export const activeEffectRuntimeSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    effectId: { type: "string" },
    behavior: { type: "string", enum: ["refresh_duration", "independent", "none"] },
    stacks: { type: "number" },
    sourceEntityId: { type: "string" },
    sourceItemId: { type: "string" },
    startedAtMs: { type: "number" },
    expiresAtMs: { type: ["number", "null"] },
    durationMs: { type: "number" },
    nextTickAtMs: { type: "number" },
    layers: { type: "array", items: activeEffectLayerSchema },
  },
} as const satisfies JSONSchema;

export const effectOverrideSchema = {
  type: "object",
  additionalProperties: true,
  description: "本次施加时对 effect 定义的局部覆盖。",
  properties: {
    durationMs: { ...intMsSchema, description: "覆盖 effect 定义中的 durationMs。" },
  },
} as const satisfies JSONSchema;

export const effectApplierSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", description: "引用 effect 定义。" },
    chance: { type: "number", minimum: 0, maximum: 1, default: 1, description: "施加该效果的概率，取值 0~1。" },
    target: {
      type: "string",
      enum: targetSelectorValues,
      default: "activation_target",
      description: "效果施加目标。",
    },
    radius: { type: "number", minimum: 0, description: "范围效果半径。" },
    overrides: effectOverrideSchema,
  },
} as const satisfies JSONSchema;

export const damageApplierSchema = {
  type: "object",
  additionalProperties: false,
  required: ["amount", "damageType"],
  properties: {
    amount: { type: "number", minimum: 0, description: "造成的伤害数值。" },
    damageType: { ...damageTypeSchema, description: "伤害类型。" },
    target: {
      type: "string",
      enum: targetSelectorValues,
      default: "activation_target",
      description: "伤害目标。",
    },
    radius: { type: "number", minimum: 0, description: "可选范围伤害半径。" },
  },
} as const satisfies JSONSchema;

export const projectileConfigSchema = {
  type: "object",
  additionalProperties: false,
  description: "投射物飞行参数。",
  properties: {
    speed: { type: "number", minimum: 0.1, description: "飞行速度。" },
    maxDistance: { type: "number", minimum: 0.1, description: "最大飞行距离。" },
    pierce: { type: "integer", minimum: 0, description: "命中后还能继续穿透的目标数量。" },
    radius: { type: "number", minimum: 0.01, description: "投射物碰撞半径。" },
    color: { type: "string", description: "投射物显示颜色。" },
    glyph: { type: "string", description: "投射物显示字符。" },
  },
} as const satisfies JSONSchema;

export const applierListSchema = {
  oneOf: [
    effectApplierSchema,
    { type: "array", items: effectApplierSchema, description: "多个效果施加器列表。" },
  ],
} as const satisfies JSONSchema;

export const damageApplierListSchema = {
  oneOf: [
    damageApplierSchema,
    { type: "array", items: damageApplierSchema, description: "多个伤害施加器列表。" },
  ],
} as const satisfies JSONSchema;

export const ammoSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ammoType"],
  description: "弹药配置。",
  properties: {
    ammoType: { ...ammoTypeSchema, description: "弹药口径/类型。" },
    damage: { type: "number", minimum: 0, description: "子弹基础伤害。" },
    damageType: { ...damageTypeSchema, description: "子弹基础伤害类型。" },
    impactRadius: { type: "number", minimum: 0, description: "命中后基础伤害和命中效果的范围半径。" },
    projectile: projectileConfigSchema,
    damage_applier: { ...damageApplierListSchema, description: "子弹命中时追加的伤害段。" },
    effect_applier: { ...applierListSchema, description: "子弹命中时施加的效果。" },
  },
} as const satisfies JSONSchema;

export const firearmPrototypeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["acceptedAmmoTypes", "magazineSize", "reloadDurationMs"],
  description: "枪械配置。",
  properties: {
    acceptedAmmoTypes: { type: "array", items: ammoTypeSchema, description: "可装填的弹药类型列表。" },
    magazineSize: { type: "integer", minimum: 1, description: "弹匣容量。" },
    reloadDurationMs: { type: "integer", minimum: 0, description: "装填耗时，单位毫秒。" },
    partialReload: { type: "boolean", default: true, description: "是否允许半弹匣补装。" },
    allowMixedMagazine: { type: "boolean", default: true, description: "是否允许弹匣内混装不同弹种。" },
    damageBonus: { type: "number", description: "枪械提供的固定伤害加成。" },
    damageMultiplier: { type: "number", description: "枪械最终伤害倍率；1 表示不变。" },
    damageType: { ...damageTypeSchema, description: "枪械默认伤害类型。" },
    projectileSpeed: { type: "number", minimum: 0.1, description: "默认投射物速度。" },
    maxDistance: { type: "number", minimum: 0.1, description: "默认最大射程。" },
    pierce: { type: "integer", minimum: 0, description: "默认穿透数量。" },
    spreadDeg: { type: "number", minimum: 0, description: "预留：散布角度。" },
    projectileColor: { type: "string", description: "枪械发射投射物默认颜色。" },
    projectileGlyph: { type: "string", description: "枪械发射投射物默认字符。" },
  },
} as const satisfies JSONSchema;

export const ammoRoundSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ammoProtoId", "displayName", "ammoType"],
  properties: {
    ammoProtoId: { type: "string" },
    displayName: { type: "string" },
    ammoType: ammoTypeSchema,
    damage: { type: "number" },
    damageType: damageTypeSchema,
    impactRadius: { type: "number" },
    damage_applier: damageApplierListSchema,
    effect_applier: applierListSchema,
    projectile: projectileConfigSchema,
  },
} as const satisfies JSONSchema;

export const firearmRuntimeSchema = {
  ...firearmPrototypeSchema,
  properties: {
    ...firearmPrototypeSchema.properties,
    loadedRounds: { type: "array", items: ammoRoundSchema, description: "运行时弹匣内容。" },
    _reloadFinishAtMs: { type: "number", description: "运行时装填完成时间。" },
    _reloadOwnerId: { type: "string", description: "运行时装填者。" },
  },
} as const satisfies JSONSchema;

export const projectileLauncherSchema = {
  type: "object",
  additionalProperties: false,
  description: "通用投射物发射器。",
  properties: {
    speed: { type: "number", minimum: 0.1, description: "投射物速度。" },
    maxDistance: { type: "number", minimum: 0.1, description: "最大飞行距离。" },
    pierce: { type: "integer", minimum: 0, description: "穿透目标数量。" },
    radius: { type: "number", minimum: 0.01, description: "投射物碰撞半径。" },
    impactRadius: { type: "number", minimum: 0, description: "命中后默认范围半径。" },
    color: { type: "string", description: "投射物颜色。" },
    glyph: { type: "string", description: "投射物显示字符。" },
    projectile: projectileConfigSchema,
    damage_applier: { ...damageApplierListSchema, description: "命中时造成的伤害；不填则复用物品根 damage_applier。" },
    effect_applier: { ...applierListSchema, description: "命中时施加的效果；不填则复用物品根 effect_applier。" },
  },
} as const satisfies JSONSchema;

export const itemDisplaySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", description: "物品显示名称。" },
    description: { type: "string", description: "物品说明文本。" },
    icon: { type: "string", description: "物品图标资源路径或图标 id。" },
  },
} as const satisfies JSONSchema;

export const entityDisplaySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", description: "实体显示名称。" },
    description: { type: "string", description: "实体说明。" },
    glyph: { type: "string", description: "Canvas 上显示的短字符。" },
    color: { type: "string", description: "实体主体颜色。" },
    strokeColor: { type: "string", description: "实体描边颜色。" },
    icon: { type: "string", description: "实体图标资源路径或图标 id。" },
  },
} as const satisfies JSONSchema;

export const stackingSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    max: { type: "integer", minimum: 1, description: "单个堆叠槽允许的最大数量。" },
    quantity: { type: "integer", minimum: 1, description: "运行时/测试用当前堆叠数量。" },
    initialQuantity: { type: "integer", minimum: 1, description: "创建物品实例时的初始堆叠数量。" },
  },
} as const satisfies JSONSchema;

export const activationPrototypeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    maxCharges: { type: "integer", minimum: 0, description: "最大充能/可使用次数。" },
    charges: { type: "integer", minimum: 0, description: "当前剩余充能/可使用次数。" },
    cooldownMs: { type: "integer", minimum: 0, description: "每次激活后的冷却时间。" },
    castDurationMs: { type: "integer", minimum: 0, description: "激活前摇/施法耗时。" },
    consumeWhenDepleted: { type: "boolean", default: true, description: "充能耗尽后是否消耗或移除该物品。" },
    consumeCharge: { type: "boolean", default: true, description: "每次激活是否扣除 charges。" },
  },
} as const satisfies JSONSchema;

export const activationRuntimeSchema = {
  ...activationPrototypeSchema,
  properties: {
    ...activationPrototypeSchema.properties,
    _cooldownUntilMs: { type: "number", description: "运行时冷却结束时间。" },
  },
} as const satisfies JSONSchema;

export const targetingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: ["self", "entity", "position"], description: "选择目标的方式。" },
    range: { type: "number", minimum: 0, description: "可选目标的最大距离。" },
    default: { type: "string", description: "未显式选择目标时使用的默认目标标识。" },
  },
} as const satisfies JSONSchema;

export const lootQuantitySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    min: { type: "integer", minimum: 1, description: "随机数量下限。" },
    max: { type: "integer", minimum: 1, description: "随机数量上限。" },
  },
} as const satisfies JSONSchema;

export const lootEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["item"],
  properties: {
    item: { type: "string", pattern: prototypeIdPattern, description: "掉落的 item prototype id。" },
    chance: { type: "number", minimum: 0, maximum: 1, default: 1, description: "独立掉落概率，0~1。" },
    quantity: { ...lootQuantitySchema, description: "堆叠物品的随机数量。" },
  },
} as const satisfies JSONSchema;

export const lootGuaranteeEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["item", "weight"],
  properties: {
    item: { type: "string", pattern: prototypeIdPattern, description: "保底池 item prototype id。" },
    weight: { type: "number", minimum: 0, description: "保底池抽取权重。" },
    quantity: { ...lootQuantitySchema, description: "堆叠物品的随机数量。" },
  },
} as const satisfies JSONSchema;

export const lootComponentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    containerPrototype: { type: "string", pattern: prototypeIdPattern, default: "loot-crate", description: "死亡后生成的箱子 entity prototype id。" },
    spawnChance: { type: "number", minimum: 0, maximum: 1, default: 1, description: "生成箱子的概率；默认必定生成。" },
    entries: { type: "array", items: lootEntrySchema, default: [], description: "普通掉落列表；每项独立按 chance 掷骰。" },
    guarantee: {
      type: "object",
      additionalProperties: false,
      properties: {
        minItems: { type: "integer", minimum: 1, default: 1, description: "普通掉落不足时，保底到至少多少件。" },
        pool: { type: "array", items: lootGuaranteeEntrySchema, default: [], description: "保底权重池。" },
      },
    },
  },
} as const satisfies JSONSchema;

export const interactableSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["loot_container"], description: "交互类型。" },
    range: { type: "number", minimum: 0, default: 1.2, description: "玩家可交互距离。" },
  },
} as const satisfies JSONSchema;

export const lootContainerRuntimeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hiddenItemIds", "revealedItemIds"],
  properties: {
    title: { type: "string", description: "箱子界面标题。" },
    sourceEntityId: { type: "string", description: "来源实体 id。" },
    sourceEntityName: { type: "string", description: "来源实体名称。" },
    createdAtMs: { type: "number", description: "运行时创建时间。" },
    hiddenItemIds: { type: "array", items: { type: "string" }, description: "尚未发现的 item instance id；UI 不应直接展示。" },
    revealedItemIds: { type: "array", items: { type: "string" }, description: "已搜索发现、可拿取的 item instance id。" },
    currentSearch: {
      type: "object",
      additionalProperties: false,
      required: ["actorId", "itemId", "startedAtMs", "finishAtMs", "durationMs"],
      properties: {
        actorId: { type: "string" },
        itemId: { type: "string" },
        startedAtMs: { type: "number" },
        finishAtMs: { type: "number" },
        durationMs: { type: "number" },
      },
    },
  },
} as const satisfies JSONSchema;

export const catalogSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    category: { type: "string", enum: ["consumable", "equipment", "ammo", "material", "quest", "misc"], description: "UI/整理分类。" },
    tags: { type: "array", items: { type: "string" }, description: "额外标签。" },
  },
} as const satisfies JSONSchema;

export const equipmentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    slot: { type: "string", enum: ["hand", "two_hands", "tool", "weapon", "utility"], default: "hand", description: "装备占用的逻辑槽位。" },
    primary: { type: "string", enum: ["activate"], default: "activate", description: "主要动作。" },
    secondary: { type: "string", enum: ["reload", "none"], default: "none", description: "次要动作。" },
  },
} as const satisfies JSONSchema;

export const itemPrototypeComponentsSchema = {
  type: "object",
  additionalProperties: true,
  description: "物品原型组件集合；未知组件允许通过以便扩展。",
  properties: {
    display: itemDisplaySchema,
    stacking: stackingSchema,
    economy: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseValue: { type: "number", minimum: 0, description: "物品基础价值。" },
      },
    },
    quality: {
      type: "object",
      additionalProperties: false,
      properties: {
        value: { type: "string", enum: ["white", "green", "blue", "purple", "orange"], description: "品质等级。" },
      },
    },
    searchable: {
      type: "object",
      additionalProperties: false,
      properties: {
        searchDurationMs: { type: "integer", minimum: 0, description: "完成搜索所需时间，单位毫秒。" },
      },
    },
    catalog: catalogSchema,
    equipment: equipmentSchema,
    targeting: targetingSchema,
    effect_applier: { ...applierListSchema, description: "激活或触发时施加的效果。" },
    damage_applier: { ...damageApplierListSchema, description: "激活时造成即时伤害。" },
    ammo: ammoSchema,
    firearm: firearmPrototypeSchema,
    projectile_launcher: projectileLauncherSchema,
    activation: activationPrototypeSchema,
    teleporter: {
      type: "object",
      additionalProperties: false,
      required: ["who", "target"],
      properties: {
        who: { type: "string", enum: ["self", "actor", "user"], description: "被传送的实体。" },
        target: { type: "string", enum: ["activation_target"], description: "传送目的地。" },
      },
    },
    entity_spawner: {
      type: "object",
      additionalProperties: false,
      required: ["prototype"],
      properties: {
        prototype: { type: "string", description: "引用 entity prototype id。" },
        entityId: { type: "string", pattern: prototypeIdPattern, description: "可选：指定生成实体 id。" },
        name: { type: "string", description: "可选：覆盖生成实体显示名称。" },
        color: { type: "string", description: "可选：覆盖生成时的视觉提示颜色。" },
        allowBlocked: { type: "boolean", default: false, description: "是否允许生成在不可通行区域。" },
        allowOccupied: { type: "boolean", default: false, description: "是否允许生成在已有实体附近。" },
        overrides: { type: "object", additionalProperties: true, description: "对 entity prototype.components 的局部覆盖。" },
      },
    },
  },
} as const satisfies JSONSchema;

export const itemRuntimeComponentsSchema = {
  ...itemPrototypeComponentsSchema,
  description: "物品运行时组件集合。",
  properties: {
    ...itemPrototypeComponentsSchema.properties,
    activation: activationRuntimeSchema,
    firearm: firearmRuntimeSchema,
  },
} as const satisfies JSONSchema;

export const positionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: {
    x: { type: "number", minimum: 0, description: "世界 x 坐标。" },
    y: { type: "number", minimum: 0, description: "世界 y 坐标。" },
  },
} as const satisfies JSONSchema;

export const collisionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    blocksMovement: { type: "boolean", default: true, description: "是否阻挡移动。" },
    shape: { type: "string", enum: ["circle", "box"], default: "circle", description: "碰撞体形状。" },
    radius: { type: "number", minimum: 0, description: "圆形碰撞半径。" },
    width: { type: "number", minimum: 0, description: "碰撞箱宽度。" },
    height: { type: "number", minimum: 0, description: "碰撞箱高度。" },
    offsetX: { type: "number", description: "碰撞体中心相对 position.x 的偏移。" },
    offsetY: { type: "number", description: "碰撞体中心相对 position.y 的偏移。" },
  },
} as const satisfies JSONSchema;

export const castingRuntimeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["itemId", "itemName", "startedAtMs", "finishAtMs", "target"],
  properties: {
    itemId: { type: "string" },
    itemName: { type: "string" },
    startedAtMs: { type: "number" },
    finishAtMs: { type: "number" },
    target: looseObjectSchema,
  },
} as const satisfies JSONSchema;

export const projectileRuntimeSchema = {
  type: "object",
  additionalProperties: true,
  required: ["sourceEntityId", "targetX", "targetY", "vx", "vy", "speed", "remainingDistance", "payload"],
  properties: {
    sourceEntityId: { type: "string" },
    sourceItemId: { type: "string" },
    displayName: { type: "string" },
    targetX: { type: "number" },
    targetY: { type: "number" },
    vx: { type: "number" },
    vy: { type: "number" },
    speed: { type: "number" },
    maxDistance: { type: "number" },
    remainingDistance: { type: "number" },
    radius: { type: "number" },
    pierce: { type: "number" },
    color: { type: "string" },
    payload: looseObjectSchema,
    hitEntityIds: { type: "array", items: { type: "string" } },
    lastUpdateMs: { type: "number" },
  },
} as const satisfies JSONSchema;

export const entityPrototypeComponentsSchema = {
  type: "object",
  additionalProperties: true,
  description: "实体原型组件集合；未知组件允许通过以便扩展。",
  properties: {
    display: entityDisplaySchema,
    position: positionSchema,
    resources: {
      ...numericMapSchema,
      description: "可消耗资源。",
      properties: {
        hp: nonNegativeNumberSchema,
        max_hp: nonNegativeNumberSchema,
        mana: nonNegativeNumberSchema,
        max_mana: nonNegativeNumberSchema,
      },
    },
    attributes: {
      ...numericMapSchema,
      description: "实体属性。",
      properties: Object.fromEntries(ATTRIBUTE_IDS.map((id) => [id, numberSchema])),
    },
    inventory: { type: "array", items: { type: "string" }, description: "实体持有的 item instance id 列表。" },
    collision: collisionSchema,
    damageable: {
      type: "object",
      additionalProperties: false,
      properties: {
        destructible: { type: "boolean", default: true, description: "是否可被伤害或破坏。" },
        allowedDamageTypes: { type: "array", items: damageTypeFilterSchema, description: "允许造成伤害的类型。" },
        immuneDamageTypes: { type: "array", items: damageTypeFilterSchema, description: "免疫的伤害类型。" },
      },
    },
    obstacle: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["destructible", "fixed"], description: "障碍类型。" },
      },
    },
    faction: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "阵营 id。" },
      },
    },
    ai: looseObjectSchema,
    interactable: interactableSchema,
    loot: lootComponentSchema,
  },
} as const satisfies JSONSchema;

export const entityRuntimeComponentsSchema = {
  ...entityPrototypeComponentsSchema,
  description: "实体运行时组件集合。",
  properties: {
    ...entityPrototypeComponentsSchema.properties,
    active_effects: { type: "object", additionalProperties: activeEffectRuntimeSchema },
    casting: castingRuntimeSchema,
    hotbar: {
      type: "object",
      additionalProperties: false,
      properties: {
        size: { type: "integer", minimum: 1 },
        slots: { type: "array", items: { type: ["string", "null"] } },
      },
    },
    loadout: {
      type: "object",
      additionalProperties: false,
      properties: {
        activeItemId: { type: "string" },
      },
    },
    projectile: projectileRuntimeSchema,
    loot_container: lootContainerRuntimeSchema,
    _deathLogged: { type: "boolean" },
  },
} as const satisfies JSONSchema;

export const itemDefinitionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["components"],
  properties: {
    components: itemPrototypeComponentsSchema,
  },
} as const satisfies JSONSchema;

export const entityDefinitionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["components"],
  properties: {
    components: entityPrototypeComponentsSchema,
  },
} as const satisfies JSONSchema;

export function createEffectDefinitionsSchema(): JSONSchema {
  return {
    $id: "ecs://schema/effect.schema.json",
    title: "Effect Definitions",
    description: "effect.jsonc 根对象：key 是 effect id，value 是 effect 定义。",
    type: "object",
    additionalProperties: false,
    patternProperties: {
      [prototypeIdPattern]: effectDefinitionSchema,
    },
  };
}

export function createItemDefinitionsSchema(options: { effectIds?: readonly string[]; entityIds?: readonly string[] } = {}): JSONSchema {
  return {
    $id: "ecs://schema/item.schema.json",
    title: "Item Definitions",
    description: "item.jsonc 根对象：key 是 item prototype id，value.components 是组件集合。",
    type: "object",
    additionalProperties: false,
    patternProperties: {
      [prototypeIdPattern]: makeItemDefinitionSchema(options),
    },
  };
}

export function createEntityDefinitionsSchema(options: { itemIds?: readonly string[]; entityIds?: readonly string[] } = {}): JSONSchema {
  return {
    $id: "ecs://schema/entity.schema.json",
    title: "Entity Definitions",
    description: "entity.jsonc 根对象：key 是 entity prototype id，value.components 是组件集合。",
    type: "object",
    additionalProperties: false,
    patternProperties: {
      [prototypeIdPattern]: makeEntityDefinitionSchema(options),
    },
  };
}

function makeItemDefinitionSchema(options: { effectIds?: readonly string[]; entityIds?: readonly string[] }): SchemaObject {
  return {
    ...itemDefinitionSchema,
    properties: {
      components: makeItemComponentsSchema(options),
    },
  };
}

function makeEntityDefinitionSchema(options: { itemIds?: readonly string[]; entityIds?: readonly string[] }): SchemaObject {
  return {
    ...entityDefinitionSchema,
    properties: {
      components: makeEntityComponentsSchema(options),
    },
  };
}

function makeEntityComponentsSchema(options: { itemIds?: readonly string[]; entityIds?: readonly string[] }): SchemaObject {
  const itemReference = makeItemReferenceSchema(options.itemIds);
  const entityReference = makeEntityReferenceSchema(options.entityIds);
  return {
    ...entityPrototypeComponentsSchema,
    properties: {
      ...entityPrototypeComponentsSchema.properties,
      loot: makeLootComponentSchema(itemReference, entityReference),
    },
  };
}

function makeLootComponentSchema(itemReference: SchemaObject, entityReference: SchemaObject): SchemaObject {
  return {
    ...lootComponentSchema,
    properties: {
      ...lootComponentSchema.properties,
      containerPrototype: { ...entityReference, default: "loot-crate", description: "死亡后生成的箱子 entity prototype id。" },
      entries: {
        type: "array",
        items: makeLootEntrySchema(lootEntrySchema, itemReference),
        default: [],
        description: "普通掉落列表；每项独立按 chance 掷骰。",
      },
      guarantee: {
        ...lootComponentSchema.properties.guarantee,
        properties: {
          ...lootComponentSchema.properties.guarantee.properties,
          pool: {
            type: "array",
            items: makeLootEntrySchema(lootGuaranteeEntrySchema, itemReference),
            default: [],
            description: "保底权重池。",
          },
        },
      },
    },
  };
}

function makeLootEntrySchema(base: typeof lootEntrySchema | typeof lootGuaranteeEntrySchema, itemReference: SchemaObject): SchemaObject {
  return {
    ...base,
    properties: {
      ...base.properties,
      item: itemReference,
    },
  };
}

function makeItemComponentsSchema(options: { effectIds?: readonly string[]; entityIds?: readonly string[] }): SchemaObject {
  const effectApplier = makeEffectApplierSchema(options.effectIds);
  const damageApplier = damageApplierSchema;
  const effectApplierList = oneOrMany(effectApplier);
  const damageApplierList = oneOrMany(damageApplier);
  return {
    ...itemPrototypeComponentsSchema,
    properties: {
      ...itemPrototypeComponentsSchema.properties,
      effect_applier: { ...effectApplierList, description: "激活或触发时施加的效果。" },
      damage_applier: { ...damageApplierList, description: "激活时造成即时伤害。" },
      ammo: {
        ...ammoSchema,
        properties: {
          ...ammoSchema.properties,
          effect_applier: { ...effectApplierList, description: "子弹命中时施加的效果。" },
          damage_applier: { ...damageApplierList, description: "子弹命中时追加的伤害段。" },
        },
      },
      projectile_launcher: {
        ...projectileLauncherSchema,
        properties: {
          ...projectileLauncherSchema.properties,
          effect_applier: { ...effectApplierList, description: "命中时施加的效果；不填则复用物品根 effect_applier。" },
          damage_applier: { ...damageApplierList, description: "命中时造成的伤害；不填则复用物品根 damage_applier。" },
        },
      },
      entity_spawner: {
        ...itemPrototypeComponentsSchema.properties.entity_spawner,
        properties: {
          ...itemPrototypeComponentsSchema.properties.entity_spawner.properties,
          prototype: makeEntityReferenceSchema(options.entityIds),
        },
      },
    },
  };
}

function makeEffectApplierSchema(effectIds: readonly string[] | undefined): SchemaObject {
  return {
    ...effectApplierSchema,
    properties: {
      ...effectApplierSchema.properties,
      kind: makeEffectReferenceSchema(effectIds),
    },
  };
}

function makeEffectReferenceSchema(effectIds: readonly string[] | undefined): SchemaObject {
  const sorted = [...(effectIds ?? [])].sort();
  return sorted.length
    ? { type: "string", enum: sorted, description: "引用 effect.jsonc 中存在的 effect id。" }
    : { type: "string", description: "引用 effect.jsonc 中的 effect id。" };
}

function makeEntityReferenceSchema(entityIds: readonly string[] | undefined): SchemaObject {
  const sorted = [...(entityIds ?? [])].sort();
  return sorted.length
    ? { type: "string", enum: sorted, description: "引用 entity.jsonc 中存在的 entity prototype id。" }
    : { type: "string", pattern: prototypeIdPattern, description: "引用 entity.jsonc 中的 entity prototype id。" };
}

function makeItemReferenceSchema(itemIds: readonly string[] | undefined): SchemaObject {
  const sorted = [...(itemIds ?? [])].sort();
  return sorted.length
    ? { type: "string", enum: sorted, description: "引用 item.jsonc 中存在的 item prototype id。" }
    : { type: "string", pattern: prototypeIdPattern, description: "引用 item.jsonc 中的 item prototype id。" };
}

function oneOrMany(item: JSONSchema): SchemaObject {
  return {
    oneOf: [
      item,
      { type: "array", items: item },
    ],
  };
}
