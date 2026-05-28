# 架构设计

本文档用于说明项目的职责划分和扩展原则。目标是让后续增加功能、迭代功能时能快速定位相关文件，并避免同一类问题出现多种互相混杂的实现方式。

## 1. 架构理念

项目采用“数据驱动 + 组件式实体 + 系统处理行为”的组织方式。

核心思想：

1. **Entity / Item / Effect 是数据对象**  
   它们由若干 component 组合而成，不通过复杂类继承表达能力。

2. **Component 描述能力，不主动执行逻辑**  
   例如 `activation` 表示物品可被激活，`damage_applier` 表示会造成伤害，`teleporter` 表示激活后会传送。

3. **System 负责行为规则**  
   组件只提供参数，实际如何冷却、施法、施加效果、造成伤害、生成投射物，应放在对应 system 中。

4. **World 是运行时状态容器**  
   `World` 管理实体、物品实例、背包、快捷栏、碰撞、日志、视觉事件等公共状态。

5. **UI 只负责展示与输入适配**  
   React 和 Canvas 不应承载核心玩法规则。UI 可以读取 `runtime.world`，也可以调用引擎 API，但不要直接实现伤害、效果、装填、施法等规则。

6. **schema 是数据契约**  
   JSONC 配置能写什么，应该由 `src/domain/componentSchemas.ts` 明确定义，并通过 `npm run validate:data` 检查。

## 2. 分层职责

```text
React / Canvas UI
  ↓
gameEngine 聚合出口
  ↓
Runtime 组装 World 与 Systems
  ↓
World 保存状态、提供基础操作
  ↓
Systems 根据组件和事件执行游戏规则
  ↓
JSONC + Schema 定义原型数据和配置契约
```

### UI 层

主要文件：

- `src/App.tsx`
- `src/styles.css`
- `src/main.ts`

职责：

- 页面布局。
- Canvas 绘制。
- 鼠标、键盘、表单输入。
- 调用 runtime 中已有能力。
- 展示世界状态、日志、背包、快捷栏、HUD。

不应负责：

- 伤害计算。
- effect 叠层规则。
- 物品激活流程。
- 枪械装填和弹药消耗。
- 投射物命中逻辑。
- 实体生成规则。

如果 UI 中出现较复杂的玩法判断，通常应下沉到 `src/game/`。

### 引擎出口层

主要文件：

- `src/gameEngine.ts`

职责：

- 对 UI 暴露统一的游戏引擎入口。
- 聚合导出 `types`、`utils`、`world`、`systems`、`runtime`、`commands`。
- 让 UI 尽量从一个稳定入口导入能力。

约定：

- UI 优先从 `gameEngine.ts` 导入游戏能力。
- 不建议 UI 深入依赖 system 内部辅助模块。

### Runtime 层

主要文件：

- `src/game/runtime.ts`

职责：

- 解析 `effect.jsonc`、`item.jsonc`、`entity.jsonc`。
- 创建 `World`。
- 注册初始实体、初始物品和快捷栏。
- 实例化各 system。
- 决定哪些 system 需要进入 `world.systems` 的逐帧更新列表。

适合修改的情况：

- 新增一个需要注册的 system。
- 调整初始场景、初始补给、初始快捷栏。
- 调整 runtime 对 UI 暴露的 system 引用。

不适合修改的情况：

- 某个具体玩法规则的细节。应放到对应 system。

### World 层

主要文件：

- `src/game/world.ts`
- `src/game/eventBus.ts`
- `src/game/types.ts`
- `src/game/utils.ts`

职责：

- 保存世界状态：实体、物品实例、原型数据、日志、视觉事件。
- 提供基础操作：创建实体、创建物品、背包、快捷栏、装备、伤害、碰撞、移动等。
- 提供事件总线 `EventBus`，用于系统之间解耦。
- 提供跨系统共享的基础类型和工具函数。

约定：

- `World` 可以提供通用基础能力，但不应无限膨胀为“所有玩法逻辑所在地”。
- 只有多个系统都会用到、或属于基础状态管理的逻辑，才适合放进 `World`。
- 单一玩法的规则优先放在对应 system。

### System 层

主要目录：

- `src/game/system/`
- `src/game/systems.ts`

职责：

