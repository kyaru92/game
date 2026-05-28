
import type { Entity, JsonObj } from "../types";
import type { World } from "../world";
import { effectStackCount, stackedValue } from "../utils";

export class AttributeSystem {
  constructor(private readonly world: World) {}

  finalAttributes(entity: Entity): JsonObj {
    const attrs: JsonObj = JSON.parse(JSON.stringify(entity.components.attributes ?? {}));
    for (const [effectId, active] of Object.entries<JsonObj>(entity.components.active_effects ?? {})) {
      const definition = this.world.effects[effectId];
      if (!definition) continue;
      const stacks = effectStackCount(active);
      for (const modifier of definition.modifiers ?? []) {
        const attr = modifier.attribute;
        attrs[attr] ??= 0;
        const op = String(modifier.op ?? "add");
        const value = Number(modifier.value ?? 0);
        const stackType = String(modifier.stackType ?? "none");
        const effectiveValue = stackedValue(value, stacks, stackType);
        if (op === "add") attrs[attr] = Number(attrs[attr]) + effectiveValue;
        else if (op === "mul") attrs[attr] = Number(attrs[attr]) * (1 + effectiveValue);
        else if (op === "override") attrs[attr] = effectiveValue;
      }
    }
    return attrs;
  }
}
