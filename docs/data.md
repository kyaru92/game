# 数据与组件约定

项目的数据配置集中在根目录的 JSONC 文件中，schema 和校验逻辑在 `src/domain/` 与 `tools/` 中。本文档只说明职责边界和配置原则，不逐项展开所有字段。

## 1. 数据文件职责

| 文件 | 职责 |
|---|---|
| `effect.jsonc` | 定义 effect 原型，例如 buff、debuff、周期回血、周期伤害、属性修正 |
| `item.jsonc` | 定义 item 原型，例如消耗品、装备、枪械、弹药、投射物道具、传送道具、生成实体道具 |
| `entity.jsonc` | 定义 entity 原型，例如玩家、训练假人、障碍物、可生成怪物 |

这些文件存放的是 **prototype 数据**。运行中变化的状态应由代码初始化和维护，不应直接写入配置文件。

## 2. Schema 与类型

主要文件：

| 文件 | 职责 |
|---|---|
| `src/domain/componentSchemas.ts` | 定义所有可配置 component 的 JSON schema |
| `src/domain/componentTypes.ts` | 根据 schema 推导 TypeScript 类型 |
| `tools/validate-data.ts` | 校验 JSONC、schema、跨文件引用和运行时字段误用 |

约定：

- 新增配置字段时，必须先进入 `componentSchemas.ts`。
- 不要让 system 私自读取一个 schema 中不存在的字段。
- 如果字段引用 effect、entity 或其他 prototype，应在 `validate-data.ts` 中补引用校验。
- 修改数据后应运行：

```bash
npm run validate:data
```

## 3. Component 的设计原则

Component 应该描述“这个对象具有什么能力或参数”，不要描述“代码应该怎么分支”。

推荐：

```jsonc
{
  "activation": { "cooldownMs": 500, "maxCharges": 3 },
  "targeting": { "mode": "entity", "range": 6 },
  "effect_applier": { "kind": "poison", "target": "activation_target" }
}
```

含义：这个物品可激活，需要实体目标，激活后施加 poison。

不推荐：

```jsonc
{
  "type": "poisonPotionSpecialCase"
}
```

因为这种写法会诱导代码里出现大量特例分支，削弱组件组合的意义。

## 4. 常见组件归属

### Entity 常见组件

| component | 职责 |
|---|---|
| `display` | 名称、颜色、字形等展示信息 |
| `position` | 世界坐标 |
| `resources` | 生命值等资源 |
| `attributes` | 移速、攻速、护甲等基础属性 |
| `collision` | 碰撞形状、阻挡规则 |
| `damageable` | 受伤和可破坏规则 |

### Item 常见组件

| component | 职责 |
|---|---|
| `display` | 物品名称和描述 |
| `catalog` | 分类等目录信息 |
| `stacking` | 堆叠数量 |
| `activation` | 可使用、冷却、次数、施法时间 |
| `targeting` | 使用目标模式与射程 |
| `effect_applier` | 激活后施加 effect |
| `damage_applier` | 激活后造成伤害 |
| `teleporter` | 激活后移动使用者 |
| `entity_spawner` | 激活后生成实体 |
| `projectile_launcher` | 激活后发射投射物 |
| `firearm` | 枪械、弹匣、装填、发射参数 |
| `ammo` | 弹药类型、伤害、附加效果、投射参数 |
| `equipment` | 装备标记或装备相关信息 |

### Effect 常见字段

| 字段 | 职责 |
|---|---|
| `id` | effect 唯一标识，建议与根对象 key 一致 |
| `name` / `description` | 展示信息 |
| `durationMs` | 持续时间，`-1` 表示永久 |
| `stacking` | 叠层与重复施加规则 |
| `modifiers` | 持续属性修正 |
| `periodicEffect` | 周期性资源变化 |

## 5. Prototype 与 Runtime State 边界

JSONC 文件只描述原型。运行时字段由 `World`、`utils` 和 system 初始化或维护。

不要把以下字段写进 JSONC 原型：

| 运行时字段 | 所属 |
|---|---|
| `active_effects` | entity 当前 effect 状态 |
| `casting` | entity 当前施法状态 |
| `hotbar` | entity 当前快捷栏状态 |
| `loadout` | entity 当前装备状态 |
| `projectile` | 投射物实体运行时组件 |
| `activation._cooldownUntilMs` | item 冷却截止时间 |
| `firearm.loadedRounds` | 枪械已装填弹药 |
| `firearm._reloadFinishAtMs` | 装填完成时间 |
| `firearm._reloadOwnerId` | 装填发起者 |

`tools/validate-data.ts` 已经会检查部分运行时字段误写。

## 6. 数据到行为的映射

数据本身不执行逻辑，而是由 system 消费。

| 数据配置 | 主要消费位置 |
|---|---|
| `activation` | `ActivationSystem.ts` |
| `targeting` | `targeting.ts`、`ActivationSystem.ts` |
| `effect_applier` | `EffectApplierSystem.ts`、`projectiles.ts` |
| `damage_applier` | `DamageApplierSystem.ts`、`projectiles.ts` |
| `firearm` | `FirearmSystem.ts`、`ammo.ts`、`projectiles.ts` |
| `ammo` | `ammo.ts`、`FirearmSystem.ts` |
| `projectile_launcher` | `ProjectileLauncherSystem.ts`、`projectiles.ts` |
| `projectile` | `ProjectileSystem.ts`、`projectiles.ts` |
| `teleporter` | `TeleportSystem.ts` |
| `entity_spawner` | `EntitySpawnerSystem.ts` |
| `modifiers` | `AttributeSystem.ts` |
| `periodicEffect` | `EffectSystem.ts` |

如果新增了一个 component，应能回答两个问题：

1. 它由哪个 system 消费？
2. 它是否需要数据校验？

## 7. 新增数据能力的流程

例如要新增一个 `shield_applier`：

1. 在 `componentSchemas.ts` 定义 `shield_applier` 的字段。
2. 在 `componentTypes.ts` 确认 item runtime/prototype 类型包含该字段。
3. 新增 `ShieldApplierSystem.ts` 或扩展已有相关 system。
4. 在 `runtime.ts` 实例化该 system。
5. 如有引用或互斥关系，在 `validate-data.ts` 补校验。
6. 在 `item.jsonc` 添加示例物品。
7. 如需展示，再修改 UI。

避免只做第 3 和第 6 步，否则数据契约会失控。
