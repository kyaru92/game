/**
 * 会话 + loopback 自测（docs/networking.md §4.2/§4.3 验收）。
 *
 * 跑通「客户端预测 + 上行 → 服务端权威 → 快照下行 → 客户端校正」整条管线，
 * 验证：
 *  1. 每 tick 后客户端权威状态收敛到服务端（逐字节一致）。
 *  2. 权威事件流被客户端 PresentationDeriver 派生为日志/特效（表现非空）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ClientSession,
  LoopbackTransport,
  PresentationDeriver,
  PresentationState,
  ServerSession,
  createGameRuntime,
  type GameRuntime,
  type World,
} from "../src/gameEngine";
import { buildScriptedCommand } from "./scripted-play";

const TICKS = 240;

async function loadRuntime(): Promise<GameRuntime> {
  const root = process.cwd();
  const [effectText, itemText, entityText] = await Promise.all([
    readFile(path.join(root, "data", "effect.jsonc"), "utf8"),
    readFile(path.join(root, "data", "item.jsonc"), "utf8"),
    readFile(path.join(root, "data", "entity.jsonc"), "utf8"),
  ]);
  return createGameRuntime(effectText, itemText, entityText);
}


function authoritativeState(world: World): string {
  return stableStringify({ tick: world.currentTick, rngState: world.rng.getState(), counters: world.counters, entities: world.entities, items: world.items });
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

async function main(): Promise<void> {
  const serverRuntime = await loadRuntime();
  const clientRuntime = await loadRuntime();

  const transport = new LoopbackTransport(0);
  const server = new ServerSession(serverRuntime, transport.server);
  const presentation = new PresentationState();
  const deriver = new PresentationDeriver(presentation);
  const client = new ClientSession(clientRuntime, transport.client, deriver);

  let diverged = -1;
  for (let tick = 0; tick < TICKS; tick += 1) {
    // 客户端基于自身（已被快照同步的）权威视图决策命令。
    const command = buildScriptedCommand(client.world, tick);
    if (command) client.send(command); // move 本地预测 + 上行；其余仅上行
    server.step();                      // 服务端权威推进并下发快照（loopback 即时回灌客户端）

    if (diverged < 0 && authoritativeState(client.world) !== authoritativeState(server.world)) {
      diverged = tick;
      break;
    }
  }

  const failures: string[] = [];
  if (diverged >= 0) failures.push(`第 ${diverged} tick 客户端权威状态未收敛到服务端。`);
  if (presentation.messages.length === 0) failures.push("客户端没有从事件流派生出任何日志（表现派生未生效）。");

  if (failures.length) {
    console.error("✗ 会话/loopback 自测失败：");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }

  console.log("✓ 会话/loopback 自测通过：");
  console.log(`  - ${TICKS} tick 内客户端权威状态逐 tick 收敛到服务端。`);
  console.log(`  - 客户端从权威事件流派生日志 ${presentation.messages.length} 条、特效 ${presentation.visualEvents.length} 个。`);
  console.log(`  - 终局：server tick=${server.world.currentTick}，实体数=${Object.keys(server.world.entities).length}。`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
