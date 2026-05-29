# 网络层架构与改造记录

本文档记录网络层抽象的设计目标、已完成的确定性改造，以及后续迭代方向。目的是让后续开发理解「为什么这么改」，并在加入真实联机前保持架构一致。

## 1. 目标与定位

| 维度 | 决定 |
|---|---|
| 拓扑 | dedicated server，服务端唯一权威 |
| 玩法 | 多人组队快节奏 PVPVE |
| 权威范围 | 服务端跑全部需要验证的 system；客户端只独有表现层 |
| 预测 | 客户端预测本地玩家（主要是移动） |
| 延迟补偿 | 服务端独有，对命中类判定回溯目标位置 |
| 模拟频率 | 30Hz 固定步长（`World.tickRateHz`，可调参数） |

参考模型为 Source 多人网络的经典做法：服务器权威 + 客户端预测 + 实体插值 + 延迟补偿 + 快照同步。

## 2. 目标架构

```text
            CLIENT                                      DEDICATED SERVER
┌─────────────────────────────┐              ┌──────────────────────────────────┐
│ Input → Command              │  command↑    │ 收 command → 入队(按 tick)        │
│ Predicted Sim (本地 World)   │ ───────────► │ Authoritative Sim (固定 tick)     │
│   逐 tick 预测本地玩家        │              │   跑全部验证 system               │
│ 收到 snapshot → 回滚重放      │ ◄─────────── │ 周期产出 snapshot + delta         │
│ 远端实体插值                  │  snapshot↓   │ 命中类 command 走延迟补偿(回溯)   │
│ 表现层从 World 派生 VFX       │              │ 维护历史快照环(供回溯)             │
└─────────────────────────────┘              └──────────────────────────────────┘
```

分层与现有代码的对应：

```text
Presentation (App.tsx, Canvas, VisualEvent)   ← 只读快照 + 插值
        ↑ 派生
Simulation (World + Systems)  ← 固定 tick、确定性、种子化 RNG
        ↑ 消费 command          ↓ 产出 snapshot/delta
Net Session (command 上行 / snapshot 下行 / 预测·回滚·插值)
        ↑
Transport (WebSocket / WebRTC，抽象成可替换接口)
```

关键分工：

- **预测**：客户端只预测「本地玩家自己、结果可由自己确定」的 command，主要是移动。
- **延迟补偿**：服务端独有。命中类 command 带客户端 tick，服务端把目标实体回溯到那个 tick 的位置做判定。
- **客户端独有**：`visualEvents`、`messages`、canvas 绘制、插值，全部不参与权威。

## 3. 已完成的改造

确定性的三个支柱已经落地，是后续预测、回滚、服务端权威的前提。

### 3.1 固定 tick 时间（确定性时间）

- `World` 新增 `tickRateHz = 30`、`tickIntervalMs = 1000/30`、`currentTick`。
- `World.nowMs()` 改为 `currentTick * tickIntervalMs` 派生，不再用 `performance.now()`。
- `World.tick()` 每次推进 `currentTick`。
- `App.tsx` 渲染循环改为 accumulator 固定步长：每 33.3ms 推进一个 tick，渲染仍每帧执行；带 5 tick 补帧上限防止掉帧螺旋。
- 所有 `*AtMs` / `*UntilMs` 运行时字段值现在都是 tick 派生的确定性时间，字段名保留但语义已是确定性时间，不需逐个重命名。
- 表现层 `VisualEvent.createdAtMs` 由 `world.nowMs()` 写入，与读取基准一致。
- 修复：`drawCastingRing` 原用 `performance.now()` 对比 tick 派生的 `finishAtMs`，基准不一致导致施法环进度算错，已改用 `world.nowMs()`。

涉及文件：`world.ts`、`App.tsx`。

### 3.2 种子化随机（确定性随机）

- 新增 `src/game/rng.ts`：`SeededRng`（mulberry32），提供 `next/chance/int/float`，以及 `getState/setState`（状态仅一个 32 位整数，便于随快照同步）。
- `World` 新增 `readonly rng`，构造函数接收 `seed`（默认固定种子，后续由服务端下发）。
- 7 处 `Math.random` 全部替换为 `world.rng`：`EffectApplierSystem`、`projectiles.ts`、`LootSystem`（spawnChance、entry.chance、搜索时长、数量、加权抽取）。
- 约束：游戏逻辑禁止再直接使用 `Math.random`，一律走 `world.rng`。

涉及文件：`rng.ts`、`world.ts`、`EffectApplierSystem.ts`、`projectiles.ts`、`LootSystem.ts`。

### 3.3 命令抽象（统一可序列化输入）

- 新增 `src/game/net/command.ts`：
  - `GameCommand`：move / useItem / equipItem / reloadItem / cancelCast / assignHotbarSlot / organizeInventory / loot 系列，全部字段可序列化。
  - `applyCommand(runtime, actorId, command)`：唯一执行器，只做状态变更，不碰 UI 刷新或表现。本地预测与服务端权威模拟共用它。
  - 移动速度与固定步长逻辑搬进 `applyMove`，命令只携带方向向量（执行器内归一化，避免客户端传入超速）。
