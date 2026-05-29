/**
 * 延迟补偿自测（docs/networking.md §4.3 验收）。
 *
 * 直接验证回溯机制：目标移动后，一发「瞄准目标旧位置」的射击在回溯下命中、
 * 不回溯则落空——即服务端按客户端 tick 的目标历史位置结算命中。
 * （游戏内 dummy 不自走，故用受控位移直接演示机制。）
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createGameRuntime, type Entity } from "../src/gameEngine";
import { findProjectileHit } from "../src/game/system/projectiles";

async function loadRuntime() {
  const root = process.cwd();
  return createGameRuntime(
    await readFile(path.join(root, "data", "effect.jsonc"), "utf8"),
    await readFile(path.join(root, "data", "item.jsonc"), "utf8"),
    await readFile(path.join(root, "data", "entity.jsonc"), "utf8"),
  );
}

function makeProbeProjectile(): Entity {
  return {
    entityId: "probe-projectile",
    name: "probe",
    components: {
      position: { x: 0, y: 6 },
      projectile: { sourceEntityId: "player", targetX: 10, targetY: 6, vx: 1, vy: 0, speed: 18, remainingDistance: 10, radius: 0.05, payload: {} },
    },
  };
}

async function main(): Promise<void> {
  const runtime = await loadRuntime();
  const world = runtime.world;
  const dummy = world.entities.dummy;
  if (!dummy) throw new Error("缺少 dummy 实体");

  // T_old：目标在射线上 (5,6)，记录历史。
  dummy.components.position = { x: 5, y: 6 };
  const fireTick = world.currentTick;
  world.recordPositionHistory();

  // 目标移走到射线之外 (5,9)（模拟发射后目标已移动）。
  dummy.components.position = { x: 5, y: 9 };

  const from = { x: 0, y: 6 };
  const to = { x: 10, y: 6 };

  // 不回溯：目标已在 (5,9)，射线 y=6 不该命中。
  const hitNow = findProjectileHit(world, makeProbeProjectile(), from, to);

  // 回溯到 fireTick：目标回到 (5,6)，应命中。
  const history = world.positionHistory.get(fireTick);
  if (!history) throw new Error("历史环缺少 fireTick 记录");
  world.services.spatial.beginRewind(history);
  const hitRewound = findProjectileHit(world, makeProbeProjectile(), from, to);
  world.services.spatial.endRewind();

  const failures: string[] = [];
  if (hitNow) failures.push(`不回溯时本不该命中（目标已移到 (5,9)），却命中了 ${hitNow.entity.entityId}。`);
  if (hitRewound?.entity.entityId !== "dummy") failures.push("回溯到发射 tick 后应命中 dummy，实际未命中。");
  // 回溯结束后必须恢复读取当前位置。
  const restored = world.services.spatial.positionOf(dummy);
  if (!restored || restored.y !== 9) failures.push("endRewind 后未恢复读取当前位置。");

  if (failures.length) {
    console.error("✗ 延迟补偿自测失败：");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }

  console.log("✓ 延迟补偿自测通过：");
  console.log("  - 不回溯：目标移动后，瞄准旧位置的射击落空。");
  console.log("  - 回溯到发射 tick：命中目标的历史位置（命中 dummy）。");
  console.log("  - 回溯仅影响命中判定的位置读取，结束后立即恢复当前权威位置。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
