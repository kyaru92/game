import type { GameRuntime, Target } from "../types";

/**
 * 游戏命令：UI 输入与网络上行共用的唯一意图表示。
 *
 * 设计约束：
 * - 全部字段可序列化（用于上行网络与本地预测重放）。
 * - 命令是「已解析的意图」：瞄准 target 在客户端产出时就解析好放进命令，
 *   服务端收到后按权威状态重新验证，不依赖客户端的瞬时光标状态。
 * - 纯 UI 状态（面板开关等）不属于命令，留在表现层。
 */
export type GameCommand =
  | { kind: "move"; dir: { x: number; y: number } }
  | { kind: "useItem"; itemId: string; target: Target }
  | { kind: "equipItem"; itemId: string }
  | { kind: "reloadItem"; itemId?: string }
  | { kind: "cancelCast" }
  | { kind: "assignHotbarSlot"; slot: number; itemId: string }
  | { kind: "organizeInventory" }
  | { kind: "lootBeginSearch"; containerId: string }
  | { kind: "lootCancelSearch"; containerId?: string; reason?: string }
  | { kind: "lootTakeItem"; containerId: string; itemId: string };

/**
 * 执行单条命令，把意图作用到权威世界状态。
 *
 * 不负责 UI 刷新或表现，只做状态变更。本地预测与服务端权威模拟都调用它，
 * 保证「同样的命令在两侧产生同样的状态变更」。
 */
export function applyCommand(runtime: GameRuntime, actorId: string, command: GameCommand): void {
  switch (command.kind) {
    case "move":
      applyMove(runtime, actorId, command.dir);
      return;
    case "useItem":
      runtime.activationSystem.startUseItem(actorId, command.itemId, command.target);
      return;
    case "equipItem":
      runtime.world.services.inventory.equipItem(actorId, command.itemId);
      return;
    case "reloadItem": {
      const itemId = command.itemId ?? runtime.world.services.inventory.activeItemId(actorId);
      if (itemId) runtime.firearmSystem.reloadItem(actorId, itemId);
      return;
    }
    case "cancelCast":
      runtime.activationSystem.cancel(actorId);
      return;
    case "assignHotbarSlot":
      runtime.world.services.inventory.setHotbarSlot(actorId, command.slot, command.itemId);
      return;
    case "organizeInventory":
      runtime.world.services.inventory.organize(actorId);
      return;
    case "lootBeginSearch":
      runtime.lootSystem.beginAutoSearch(actorId, command.containerId);
      return;
    case "lootCancelSearch":
      runtime.lootSystem.cancelSearch(actorId, command.containerId, command.reason ?? "中断搜索");
      return;
    case "lootTakeItem":
      runtime.lootSystem.takeRevealedItem(actorId, command.containerId, command.itemId);
      return;
  }
}

/**
 * 移动执行：按固定 tick 步长推进一步。
 * dir 是原始（未归一化）方向，执行器内部归一化，避免客户端传入超速向量。
 * 速度取决于权威属性，不由客户端决定。
 */
function applyMove(runtime: GameRuntime, actorId: string, dir: { x: number; y: number }): void {
  const length = Math.hypot(dir.x, dir.y);
  if (length <= 0) return;

  const actor = runtime.world.entities[actorId];
  if (!actor) return;
  const attrs = runtime.attributeSystem.finalAttributes(actor);
  const unitsPerSecond = Math.max(0, Number(attrs.move_speed ?? 100)) / 25;
  if (unitsPerSecond <= 0) return;

  const stepSeconds = runtime.world.tickIntervalMs / 1000;
  const step = unitsPerSecond * stepSeconds;
  runtime.world.services.spatial.tryMove(
    actorId,
    (dir.x / length) * step,
    (dir.y / length) * step,
    { logFailure: false },
  );
}
