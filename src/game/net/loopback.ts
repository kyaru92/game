import type { ClientMessage, Endpoint, ServerMessage, Transport } from "./transport";

/**
 * 同进程 loopback 传输（docs/networking.md §4.2）。
 *
 * 客户端与服务端在同一进程内，消息直接投递给对端回调。
 * 可选 latencyTicks 模拟网络延迟：消息按「发出时的逻辑 tick + latency」延后投递，
 * 由 advance(tick) 在每 tick 驱动投递（用于延迟补偿验证）。latencyTicks=0 时即时投递。
 */
export class LoopbackTransport implements Transport {
  readonly client: Endpoint<ClientMessage, ServerMessage>;
  readonly server: Endpoint<ServerMessage, ClientMessage>;

  // 到达客户端的消息（由 server.send 投递）的接收回调，经 client.onMessage 注册。
  private clientReceive?: (message: ServerMessage) => void;
  // 到达服务端的消息（由 client.send 投递）的接收回调，经 server.onMessage 注册。
  private serverReceive?: (message: ClientMessage) => void;
  // 延迟队列：{ releaseAtTick, deliver }。
  private readonly pending: Array<{ releaseAtTick: number; deliver: () => void }> = [];
  private logicalTick = 0;

  constructor(private readonly latencyTicks = 0) {
    this.client = {
      send: (message) => this.enqueue(() => this.serverReceive?.(message)),
      onMessage: (handler) => { this.clientReceive = handler; },
    };
    this.server = {
      send: (message) => this.enqueue(() => this.clientReceive?.(message)),
      onMessage: (handler) => { this.serverReceive = handler; },
    };
  }

  /** 推进逻辑时钟并投递到期消息（latencyTicks>0 时必须每 tick 调用）。 */
  advance(tick: number): void {
    this.logicalTick = tick;
    if (this.latencyTicks <= 0) return;
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i].releaseAtTick <= tick) {
        const [entry] = this.pending.splice(i, 1);
        entry.deliver();
      }
    }
  }

  private enqueue(deliver: () => void): void {
    if (this.latencyTicks <= 0) {
      deliver();
      return;
    }
    this.pending.push({ releaseAtTick: this.logicalTick + this.latencyTicks, deliver });
  }
}
