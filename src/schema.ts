import type { JSONSchema7 } from "json-schema";

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

const numberLike: JSONSchema7 = { type: "number" };
const intMs: JSONSchema7 = { type: "integer", minimum: -1 };

export const effectModelUri = "inmemory://ecs/effect.jsonc";
export const itemModelUri = "inmemory://ecs/item.jsonc";
export const entityModelUri = "inmemory://ecs/entity.jsonc";

export function createEffectSchema(): JSONSchema7 {
  const modifierSchema: JSONSchema7 = {
    type: "object",
    additionalProperties: false,
    required: ["attribute", "op", "value"],
    properties: {
      attribute: {
        type: "string",
        enum: [...ATTRIBUTE_IDS],
        description: "要修改的属性 id。",
      },
      op: {
        type: "string",
        enum: ["add", "mul", "override"],
        description: "add=加法；mul=乘法，value=0.1 表示 +10%；override=覆盖。",
      },
      value: {
        ...numberLike,
        description: "修改量。add 表示增减固定数值；mul 表示按比例调整（例如 0.1 为 +10%）；override 表示直接覆盖为该值。",
      },
      stackType: {
        type: "string",
        enum: ["add", "mul", "none"],
        default: "none",
        description: "多层同类 modifier 合并方式：add=数值相加；mul=倍率相乘；none=不额外合并。",
      },
    },
  };

  const periodicSchema: JSONSchema7 = {
    type: "object",
    additionalProperties: false,
    required: ["intervalMs", "attribute", "op", "value"],
    properties: {
      intervalMs: { type: "integer", minimum: 1, description: "周期触发间隔，单位毫秒；每隔该时间结算一次 periodicEffect。" },
      attribute: { type: "string", enum: [...ATTRIBUTE_IDS], description: "周期效果影响的属性 id。" },
      op: { type: "string", enum: ["add", "mul"], description: "周期效果的运算方式：add=每跳增减固定值；mul=每跳按比例调整。" },
      value: { ...numberLike, description: "每次周期触发时应用的数值。" },
      stackType: { type: "string", enum: ["add", "mul", "none"], default: "add", description: "多个周期效果叠加时 value 的合并方式。" },
    },
  };

  const stackingSchema: JSONSchema7 = {
    type: "object",
    additionalProperties: false,
    required: ["maxStacks", "overlapBehavior"],
    properties: {
      maxStacks: { type: "integer", minimum: 1, description: "同一 effect 在同一目标上允许同时存在的最大层数。" },
      overlapBehavior: {
        type: "string",
        enum: ["refresh_duration", "independent", "none"],
        description: "重复施加时的基础叠加策略：refresh_duration=刷新持续时间；independent=每层独立计时；none=不允许自然叠加。",
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
  };

  const effectDefinition: JSONSchema7 = {
    type: "object",
    additionalProperties: false,
    required: ["id", "name", "durationMs", "stacking"],
    properties: {
      id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$", description: "effect 的唯一标识；建议与根对象 key 保持一致，只使用小写字母、数字、下划线或短横线。" },
      name: { type: "string", description: "面向玩家或策划展示的效果名称。" },
      description: { type: "string", description: "效果说明文本，可描述持续时间、属性变化、触发条件等。" },
      icon: { type: "string", description: "效果图标资源路径或图标 id。" },
      durationMs: { ...intMs, description: "效果持续时间，单位毫秒；-1 通常表示永久或由外部逻辑控制结束。" },
      stacking: { ...stackingSchema, description: "效果叠加与重复施加规则。" },
      modifiers: { type: "array", items: modifierSchema, default: [], description: "效果生效期间持续附加的属性修改列表。" },
      periodicEffect: { ...periodicSchema, description: "周期性结算的属性变化，例如持续回血、掉血或回蓝。" },
    },
  };

  return {
    $id: "ecs://schema/effect.schema.json",
    title: "Effect Definitions",
    description: "effect.jsonc 根对象：key 是 effect id，value 是 effect 定义。",
    type: "object",
    additionalProperties: false,
    patternProperties: {
      "^[a-z0-9][a-z0-9_-]*$": effectDefinition,
    },
  };
}

export function createItemSchema(effectIds: readonly string[], entityIds: readonly string[] = []): JSONSchema7 {
  const effectKindSchema: JSONSchema7 = effectIds.length
    ? {
        type: "string",
        enum: [...effectIds].sort(),
        description: "引用 effect.jsonc 中存在的 effect id。",
      }
    : { type: "string", description: "引用 effect.jsonc 中的 effect id；当前未加载到可枚举的 effect 列表。" };

  const entityKindSchema: JSONSchema7 = entityIds.length
    ? {
        type: "string",
        enum: [...entityIds].sort(),
        description: "引用 entity.jsonc 中存在的 entity prototype id。",
      }
    : { type: "string", description: "引用 entity.jsonc 中的 entity prototype id；当前未加载到可枚举的 entity 列表。" };

  const effectOverrideSchema: JSONSchema7 = {
    type: "object",
    additionalProperties: true,
    description: "本次施加时对 effect 定义的局部覆盖；例如 { durationMs: 20000 }。",
    properties: {
      durationMs: { ...intMs, description: "覆盖 effect 定义中的 durationMs，单位毫秒；-1 表示永久或由外部逻辑控制。" },
    },
  };

  const effectApplierSchema: JSONSchema7 = {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: {
      kind: effectKindSchema,
      chance: { type: "number", minimum: 0, maximum: 1, default: 1, description: "施加该效果的概率，取值 0~1；1 表示必定触发。" },
      target: {
        type: "string",
        enum: ["self", "actor", "user", "activation_target", "@player", "@me", "@who", "@dummy"],
        default: "activation_target",
        description: "效果施加目标：self=物品自身；actor/user=使用者；activation_target=本次激活选中的目标；@* 为调试或兼容别名。",
      },
      overrides: effectOverrideSchema,
    },
  };

  const activationSchema: JSONSchema7 = {
    type: "object",
    additionalProperties: false,
    properties: {
      max: { type: "integer", minimum: 0, description: "兼容字段：MVP 中解释为 maxCharges，表示最大可用次数。" },
      maxCharges: { type: "integer", minimum: 0, description: "最大充能/可使用次数；0 表示不可使用或由外部逻辑控制。" },
      charges: { type: "integer", minimum: 0, description: "当前剩余充能/可使用次数；通常不应超过 maxCharges。" },
      cooldownMs: { type: "integer", minimum: 0, description: "每次激活后的冷却时间，单位毫秒。" },
      castDurationMs: { type: "integer", minimum: 0, description: "激活前摇/施法耗时，单位毫秒；0 表示立即生效。" },
      consumeWhenDepleted: { type: "boolean", default: true, description: "充能耗尽后是否消耗或移除该物品。" },
    },
  };

  const targetingSchema: JSONSchema7 = {
    type: "object",
    additionalProperties: false,
    required: ["mode"],
    properties: {
      mode: { type: "string", enum: ["self", "entity", "position"], description: "选择目标的方式：self=自身；entity=实体目标；position=位置目标。" },
      range: { type: "number", minimum: 0, description: "可选目标的最大距离或作用范围，单位由游戏逻辑定义。" },
      default: { type: "string", description: "未显式选择目标时使用的默认目标标识。" },
    },
  };

  const componentsSchema: JSONSchema7 = {
    type: "object",
    additionalProperties: true,
    description: "物品组件集合；已知组件会提供结构校验和中文提示，未知组件允许通过以便扩展。",
    properties: {
      display: {
        type: "object",
        additionalProperties: false,
        description: "物品展示信息，用于 UI、提示框、搜索结果等可视化场景。",
        required: ["name"],
        properties: {
          name: { type: "string", description: "物品显示名称。" },
          description: { type: "string", description: "物品说明文本，可描述用途、效果或背景。" },
          icon: { type: "string", description: "物品图标资源路径或图标 id。" },
        },
      },
      stacking: {
        type: "object",
        additionalProperties: false,
        description: "物品堆叠规则，控制同类物品在背包或容器中的合并数量。",
        properties: {
          max: { type: "integer", minimum: 1, description: "单个堆叠槽允许的最大数量。" },
        },
      },
      economy: {
        type: "object",
        additionalProperties: false,
        description: "物品经济属性，用于商店、掉落价值或回收计算。",
        properties: {
          baseValue: { type: "number", minimum: 0, description: "物品基础价值；实际买卖价格可由品质、折扣或系统规则修正。" },
        },
      },
      quality: {
        type: "object",
        additionalProperties: false,
        description: "物品品质/稀有度配置，通常影响颜色、掉落权重或数值强度。",
        properties: {
          value: { type: "string", enum: ["white", "green", "blue", "purple", "orange"], description: "品质等级：white=普通；green=优秀；blue=稀有；purple=史诗；orange=传说。" },
        },
      },
      searchable: {
        type: "object",
        additionalProperties: false,
        description: "可被搜索/搜刮的物品或容器配置。",
        properties: {
          searchDurationMs: { type: "integer", minimum: 0, description: "完成搜索所需时间，单位毫秒；0 表示立即完成。" },
        },
      },
      targeting: { ...targetingSchema, description: "物品激活时的目标选择规则。" },
      effect_applier: {
        description: "激活或触发时施加的效果；可填写单个 effect_applier，或数组表示依次尝试施加多个效果。",
        oneOf: [effectApplierSchema, { type: "array", items: effectApplierSchema, description: "多个效果施加器列表。" }],
      },
      activation: { ...activationSchema, description: "物品可主动使用时的激活、充能与冷却配置。" },
      teleporter: {
        type: "object",
        additionalProperties: false,
        description: "传送组件：将指定实体移动到激活目标位置。",
        required: ["who", "target"],
        properties: {
          who: { type: "string", enum: ["self", "actor", "user"], description: "被传送的实体：self=物品自身；actor/user=使用者。" },
          target: { type: "string", enum: ["activation_target"], description: "传送目的地，目前为本次激活选中的目标。" },
        },
      },
      entity_spawner: {
        type: "object",
        additionalProperties: false,
        description: "实体生成组件：物品激活时，在位置目标处创建一个单位。",
        required: ["prototype"],
        properties: {
          prototype: entityKindSchema,
          entityId: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$", description: "可选：指定生成实体 id；不填时根据 prototype 自动生成。" },
          name: { type: "string", description: "可选：覆盖生成实体显示名称。" },
          color: { type: "string", description: "可选：覆盖生成时的视觉提示颜色。" },
          allowBlocked: { type: "boolean", default: false, description: "是否允许生成在障碍物格子。" },
          allowOccupied: { type: "boolean", default: false, description: "是否允许生成在已有实体占据的格子。" },
          overrides: { type: "object", additionalProperties: true, description: "对 entity prototype.components 的局部覆盖；position 会被激活目标位置覆盖。" },
        },
      },
    },
  };

  const itemDefinition: JSONSchema7 = {
    type: "object",
    additionalProperties: false,
    required: ["components"],
    properties: {
      components: { ...componentsSchema, description: "该物品拥有的组件集合，决定显示、堆叠、经济、品质、激活效果等行为。" },
    },
  };

  return {
    $id: "ecs://schema/item.schema.json",
    title: "Item Definitions",
    description: "item.jsonc 根对象：key 是 item prototype id，value.components 是组件集合。",
    type: "object",
    additionalProperties: false,
    patternProperties: {
      "^[a-z0-9][a-z0-9_-]*$": itemDefinition,
    },
  };
}

export function createEntitySchema(): JSONSchema7 {
  const numericMap: JSONSchema7 = { type: "object", additionalProperties: { type: "number" } };
  const componentsSchema: JSONSchema7 = {
    type: "object",
    additionalProperties: true,
    description: "实体组件集合；运行时组件 active_effects/casting 通常由系统维护，不建议在原型中手写。",
    properties: {
      display: {
        type: "object",
        additionalProperties: false,
        description: "实体展示信息。",
        required: ["name"],
        properties: {
          name: { type: "string", description: "实体显示名称。" },
          description: { type: "string", description: "实体说明。" },
          glyph: { type: "string", description: "Canvas 上显示的短字符。" },
          color: { type: "string", description: "实体主体颜色。" },
          strokeColor: { type: "string", description: "实体描边颜色。" },
          icon: { type: "string", description: "实体图标资源路径或图标 id。" },
        },
      },
      position: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y"],
        properties: {
          x: { type: "integer", minimum: 0, description: "格子 x 坐标。" },
          y: { type: "integer", minimum: 0, description: "格子 y 坐标。" },
        },
      },
      resources: {
        ...numericMap,
        description: "可消耗资源。MVP 中 hp <= 0 会死亡，max_<resource> 会作为上限。",
        properties: {
          hp: { type: "number", minimum: 0, description: "当前生命值。" },
          max_hp: { type: "number", minimum: 0, description: "最大生命值。" },
          mana: { type: "number", minimum: 0, description: "当前法力值。" },
          max_mana: { type: "number", minimum: 0, description: "最大法力值。" },
        },
      },
      attributes: {
        ...numericMap,
        description: "实体属性；effect modifiers 会基于这些值计算最终属性。",
        properties: Object.fromEntries(ATTRIBUTE_IDS.map((id) => [id, { type: "number" }])) as JSONSchema7["properties"],
      },
      inventory: { type: "array", items: { type: "string" }, description: "实体持有的 item instance id 列表；原型里通常留空。" },
      collision: {
        type: "object",
        additionalProperties: false,
        properties: {
          blocksMovement: { type: "boolean", default: true, description: "是否阻挡移动。" },
        },
      },
      faction: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "阵营 id。" },
        },
      },
      ai: { type: "object", additionalProperties: true, description: "AI 配置占位。" },
      loot: { type: "object", additionalProperties: true, description: "掉落配置占位。" },
    },
  };

  const entityDefinition: JSONSchema7 = {
    type: "object",
    additionalProperties: false,
    required: ["components"],
    properties: {
      components: { ...componentsSchema, description: "该实体原型拥有的组件集合。" },
    },
  };

  return {
    $id: "ecs://schema/entity.schema.json",
    title: "Entity Definitions",
    description: "entity.jsonc 根对象：key 是 entity prototype id，value.components 是组件集合。",
    type: "object",
    additionalProperties: false,
    patternProperties: {
      "^[a-z0-9][a-z0-9_-]*$": entityDefinition,
    },
  };
}
