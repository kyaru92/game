/**
 * 领域事件（SimEvent）：权威模拟产出的「事实」，可序列化。
 *
 * 设计约束（docs/networking.md §4.1）：
 * - 系统不再直接产像素 VFX（颜色/浮字/光环），而是发这些语义事实。
 *   客户端的 PresentationDeriver 订阅后在本地派生具体表现。
 * - 全部字段可序列化：服务端把每 tick 产出的事件随 snapshot 下行，
 *   客户端据此派生 visualEvents 与日志。
 * - 事件自带渲染所需的坐标/颜色，不依赖「客户端是否持有该实体」。
 *   例如 died/projectileImpact 发生时实体可能已被移除，故坐标内联在事件里。
 */
export type SimEvent =
  | { type: "log"; text: string }
  | { type: "damaged"; entityId: string; x: number; y: number; amount: number; damageType: string }
  | { type: "died"; entityId: string; x: number; y: number }
  | { type: "effectApplied"; entityId: string; x: number; y: number; effectId: string; name: string; withText: boolean }
  | { type: "periodicTick"; entityId: string; x: number; y: number; attr: string; delta: number }
  | { type: "teleported"; from: [number, number]; to: [number, number] }
  | { type: "spawned"; entityId: string; x: number; y: number; name: string; color: string }
  | { type: "lootDropped"; entityId: string; x: number; y: number; color: string }
  | { type: "projectileImpact"; x: number; y: number; color: string };
