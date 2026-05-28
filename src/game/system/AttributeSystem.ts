
import type { AttributeId, AttributeMap, EffectModifier } from "../../domain/componentTypes";
import type { Entity } from "../types";
import type { World } from "../world";
import { effectStackCount, stackedValue } from "../utils";

export class AttributeSystem {
  constructor(private readonly world: World) {}

  finalAttributes(entity: Entity): AttributeMap {
    const attrs: AttributeMap = { ...(entity.components.attributes ?? {}) };
    for (const [effectId, active] of Object.entries(entity.components.active_effects ?? {})) {
      const definition = this.world.effects[effectId];
      if (!definition) continue;
      const stacks = effectStackCount(active);
      for (const modifier of definition.modifiers ?? []) applyModifier(attrs, modifier, stacks);
    }
    return attrs;
  }

  get(entity: Entity, attribute: AttributeId, fallback = 0): number {
    return this.finalAttributes(entity)[attribute] ?? fallback;
  }
}

function applyModifier(attrs: AttributeMap, modifier: EffectModifier, stacks: number): void {
  const attr = modifier.attribute;
  const current = attrs[attr] ?? 0;
  const effectiveValue = stackedValue(modifier.value, stacks, modifier.stackType ?? "none");

  switch (modifier.op) {
    case "add":
      attrs[attr] = current + effectiveValue;
      return;
    case "mul":
      attrs[attr] = current * (1 + effectiveValue);
      return;
    case "override":
      attrs[attr] = effectiveValue;
      return;
    default:
      assertNever(modifier.op);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unknown attribute modifier op: ${value}`);
}
