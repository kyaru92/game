import type { GameCommand } from "./command";
import type { SimEvent } from "./events";
import type { WorldSnapshot } from "./snapshot";

/**
 * 传输抽象（docs/networking.md §4.2）。
 *
 * 把「客户端 ↔ 服务端」的字节通道抽象成可替换接口：首个实现是同进程
 * loopback（单机内跑通预测/校正），之后可换 WebSocket，会话层代码不变。
 */

/** 上行：客户端 → 服务端。命令带 seq（用于 ack）与 clientTick（用于延迟补偿）。 */
export type ClientMessage = {
  type: "command";
  seq: number;
  clientTick: number;
  command: GameCommand;
};

/** 下行：服务端 → 客户端。全量快照 + 本 tick 事件流 + 已确认的命令 seq。 */
export type ServerMessage = {
  type: "snapshot";
  snapshot: WorldSnapshot;
  events: SimEvent[];
  ackedSeq: number;
  serverTick: number;
};

/** 单向收发端点。send 发出，onMessage 注册接收回调。 */
export interface Endpoint<TSend, TRecv> {
  send(message: TSend): void;
  onMessage(handler: (message: TRecv) => void): void;
}

/** 一条双向通道的两端：client 端发 ClientMessage 收 ServerMessage，server 端相反。 */
export interface Transport {
  readonly client: Endpoint<ClientMessage, ServerMessage>;
  readonly server: Endpoint<ServerMessage, ClientMessage>;
}
