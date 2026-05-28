export type JsonObj = Record<string, any>;

export interface Target {
  kind: "entity" | "position" | "none";
  entityId?: string;
  position?: [number, number];
}

export interface TargetContext {
  actorId?: string;
  selectedTarget?: Target;
  cursorPosition?: [number, number];
  requireExplicitEntity?: boolean;
}

export interface ItemInstance {
  instanceId: string;
  protoId: string;
  components: JsonObj;
}

export interface Entity {
  entityId: string;
  name: string;
  components: JsonObj;
}

export interface EventData {
  name: string;
  data: JsonObj;
}

export interface VisualEvent {
  id: number;
  kind: "text" | "burst" | "teleport";
  x: number;
  y: number;
  text?: string;
  color: string;
  createdAtMs: number;
  durationMs: number;
}

export interface EffectSummary {
  id: string;
  name: string;
  description: string;
  stacks: number;
  remainingText: string;
  remainingMs: number | null;
  durationMs: number;
  progress: number;
  color: string;
  modifiers: JsonObj[];
  periodicEffect?: JsonObj;
  behavior: string;
}

export interface GameRuntime {
  world: import("./world").World;
  activationSystem: import("./systems").ActivationSystem;
  firearmSystem: import("./systems").FirearmSystem;
  effectSystem: import("./systems").EffectSystem;
  attributeSystem: import("./systems").AttributeSystem;
}
