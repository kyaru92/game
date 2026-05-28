import type { World } from "../world";

export class VisualEventService {
  constructor(private readonly world: World) {}

  addFloatingText(entityId: string, text: string, color: string): void {
    const entity = this.world.entities[entityId];
    const position = entity?.components.position ?? { x: 0, y: 0 };
    this.world.visualEvents.push({
      id: this.world.nextVisualId(),
      kind: "text",
      x: position.x,
      y: position.y,
      text,
      color,
      createdAtMs: this.world.nowMs(),
      durationMs: 1150,
    });
  }

  addBurst(entityId: string, color: string): void {
    const entity = this.world.entities[entityId];
    const position = entity?.components.position ?? { x: 0, y: 0 };
    this.world.visualEvents.push({
      id: this.world.nextVisualId(),
      kind: "burst",
      x: position.x,
      y: position.y,
      color,
      createdAtMs: this.world.nowMs(),
      durationMs: 700,
    });
  }

  addTeleportTrail(from: [number, number], to: [number, number]): void {
    this.world.visualEvents.push({
      id: this.world.nextVisualId(),
      kind: "teleport",
      x: from[0],
      y: from[1],
      color: "#60a5fa",
      createdAtMs: this.world.nowMs(),
      durationMs: 600,
    });
    this.world.visualEvents.push({
      id: this.world.nextVisualId(),
      kind: "burst",
      x: to[0],
      y: to[1],
      color: "#93c5fd",
      createdAtMs: this.world.nowMs(),
      durationMs: 700,
    });
  }
}
