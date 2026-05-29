import type { SimEvent } from "./net/events";
import type { VisualEvent } from "./types";
import { effectColor } from "./utils";

/**
 * 表现状态：客户端本地，不参与权威，不进 snapshot。
 *
 * 由权威事件流（SimEvent[]）在本地派生而来：
 * - visualEvents：canvas 浮字 / 光环 / 闪现拖尾等像素特效。
 * - messages：日志面板文本。
 *
 * docs/networking.md §4.1：表现产物从权威 World 剥离到这里。
 */
export class PresentationState {
  readonly visualEvents: VisualEvent[] = [];
  readonly messages: string[] = [];
  private nextVisualNo = 1;

  nextVisualId(): number {
    return this.nextVisualNo++;
  }

  reset(): void {
    this.visualEvents.length = 0;
    this.messages.length = 0;
  }
}

/**
 * 表现派生器：消费权威事件流，产出 visualEvents 与日志。
 *
 * 把原 VisualEventService 的「像素决策」（颜色/浮字/光环/拖尾）搬到表现侧，
 * 系统只发语义事实（damaged/died/effectApplied…），具体怎么画由这里决定。
 */
export class PresentationDeriver {
  constructor(private readonly state: PresentationState) {}

  /** 消费一批事件，nowMs 为这批事件发生的逻辑时刻（visualEvent.createdAtMs 基准）。 */
  consume(events: readonly SimEvent[], nowMs: number): void {
    for (const event of events) this.derive(event, nowMs);
  }

  /** 老化过期的 visualEvents（原在 World.tick 末尾，现移到表现侧）。 */
  age(nowMs: number): void {
    const events = this.state.visualEvents;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (nowMs - events[i].createdAtMs > events[i].durationMs) events.splice(i, 1);
    }
  }

  private derive(event: SimEvent, nowMs: number): void {
    switch (event.type) {
      case "log":
        this.log(event.text);
        return;
      case "damaged":
        this.text(event.x, event.y, `-${formatNumber(event.amount)} hp`, "#fb7185", nowMs);
        return;
      case "died":
        this.burst(event.x, event.y, "#f43f5e", nowMs);
        return;
      case "effectApplied": {
        const color = effectColor(event.effectId);
        this.burst(event.x, event.y, color, nowMs);
        if (event.withText) this.text(event.x, event.y, event.name, color, nowMs);
        return;
      }
      case "periodicTick": {
        const sign = event.delta >= 0 ? "+" : "";
        const color = event.delta >= 0 ? "#4ade80" : "#fb7185";
        this.text(event.x, event.y, `${sign}${formatNumber(event.delta)} ${event.attr}`, color, nowMs);
        return;
      }
      case "teleported":
        this.teleportTrail(event.from, event.to, nowMs);
        return;
      case "spawned":
        this.burst(event.x, event.y, event.color, nowMs);
        this.text(event.x, event.y, event.name, event.color, nowMs);
        return;
      case "lootDropped":
        this.burst(event.x, event.y, event.color, nowMs);
        this.text(event.x, event.y, "掉落箱", "#facc15", nowMs);
        return;
      case "projectileImpact":
        this.burst(event.x, event.y, event.color, nowMs);
        return;
    }
  }

  private log(message: string): void {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    this.state.messages.push(`[${time}] ${message}`);
    if (this.state.messages.length > 120) this.state.messages.splice(0, this.state.messages.length - 120);
  }

  private text(x: number, y: number, text: string, color: string, nowMs: number): void {
    this.state.visualEvents.push({ id: this.state.nextVisualId(), kind: "text", x, y, text, color, createdAtMs: nowMs, durationMs: 1150 });
  }

  private burst(x: number, y: number, color: string, nowMs: number): void {
    this.state.visualEvents.push({ id: this.state.nextVisualId(), kind: "burst", x, y, color, createdAtMs: nowMs, durationMs: 700 });
  }

  private teleportTrail(from: [number, number], to: [number, number], nowMs: number): void {
    this.state.visualEvents.push({ id: this.state.nextVisualId(), kind: "teleport", x: from[0], y: from[1], color: "#60a5fa", createdAtMs: nowMs, durationMs: 600 });
    this.state.visualEvents.push({ id: this.state.nextVisualId(), kind: "burst", x: to[0], y: to[1], color: "#93c5fd", createdAtMs: nowMs, durationMs: 700 });
  }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
