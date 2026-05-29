/**
 * 确定性随机数发生器（mulberry32）。
 *
 * 设计目的：
 * - 服务端权威，随机结果必须可复现（重放、回滚、快照同步都依赖它）。
 * - 状态只有一个 32 位无符号整数，便于随 snapshot 序列化与恢复。
 *
 * 约束：游戏逻辑禁止直接使用 Math.random，所有随机都必须经过 World.rng。
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    // 归一化为 32 位无符号整数，0 也接受。
    this.state = seed >>> 0;
  }

  /** 当前内部状态，用于快照序列化。 */
  getState(): number {
    return this.state >>> 0;
  }

  /** 从快照恢复内部状态。 */
  setState(state: number): void {
    this.state = state >>> 0;
  }

  /** 返回 [0, 1) 的浮点数，等价于 Math.random()。 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 概率判定：以 probability 的概率返回 true。probability<=0 必假，>=1 必真。 */
  chance(probability: number): boolean {
    if (probability <= 0) return false;
    if (probability >= 1) return true;
    return this.next() < probability;
  }

  /** 返回 [min, max] 闭区间内的整数。 */
  int(min: number, max: number): number {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    if (hi <= lo) return lo;
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** 返回 [min, max) 的浮点数。 */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}