- `App.tsx` 新增 `dispatch` 作为玩家本地命令的统一入口（当前直接 `applyCommand` 到本地 world；接网络时改为「本地预测 + 上行发送」）。
- 所有玩家动作（键盘、鼠标、按钮、loot 面板）改为产出 command，不再直接调用 system。
- `updatePlayerFreeMovement` 拆为纯函数 `movementDirFromKeys`，移动循环每 tick 产出一条 `move` 命令。
- `target`（瞄准）在客户端产出命令时就解析好放进命令；服务端收到后按权威状态重新验证。

涉及文件：`net/command.ts`、`gameEngine.ts`、`App.tsx`。

### 3.4 与调试指令的边界

`commands.ts` 的文本 DSL（`spawn` / `give` / `damage` 等）是独立的调试 / 管理通道，**不并入** `GameCommand`，走单独路径，不参与预测与上行同步。

### 3.5 权威状态 / 表现分离（领域事件流）

权威 `World` 不再持有任何表现产物，系统也不再直接产像素 VFX，改为发**领域事件**，客户端本地派生。

- 新增 `src/game/net/events.ts`：`SimEvent` 联合（`log` / `damaged` / `died` / `effectApplied` / `periodicTick` / `teleported` / `spawned` / `lootDropped` / `projectileImpact`），全部可序列化、自带渲染所需坐标与颜色（实体可能在事件发生时已被移除）。
- 新增 `src/game/presentation.ts`：`PresentationState`（`visualEvents` / `messages`，客户端本地，不进 snapshot）+ `PresentationDeriver`（消费 `SimEvent[]` 派生像素特效与日志，即原 `VisualEventService` 的「像素决策」搬到表现侧）。
- `World` 移除 `visualEvents` / `messages` / `nextVisualNo`，新增每 tick 临时缓冲 `simEvents` + `emitSim()` / `drainSimEvents()`；`tick()` 不再老化特效（移到派生侧）。
- `world.log(text)` 保留签名，改为发 `{type:"log"}` 事件（日志是叙事事实，非像素 VFX），约 50 处调用点不动。
- 各 system 的 `services.vfx.*` 调用点全部改为 `emitSim` 语义事件；删除 `VisualEventService` 及 `GameServices.vfx`。
- `removeDeadEntities` 的死亡 burst 改为 `died` 事件（`OnEntityDeath` 总线事件保留，供 `LootSystem` 内部消费）。

涉及文件：`net/events.ts`、`presentation.ts`、`world.ts`、各 `system/*`、`services/DamageService.ts`、`commands.ts`、`App.tsx`。

### 3.6 可序列化与全量 snapshot

- 新增 `src/game/net/snapshot.ts`：`WorldSnapshot`（`tick` / `rngState` / `nextEntityNo` / `nextItemNo` / `entities` / `items`）+ `captureSnapshot` / `applySnapshot`。
- 字段边界用**显式白/黑名单，不是 `_` 前缀规则**：`firearm._reloadFinishAtMs` / `_reloadOwnerId`、`activation._cooldownUntilMs` 是权威计时字段必须同步；仅剔除纯表现字段 `_deathLogged`。所有计时都是 tick 派生的确定性时间，恢复 `currentTick` 后仍有效。
- 抛射物、掉落箱都是 `world.entities` 中的实体，故 `entities` 已覆盖；`World` 暴露 `counters` / `setCounters` 供快照读写生成计数器。
- `applySnapshot` 原地清空回填 `entities` / `items`（保留 App 持有的引用），并恢复 tick / rng / 计数器。
- 自测 `tools/snapshot-roundtrip.ts`：跑若干 tick + 命令 → 截快照 → JSON 往返 → 灌入新 world → 重放相同序列，断言权威状态逐字节一致（覆盖 rng / 抛射物 / 掉落）。

### 3.7 Transport 接口 + loopback + 会话

- 新增 `src/game/net/transport.ts`：`ClientMessage`（`command` + `seq` + `clientTick`）/ `ServerMessage`（`snapshot` + `events` + `ackedSeq` + `serverTick`）+ `Transport` / `Endpoint` 接口。
- 新增 `src/game/net/loopback.ts`：`LoopbackTransport`，同进程互联，可选 `latencyTicks` 延迟队列（`advance(tick)` 驱动投递，0 延迟即时投递）。
- 新增 `src/game/net/session.ts`：
  - `ServerSession`：持有权威 runtime；收命令入队；`step()` = 应用命令 → `world.tick()` → 记录历史位置环 → 抽干事件 → 截快照 → 下发。
  - `ClientSession`：持有预测 runtime（仅作状态容器，不跑系统）；`send()` 上行命令，move 立即本地预测并入待确认缓冲；`onServerMessage()` = `applySnapshot` → 丢弃已确认 move → 回滚重放未确认 move → 维护插值快照 → 派生表现。
