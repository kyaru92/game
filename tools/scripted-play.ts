import type { GameCommand, World } from "../src/gameEngine";

/**
 * 确定性游玩脚本：仅依赖权威状态，A/B 同状态 → 同命令。
 * 故意覆盖移动 + 装填 + 开火（弹道/伤害/可能的死亡掉落），重度走 rng 路径，
 * 用于快照往返与会话收敛两个自测。
 */
export function buildScriptedCommand(world: World, tick: number): GameCommand | null {
  const player = world.entities.player;
  const dummy = world.entities.dummy;
  if (!player) return null;

  const activeItemId = world.services.inventory.activeItemId("player");

  // 先装填，再周期性补弹（reloadDurationMs=1200ms≈36 tick，故首发火力从 ~tick 45 起）。
  if (activeItemId && (tick === 1 || tick % 120 === 60)) return { kind: "reloadItem", itemId: activeItemId };

  // 朝 dummy 位置持续开火：basic-pistol 是 position 瞄准 + spreadDeg（消耗 rng），
  // 命中→伤害→可能击杀→掉落（rng）。每 10 tick 一发以避开 280ms 冷却。
  if (activeItemId && dummy && tick >= 45 && tick % 10 === 0) {
    const aim = dummy.components.position ?? { x: 8, y: 6 };
    return { kind: "useItem", itemId: activeItemId, target: { kind: "position", position: [aim.x, aim.y] } };
  }

  // 其余 tick 向 dummy（或地图中心）移动，制造位置变化。
  const target = dummy?.components.position ?? { x: 8, y: 6 };
  const pos = player.components.position ?? { x: 0, y: 0 };
  const dir = { x: Math.sign(target.x - pos.x), y: Math.sign(target.y - pos.y) };
  if (dir.x === 0 && dir.y === 0) return null;
  return { kind: "move", dir };
}
