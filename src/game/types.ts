import type {
  ActiveEffectRuntime,
  EffectModifier,
  EffectOverride,
  EntityRuntimeComponents,
  ItemRuntimeComponents,
  PeriodicEffect,
  Target,
  TargetSelector,
} from "../domain/componentTypes";
import type { CollisionBox } from "./services";

export type { Target };

export interface TargetContext {
  actorId?: string;
  selectedTarget?: Target;
  cursorPosition?: [number, number];
  requireExplicitEntity?: boolean;
}

export interface ItemInstance {
  instanceId: string;
  protoId: string;
  components: ItemRuntimeComponents;
}

export interface Entity {
  entityId: string;
  name: string;
  components: EntityRuntimeComponents;
}

export interface BeforeItemActivationEventData {
  actorId: string;
  itemId: string;
  inventoryIndex: number;
  target: Target;
  cancelReason?: string;
}

export interface OnItemActivationEventData {
  actorId: string;
  itemId: string;
  inventoryIndex: number;
  target: Target;
}

export interface ApplyEffectRequestEventData {
  effectId: string;
  targetEntityId: string;
  sourceEntityId?: string;
  sourceItemId?: string;
  effectOverrides?: EffectOverride;
}

export interface OnEntityDeathEventData {
  entityId: string;
  entity: Entity;
  position?: { x: number; y: number };
  bounds: CollisionBox;
}

export interface GameEventMap {
  BeforeItemActivation: BeforeItemActivationEventData;
  OnItemActivation: OnItemActivationEventData;
  ApplyEffectRequest: ApplyEffectRequestEventData;
  OnEntityDeath: OnEntityDeathEventData;
}

export type EventData<K extends keyof GameEventMap = keyof GameEventMap> = {
  [P in keyof GameEventMap]: {
    name: P;
    data: GameEventMap[P];
  };
}[K];

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
  modifiers: EffectModifier[];
  periodicEffect?: PeriodicEffect;
  behavior: "refresh_duration" | "independent" | "none";
}

export type { ActiveEffectRuntime, TargetSelector };

export interface GameRuntime {
  world: import("./world").World;
  activationSystem: import("./systems").ActivationSystem;
  firearmSystem: import("./systems").FirearmSystem;
  lootSystem: import("./systems").LootSystem;
  effectSystem: import("./systems").EffectSystem;
  attributeSystem: import("./systems").AttributeSystem;
}
