import type { EffectSummary, ItemInstance, JsonObj, Target } from "./types";
import type { World } from "./world";

const EFFECT_COLORS: Record<string, string> = {
  adrenaline: "#facc15",
  regeneration: "#34d399",
  poison: "#84cc16",
  focus: "#a78bfa",
};

const ITEM_ICON_FALLBACKS: Record<string, string> = {
  "adrenaline-injector": "💉",
  "regen-serum": "🧪",
  "focus-coffee": "☕",
  "toxic-dart": "🎯",
  "poison-cloud-grenade": "☣️",
  "blink-device": "⚡",
  "monster-egg": "🥚",
  "impact-hammer": "🔨",
};

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deepMerge<T extends JsonObj>(base: T, override: JsonObj): T {
  const target = base as JsonObj;
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(target[key])) deepMerge(target[key], value);
    else target[key] = deepClone(value);
  }
  return base;
}

function isPlainObject(value: unknown): value is JsonObj {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeArray(value: unknown): JsonObj[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value as JsonObj];
  return [];
}

export function effectColor(effectId: string): string {
  return EFFECT_COLORS[effectId] ?? "#f8fafc";
}

export function itemIcon(protoId: string): string {
  return ITEM_ICON_FALLBACKS[protoId] ?? "📦";
}

export function displayItemName(item: ItemInstance): string {
  return item.components.display?.name ?? item.protoId;
}

export function initEntityRuntimeState(entity: { components: JsonObj }): void {
  entity.components.active_effects ??= {};
  const resources = entity.components.resources;
  if (resources && typeof resources === "object") {
    for (const [key, value] of Object.entries(resources)) {
      if (!key.startsWith("max_") || typeof value !== "number") continue;
      const resourceKey = key.slice(4);
      resources[resourceKey] ??= value;
    }
  }
}

export function initItemRuntimeState(item: ItemInstance): void {
  const activation = item.components.activation;
  if (!activation) return;
  const maxCharges = activation.maxCharges ?? activation.max ?? activation.charges ?? 1;
  activation.maxCharges ??= maxCharges;
  activation.charges ??= maxCharges;
  activation._cooldownUntilMs ??= 0;
}

export function describeTarget(world: World, target: Target): string {
  if (target.kind === "entity" && target.entityId) return world.entityName(target.entityId);
  if (target.kind === "position" && target.position) return `(${formatCoord(target.position[0])}, ${formatCoord(target.position[1])})`;
  return "<none>";
}

export function formatCoord(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function cooldownRemainingMs(item: ItemInstance, world: World): number {
  const activation = item.components.activation;
  if (!activation) return 0;
  return Math.max(0, Number(activation._cooldownUntilMs ?? 0) - world.nowMs());
}

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.ceil(ms)}ms`;
}

export function formatDuration(durationMs: number): string {
  return durationMs < 0 ? "永久" : formatMs(durationMs);
}

export function effectStackCount(active: JsonObj): number {
  if (active.behavior === "independent") return (active.layers ?? []).length;
  return Number(active.stacks ?? 1);
}

export function stackedValue(value: number, stacks: number, stackType: string): number {
  if (stackType === "add") return value * stacks;
  if (stackType === "mul") return (1 + value) ** stacks - 1;
  return value;
}

export function summarizeTiming(runtime: JsonObj, now: number): Pick<EffectSummary, "remainingText" | "remainingMs" | "durationMs" | "progress"> {
  if (runtime.behavior === "independent") {
    const layers: JsonObj[] = runtime.layers ?? [];
    const remains = layers.map((layer) => layer.expiresAtMs === null ? null : Math.max(0, Number(layer.expiresAtMs) - now));
    const finite = remains.filter((value): value is number => value !== null);
    const remainingMs = finite.length ? Math.max(...finite) : null;
    const durationMs = Math.max(...layers.map((layer) => Number(layer.durationMs ?? -1)), -1);
    const progress = durationMs > 0 && remainingMs !== null ? clamp(remainingMs / durationMs, 0, 1) : 1;
    return {
      remainingText: remains.map((value) => value === null ? "∞" : formatMs(value)).join(" / "),
      remainingMs,
      durationMs,
      progress,
    };
  }

  const durationMs = Number(runtime.durationMs ?? -1);
  if (runtime.expiresAtMs === null || runtime.expiresAtMs === undefined || durationMs < 0) {
    return { remainingText: "∞", remainingMs: null, durationMs, progress: 1 };
  }
  const remainingMs = Math.max(0, Number(runtime.expiresAtMs) - now);
  return {
    remainingText: formatMs(remainingMs),
    remainingMs,
    durationMs,
    progress: durationMs > 0 ? clamp(remainingMs / durationMs, 0, 1) : 0,
  };
}