- 自测 `tools/session-loopback.ts`：跑通「预测 + 上行 → 权威 → 快照 → 校正」，断言客户端权威状态逐 tick 收敛到服务端，且事件流被派生为表现。

### 3.8 预测 / 回滚 / 插值 / 延迟补偿（实时循环改走 loopback）

`App.tsx` 实时循环改走 server→snapshot→client 管线：

- 装配 `LoopbackTransport` + `ServerSession`(权威 runtime) + `ClientSession`(预测 runtime)；UI / 渲染一律读客户端预测 world（每 tick 被快照同步 = 权威视图）。
- 固定步长循环（保留 accumulator + 5-tick 补帧）：每 tick 由按键产出 `move` 经 `client.send`（本地预测 + 上行）→ `server.step()`（消费命令、tick、下发快照，loopback 即时回灌客户端并回滚重放校正）。
- **客户端只预测 `move`**（rng / clock 无关、可由自己确定）；其余命令仅上行，由服务端权威结算后随快照回灌。回滚时只重放未确认的 move，**绝不重跑 `world.tick`**（否则会重复模拟服务端实体）。
- 远端实体用最近两帧快照按 alpha 插值渲染（落后约 1 tick，避免 30Hz tick 下卡顿）；本地玩家用预测位置。**插值位置只存在渲染层，不写回 `components.position`**。
- 调试 DSL（`commands.ts`）与补给直给作用到**服务端权威 world**，结果经事件流 / 快照回灌客户端（§3.4 的独立管理通道定位不变）。
- 延迟补偿：`SpatialService` 新增回溯上下文 `positionOf()` / `beginRewind()` / `endRewind()`；`findProjectileHit` 与 `resolveAreaTargets` 经 `positionOf` 读位置。`World` 维护服务端专用历史位置环 `positionHistory`（不进 snapshot）；命中类命令的发射体打上 `firedAtClientTick`，`ProjectileSystem` 在命中判定期间把目标回溯到该 tick 的历史位置。自测 `tools/lagcomp.ts` 验证：目标移动后，瞄准旧位置的射击在回溯下命中、不回溯则落空。

涉及文件：`net/snapshot.ts`、`net/transport.ts`、`net/loopback.ts`、`net/session.ts`、`world.ts`、`services/SpatialService.ts`、`system/ProjectileSystem.ts`、`system/projectiles.ts`、`system/targeting.ts`、`domain/componentTypes.ts`、`App.tsx`、`tools/*`。

## 4. 后续目标 / 优化方向

实时联机的骨架已在单机 loopback 内跑通，剩余主要是优化与真实联机接入：

- **真实 Transport**：把 loopback 换成 WebSocket / WebRTC 实现（`Transport` 接口不变），处理序列化字节流、重连、心跳。
- **delta 压缩**：当前每 tick 全量 snapshot（~9KB）；改为基于上一确认帧的 delta，降低带宽。
- **多客户端**：当前 `ServerSession` / `ClientSession` 假设单个 `actorId="player"`；扩展为多玩家（每客户端独立 ack / 预测 / 命令队列），AI 实体进入权威模拟。
- **施法延迟下的 `firedAtClientTick` 精确归属**：当前在「命令所在 tick」内完成的施法（如 `castDurationMs=0`）能正确打 tick；带施法读条的武器在施法完成 tick 才发射，需把 `clientTick` 随 `casting` 状态透传，才能精确回溯。
- **插值 / 延迟补偿调参**：插值延迟 tick 数、历史环长度（当前 32 tick）等按真实 RTT 调整。

## 5. 关键约束清单

后续开发须遵守，避免破坏确定性：

1. 游戏逻辑时间一律用 `world.nowMs()` 或 `world.currentTick`，禁止 `performance.now()` / `Date.now()`（渲染层计算真实帧间隔除外）。
2. 游戏逻辑随机一律走 `world.rng`，禁止 `Math.random`。
3. 玩家输入一律产出 `GameCommand` 经 `applyCommand` 执行，禁止 UI 直接调 system 改状态。
4. 权威状态与表现产物分离：系统发 `SimEvent` 领域事实，表现（visualEvents / 日志）一律由客户端 `PresentationDeriver` 从事件流派生，禁止系统直接产像素 VFX 或写 `messages`。
5. 运行时字段不写回 prototype 数据；snapshot 字段用显式白/黑名单（非 `_` 前缀规则），权威计时字段（`_reloadFinishAtMs` / `_cooldownUntilMs` 等）必须同步，纯表现字段（`_deathLogged`）与瞬时缓冲（`simEvents`）、服务端专用历史（`positionHistory`）不进 snapshot。
6. 调试 DSL 与 `GameCommand` 是两条独立通道，不混用；调试 DSL / 补给直给作用到服务端权威 world。
7. 客户端只预测本地玩家 `move`，其余命令仅上行；回滚只重放未确认 move，不重跑 `world.tick`。
8. 远端实体插值位置只存在渲染层，不写回 `components.position`（权威状态）。
