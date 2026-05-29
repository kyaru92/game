/**
 * 快照序列化自测（docs/networking.md §4.2 验收）。
 *
 * 思路：证明「在第 T1 tick 截快照 → JSON 往返 → 灌入新 world → 继续跑相同命令序列」
 * 与「同一 world 不截快照直接跑到底」得到逐字节一致的权威状态。
 * 这同时验证了 (a) 权威状态可 JSON 序列化、(b) 快照恢复后确定性重放不发散。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  applyCommand,
  applySnapshot,
  captureSnapshot,
  createGameRuntime,
  type GameRuntime,
  type World,
} from "../src/gameEngine";
import { buildScriptedCommand } from "./scripted-play";

const WARMUP_TICKS = 40;
const COMPARE_TICKS = 200;

async function loadRuntime(): Promise<GameRuntime> {
  const root = process.cwd();
  const [effectText, itemText, entityText] = await Promise.all([
    readFile(path.join(root, "data", "effect.jsonc"), "utf8"),
    readFile(path.join(root, "data", "item.jsonc"), "utf8"),
    readFile(path.join(root, "data", "entity.jsonc"), "utf8"),
  ]);
  return createGameRuntime(effectText, itemText, entityText);
}

function runScript(runtime: GameRuntime, startTick: number, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) {
    const command = buildScriptedCommand(runtime.world, startTick + i);
    if (command) applyCommand(runtime, "player", command);
    runtime.world.tick();
    runtime.world.drainSimEvents(); // 模拟客户端/服务端每 tick 抽干事件
  }
}

/** 仅比较权威状态（不含表现产物 simEvents）。键排序以消除顺序假阳性。 */
function authoritativeState(world: World): string {
  return stableStringify({
    tick: world.currentTick,
    rngState: world.rng.getState(),
    counters: world.counters,
    entities: world.entities,
    items: world.items,
  });
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

async function main(): Promise<void> {
  // 基准线：单 world 跑满 WARMUP + COMPARE，全程不截快照。
  const baseline = await loadRuntime();
  runScript(baseline, 0, WARMUP_TICKS);
  const snapshot = captureSnapshot(baseline.world);

  // 快照必须能 JSON 往返（证明可序列化、无环、无函数）。
  const wire = JSON.parse(JSON.stringify(snapshot));
  runScript(baseline, WARMUP_TICKS, COMPARE_TICKS);
  const baselineState = authoritativeState(baseline.world);

  // 还原线：新 world 灌入往返后的快照，再跑相同的 COMPARE 段。
  const restored = await loadRuntime();
  applySnapshot(restored.world, wire);

  // 灌入后立即比对：快照点状态应与基准在 T1 时一致。
  // （baseline 已跑过 T1，这里用一个独立 world 重捕做点检。）
  const checkpoint = await loadRuntime();
  runScript(checkpoint, 0, WARMUP_TICKS);
  const checkpointState = authoritativeState(checkpoint.world);
  const restoredCheckpointState = authoritativeState(restored.world);

  runScript(restored, WARMUP_TICKS, COMPARE_TICKS);
  const restoredState = authoritativeState(restored.world);

  const failures: string[] = [];
  if (checkpointState !== restoredCheckpointState) {
    failures.push("applySnapshot 后的状态与 T1 检查点不一致（序列化/恢复有损）。");
  }
  if (baselineState !== restoredState) {
    failures.push("快照恢复后继续重放，最终状态与基准不一致（确定性重放发散）。");
  }

  if (failures.length) {
    console.error("✗ 快照往返自测失败：");
    for (const f of failures) console.error("  - " + f);
    // 输出一点诊断：两侧实体数量与 tick。
    console.error(`  baseline tick=${baseline.world.currentTick} restored tick=${restored.world.currentTick}`);
    console.error(`  baseline entities=${Object.keys(baseline.world.entities).length} restored entities=${Object.keys(restored.world.entities).length}`);
    process.exit(1);
  }

  console.log("✓ 快照往返自测通过：");
  console.log(`  - 权威状态可 JSON 序列化（${(JSON.stringify(snapshot).length / 1024).toFixed(1)} KB / ${WARMUP_TICKS} tick 处）。`);
  console.log(`  - applySnapshot 无损：T1 检查点逐字节一致。`);
  console.log(`  - 恢复后重放 ${COMPARE_TICKS} tick 与基准逐字节一致（含 rng/抛射物/掉落）。`);
  console.log(`  - 终局：tick=${restored.world.currentTick}，实体数=${Object.keys(restored.world.entities).length}。`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