- 根据 component 和事件执行游戏规则。
- 处理持续更新逻辑，例如施法完成、effect 过期、投射物移动、装填完成。
- 监听事件并响应，例如物品激活后施加效果、造成伤害、发射投射物。

常见系统：

| 文件 | 职责 |
|---|---|
| `ActivationSystem.ts` | 物品使用、施法、冷却、次数消耗、激活事件 |
| `EffectSystem.ts` | effect 施加、叠层、持续时间、周期结算 |
| `AttributeSystem.ts` | 根据基础属性和 active effects 计算最终属性 |
| `DamageApplierSystem.ts` | 物品激活后造成直接伤害 |
| `EffectApplierSystem.ts` | 物品激活后施加 effect |
| `FirearmSystem.ts` | 枪械发射前检查、装填、弹药消耗、发射投射物 |
| `ProjectileLauncherSystem.ts` | 非枪械类投射物发射 |
| `ProjectileSystem.ts` | 投射物飞行、命中、impact payload 结算 |
| `TeleportSystem.ts` | 激活后传送实体 |
| `EntitySpawnerSystem.ts` | 激活后生成实体 |
| `targeting.ts` | 目标选择、目标校验、范围目标解析 |
| `ammo.ts` | 弹药、弹匣、数量消耗辅助逻辑 |
| `projectiles.ts` | 投射物创建、命中检测、impact payload 结算 |

约定：

- 新玩法如果由物品激活触发，优先监听 `OnItemActivation` 或 `BeforeItemActivation`。
- 新玩法如果需要逐帧推进，实现 `update()`，并在 `runtime.ts` 中加入 `world.systems`。
- system 可以修改 `World`，但不应直接依赖 React、DOM 或 Canvas。

### Domain / Schema 层

主要文件：

- `src/domain/componentSchemas.ts`
- `src/domain/componentTypes.ts`
- `tools/validate-data.ts`

职责：

- 定义 component 可以有哪些字段。
- 从 schema 推导 TypeScript 类型。
- 校验 JSONC 数据是否合法。
- 校验跨文件引用和运行时字段误用。

约定：

- 新增配置字段时，先更新 schema。
- 新增 prototype 可配置能力时，必须考虑 `validate:data` 是否能发现常见错误。
- 不要只在 system 中“偷偷支持”一个字段，而不写入 schema。

## 3. 事件流

当前核心事件流围绕“物品激活”展开。

```text
UI / Command
  ↓
ActivationSystem.startUseItem(...)
  ↓
校验物品、目标、冷却、次数、施法
  ↓
BeforeItemActivation
  ↓
OnItemActivation
  ↓
EffectApplier / DamageApplier / Teleport / Spawner / Projectile / Firearm ...
```

### `BeforeItemActivation`

用途：

- 在真正激活前进行拦截或准备。
- 典型例子：`FirearmSystem` 检查弹匣是否为空，必要时取消本次激活并开始装填。

约定：

- 需要阻止激活时，向 `event.data.cancelReason` 写入原因。
- 不要在这里做主要效果结算，主要结算应在 `OnItemActivation`。

### `OnItemActivation`

用途：

- 表示物品已经通过激活流程。
- 各 system 根据组件决定是否响应。

典型响应：

- `effect_applier` → 施加效果。
- `damage_applier` → 造成伤害。
- `teleporter` → 移动实体。
- `entity_spawner` → 生成实体。
- `projectile_launcher` / `firearm` → 生成投射物。

## 4. 游戏循环

`src/App.tsx` 中的 animation frame 会：

1. 根据键盘输入移动玩家。
2. 调用 `runtime.world.tick()`。
3. 重绘 Canvas。
4. 定期刷新 React UI。

`world.tick()` 会更新注册在 `world.systems` 中的 system。

当前通常需要持续更新的逻辑包括：

- 施法完成。
- 枪械装填完成。
- 投射物移动和命中。
- effect 周期结算与过期。

## 5. 数据流

```text
effect.jsonc / item.jsonc / entity.jsonc
  ↓
runtime.ts 解析 JSONC
  ↓
World 保存 prototype
  ↓
World.createEntity / World.createItem 创建运行时实例
  ↓
System 读取 components 并写入运行时状态
  ↓
UI 读取 World 展示当前状态
```

重点约定：

