import type { GameRuntime } from "../types";
import type { World } from "../world";
import type { PresentationDeriver } from "../presentation";
import { applyCommand, type GameCommand } from "./command";
import { applySnapshot, captureSnapshot, type WorldSnapshot } from "./snapshot";
import type { ClientMessage, Endpoint, ServerMessage } from "./transport";

/**
 * 服务端会话（docs/networking.md §4.3）：唯一权威。
 *
 * 持有权威 runtime；收上行命令入队；每 step 应用本 tick 命令 → world.tick()
 * → 抽干事件 → 截快照 → 下发。命令以到达顺序应用（与单机循环「先命令后 tick」一致）。
 */
export class ServerSession {
  private readonly queue: ClientMessage[] = [];
  private lastAckedSeq = 0;
  private readonly actorId: string;

  constructor(
    private readonly runtime: GameRuntime,
    private readonly endpoint: Endpoint<ServerMessage, ClientMessage>,
    actorId = "player",
  ) {
    this.actorId = actorId;
    endpoint.onMessage((message) => this.queue.push(message));
  }

  /** 推进一个权威 tick：应用队列命令 → tick → 下发快照与事件。 */
  step(): void {
    const world = this.runtime.world;
    let commandClientTick: number | null = null;
    for (const message of this.queue) {
      applyCommand(this.runtime, this.actorId, message.command);
      commandClientTick = message.clientTick;
      if (message.seq > this.lastAckedSeq) this.lastAckedSeq = message.seq;
    }
    this.queue.length = 0;

    // 让本 tick 触发的发射体（含 castMs=0 在 tick 内完成的施法）带上 firedAtClientTick（延迟补偿）。
    world.activeCommandClientTick = commandClientTick;
    world.tick();
    world.activeCommandClientTick = null;
    world.recordPositionHistory(); // 维护历史位置环，供命中判定回溯

    const events = this.runtime.world.drainSimEvents();
    const snapshot = captureSnapshot(this.runtime.world);
    this.endpoint.send({
      type: "snapshot",
      snapshot,
      events,
      ackedSeq: this.lastAckedSeq,
      serverTick: this.runtime.world.currentTick,
    });
  }

  get world(): World {
    return this.runtime.world;
  }
}

/**
 * 客户端会话（docs/networking.md §4.3）。
 *
 * - 本地只预测「move」（rng/clock 无关、可由自己确定）；其余命令仅上行不预测。
 * - 收到权威快照后：applySnapshot → 丢弃已确认 move → 在权威基准上重放未确认 move
 *   （回滚重放，绝不重跑 world.tick，避免重复模拟服务端实体）。
 * - 远端实体用最近两帧快照插值渲染；本地玩家用预测位置。
 * - 表现从权威事件流派生。
 */
export class ClientSession {
  private seq = 0;
  private pendingMoves: ClientMessage[] = [];
  private prevSnapshot: WorldSnapshot | null = null;
  private latestSnapshot: WorldSnapshot | null = null;
  private readonly actorId: string;

  constructor(
    private readonly runtime: GameRuntime,
    private readonly endpoint: Endpoint<ClientMessage, ServerMessage>,
    private readonly deriver: PresentationDeriver,
    actorId = "player",
  ) {
    this.actorId = actorId;
    endpoint.onMessage((message) => this.onServerMessage(message));
  }

  /** 发出一条命令。move 立即本地预测并缓冲待确认；其余命令仅上行。 */
  send(command: GameCommand): void {
    this.seq += 1;
    const message: ClientMessage = { type: "command", seq: this.seq, clientTick: this.runtime.world.currentTick, command };
    this.endpoint.send(message);
    if (command.kind === "move") {
      applyCommand(this.runtime, this.actorId, command); // 本地预测：只改本地玩家位置，不 tick 系统
      this.pendingMoves.push(message);
    }
  }

  private onServerMessage(message: ServerMessage): void {
    // 1. 灌入权威快照（含服务端 tick / rng / 全实体）。
    applySnapshot(this.runtime.world, message.snapshot);

    // 2. 丢弃已被服务端确认的预测 move。
    this.pendingMoves = this.pendingMoves.filter((pending) => pending.seq > message.ackedSeq);

    // 3. 在权威基准上重放仍未确认的本地 move（回滚重放，仅 move，不 tick）。
    for (const pending of this.pendingMoves) applyCommand(this.runtime, this.actorId, pending.command);

    // 4. 维护插值用的最近两帧快照。
    this.prevSnapshot = this.latestSnapshot ?? message.snapshot;
    this.latestSnapshot = message.snapshot;

    // 5. 从权威事件流派生表现（visualEvents / 日志）。
    this.deriver.consume(message.events, message.snapshot.tick * this.runtime.world.tickIntervalMs);
  }

  /** 本地玩家用预测位置；远端实体用插值位置。 */
  get world(): World {
    return this.runtime.world;
  }

  /**
   * 远端实体的渲染位置：在最近两帧快照之间按 alpha 插值（天然落后约 1 tick）。
   * alpha ∈ [0,1] 为「距下一 tick 的进度」（由渲染层用真实帧时间给出）。
   * 本地玩家（actorId）不走插值，返回 undefined 让渲染层用预测位置。
   */
  interpolatedPosition(entityId: string, alpha: number): { x: number; y: number } | undefined {
    if (entityId === this.actorId) return undefined;
    const prev = this.prevSnapshot;
    const latest = this.latestSnapshot;
    if (!prev || !latest) return undefined;
    const a = prev.entities[entityId]?.components.position;
    const b = latest.entities[entityId]?.components.position;
    if (!b) return undefined;
    if (!a) return { x: b.x, y: b.y };
    const t = clamp(alpha, 0, 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
