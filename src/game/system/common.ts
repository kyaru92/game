
import { deepClone } from "../utils";

export function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : deepClone(value);
}

export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  if (typeof value === "string") return [value.trim().toLowerCase()].filter(Boolean);
  return [];
}

export function formatDistance(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function roundCoord(value: number): number {
  return Number(value.toFixed(3));
}