- JSONC 中写的是 prototype 数据。
- 运行中变化的是 runtime state。
- 运行时字段不要写回 prototype 数据。

示例：

| 类型 | 原型字段 | 运行时字段 |
|---|---|---|
| 物品激活 | `activation.maxCharges`、`activation.cooldownMs` | `activation.charges`、`activation._cooldownUntilMs` |
| 枪械 | `firearm.magazineSize`、`firearm.reloadDurationMs` | `firearm.loadedRounds`、`firearm._reloadFinishAtMs` |
| 实体效果 | effect prototype | `entity.components.active_effects` |
| 施法 | `activation.castDurationMs` | `entity.components.casting` |

## 6. 修改定位指南

| 想做的事 | 优先修改位置 |
|---|---|
| 增加一种物品配置能力 | `componentSchemas.ts`、相关 system、`validate-data.ts` |
| 增加一种新的物品激活结果 | 新增或扩展 `src/game/system/*System.ts`，监听 `OnItemActivation` |
| 增加持续更新类行为 | 新增 system，实现 `update()`，在 `runtime.ts` 注册 |
| 增加新的 effect 叠层或周期规则 | `EffectSystem.ts`、`effectRuntime.ts`、schema |
| 增加属性计算规则 | `AttributeSystem.ts`、effect modifier schema |
| 增加枪械或弹药规则 | `FirearmSystem.ts`、`ammo.ts`、`projectiles.ts` |
| 增加投射物命中行为 | `ProjectileSystem.ts`、`projectiles.ts` |
| 调整目标选择或范围规则 | `targeting.ts` |
| 增加调试指令 | `commands.ts`；若涉及补全，同时改 `commandLanguage.ts` |
| 调整 UI 布局或展示 | `App.tsx`、`styles.css` |
| 调整初始场景或起始物品 | `runtime.ts` |
| 增加数据校验规则 | `tools/validate-data.ts` |

## 7. 扩展原则

### 新增 component 的推荐流程

1. 在 `componentSchemas.ts` 中定义字段。
2. 在 `componentTypes.ts` 确认类型能被推导使用。
3. 在一个明确的 system 中消费该 component。
4. 在 `validate-data.ts` 中补充必要的跨引用或互斥校验。
5. 在 JSONC 中添加示例配置。
6. 如果需要 UI 展示，再修改 `App.tsx`。

### 新增 system 的推荐流程

1. 在 `src/game/system/` 新建 `XxxSystem.ts`。
2. 如果响应物品激活，在构造函数中订阅事件。
3. 如果需要持续更新，实现 `update()`。
4. 在 `src/game/system/index.ts` 和 `src/game/systems.ts` 导出。
5. 在 `runtime.ts` 中实例化；需要 tick 的加入 `world.systems`。
6. 必要时把 system 加到 `GameRuntime` 类型中。

### 新增 UI 功能的推荐流程

1. 先确认规则是否已经在 `src/game/` 中存在。
2. UI 只调用已有 API 或读取 `World` 状态。
3. 如果 UI 为了展示需要摘要数据，优先在 `game/utils.ts` 或 `runtime.ts` 附近提供纯函数，不在 JSX 中堆复杂规则。

## 8. 不推荐的实现方式

为保持架构一致，后续应避免：

- 在 `App.tsx` 里直接实现伤害、effect、弹药、投射物等核心规则。
- 同一个功能既通过事件实现，又在 UI 或 command 中重复手写一套。
- 绕过 `ActivationSystem` 直接执行物品效果，除非是明确的调试指令。
- 新增 JSONC 字段但不更新 schema。
- 把运行时字段写入 `effect.jsonc`、`item.jsonc`、`entity.jsonc`。
- 把只属于某个系统的规则塞进 `World`。
- 在多个 system 中各自实现一份目标解析、范围搜索、弹药消耗等公共逻辑。

## 9. 当前架构边界

这个项目是 MVP，不是完整 ECS 框架。当前实现采用“ECS 风格”的轻量做法：

- Entity / Item 是普通对象。
- Component 是普通 JSON-like 数据。
- System 是普通 TypeScript 类。
- 事件总线用于降低系统之间的直接依赖。

因此后续扩展时，不需要引入大型 ECS 框架；优先保持当前轻量结构，除非项目规模明显超过当前架构承载范围。
