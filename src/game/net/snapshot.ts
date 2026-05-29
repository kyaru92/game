import type { Entity, ItemInstance } from "../types";
import type { World } from "../world";
import { deepClone } from "../utils";

/**
 * 权威世界快照：可序列化的完整模拟状态（docs/networking.md §4.2）。
 *
 * 字段边界用显式白名单，不是 `_` 前缀规则：
 * - 进快照（权威）：tick、rng 状态、生成计数器、entities、items。
 *   含 `firearm._reloadFinishAtMs`/`_reloadOwnerId`、`activation._cooldownUntilMs`
 *   等权威计时字段——它们都是 tick 派生的确定性时间，恢复 tick 后仍有效。
 * - 不进快照（表现/瞬时）：visualEvents、messages、nextVisualNo（在表现侧）、
 *   simEvents（每 tick 瞬时缓冲）、实体上的 `_deathLogged`（纯日志去重标志）。
 *
 * 抛射物、掉落箱都是 world.entities 中的实体，故 entities 已覆盖它们。
 */
export interface WorldSnapshot {
  tick: number;
  rngState: number;
  nextEntityNo: number;
  nextItemNo: number;
  entities: Record<string, Entity>;
  items: Record<string, ItemInstance>;
}

/** 捕获当前权威状态为快照。返回的对象与 world 完全解耦（深拷贝）。 */
export function captureSnapshot(world: World): WorldSnapshot {
  return {
    tick: world.currentTick,
    rngState: world.rng.getState(),
    nextEntityNo: world.counters.nextEntityNo,
    nextItemNo: world.counters.nextItemNo,
    entities: cloneEntities(world.entities),
    items: deepClone(world.items),
  };
}

/**
 * 用快照覆盖权威状态。
 * 原地清空并回填 world.entities / world.items（保留外部持有的引用，如 App 的渲染读取），
 * 并恢复 tick、rng、计数器。快照内容深拷贝进 world，二者后续互不影响。
 */
export function applySnapshot(world: World, snapshot: WorldSnapshot): void {
  for (const id of Object.keys(world.entities)) delete world.entities[id];
  for (const id of Object.keys(world.items)) delete world.items[id];

  const entities = cloneEntities(snapshot.entities);
  for (const [id, entity] of Object.entries(entities)) world.entities[id] = entity;
  const items = deepClone(snapshot.items);
  for (const [id, item] of Object.entries(items)) world.items[id] = item;

  world.currentTick = snapshot.tick;
  world.rng.setState(snapshot.rngState);
  world.setCounters({ nextEntityNo: snapshot.nextEntityNo, nextItemNo: snapshot.nextItemNo });
}

/** 深拷贝实体表，并剔除纯表现字段 `_deathLogged`。 */
function cloneEntities(source: Record<string, Entity>): Record<string, Entity> {
  const cloned = deepClone(source);
  for (const entity of Object.values(cloned)) {
    delete entity.components._deathLogged;
  }
  return cloned;
}
