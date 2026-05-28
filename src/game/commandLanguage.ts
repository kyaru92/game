import { parse } from "jsonc-parser";
import { itemPrototypeComponentsSchema } from "../domain/componentSchemas";
import type { ItemDefinition } from "../domain/componentTypes";
import type { GameRuntime, JsonObj } from "./types";
import { deepClone } from "./utils";

export interface CommandSuggestion {
  label: string;
  insert: string;
  description: string;
  replaceFrom?: number;
  replaceTo?: number;
}

export type ItemPatch =
  | { op: "set"; path: string[]; value: unknown }
  | { op: "remove"; path: string[] };

export interface ParsedGiveCommand {
  entitySelector: string;
  protoId: string;
  patches: ItemPatch[];
  hasPatches: boolean;
}

interface TokenRange {
  text: string;
  start: number;
  end: number;
}

const COMMAND_TEMPLATES: CommandSuggestion[] = [
  { label: "help", insert: "help", description: "显示所有指令和示例" },
  { label: "entities", insert: "entities", description: "列出当前世界里的实体" },
  { label: "spawn", insert: 'spawn hatched-monster slime_1 6 6 {"resources":{"hp":50,"max_hp":50}}', description: "按 entity prototype 生成实体，可附加 overrides" },
  { label: "component", insert: 'component slime ai {"state":"patrol","range":5}', description: "给实体写入/覆盖自定义 component" },
  { label: "item", insert: 'item @player debug-potion {"display":{"name":"调试药水"},"targeting":{"mode":"self"},"activation":{"max":3},"effect_applier":[{"kind":"regeneration","target":"self"}]}', description: "创建自定义 component 物品并放入背包" },
  { label: "give", insert: "give @player poison-cloud-grenade", description: "给予物品；支持 proto[component:field=value;!component] 变体" },
  { label: "give variant", insert: 'give @player debug-potion[display:name="调试药水";targeting:mode=self;activation:max=3;effect_applier=[{"kind":"regeneration","target":"self"}]]', description: "创建/给予运行时自定义原型或已有原型变体" },
  { label: "reload", insert: "reload @player 9", description: "装填指定物品槽位的枪械" },
  { label: "apply", insert: "apply poison @dummy", description: "直接对实体施加 effect" },
  { label: "damage", insert: "damage crate-1 15 impact", description: "造成指定类型伤害；木箱只接受 impact/fire" },
  { label: "heal", insert: "heal @player 100", description: "恢复生命" },
  { label: "remove", insert: "remove slime", description: "移除非玩家实体" },
];

export function parseGiveCommandLine(raw: string): ParsedGiveCommand {
  const command = readToken(raw, 0);
  if (!command || command.text.toLowerCase() !== "give") throw new Error("用法：give <entity> <itemProtoId>[patches]");
  const entity = readToken(raw, command.end);
  const specStart = entity ? skipWhitespace(raw, entity.end) : raw.length;
  const spec = raw.slice(specStart).trim();
  if (!entity || !spec) throw new Error("用法：give <entity> <itemProtoId>[component:field=value;!component]");
  const parsed = parseItemSpec(spec);
  return {
    entitySelector: entity.text,
    protoId: parsed.protoId,
    patches: parsed.patches,
    hasPatches: parsed.hasPatches,
  };
}

export function parseItemSpec(spec: string): { protoId: string; patches: ItemPatch[]; hasPatches: boolean } {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("缺少 item prototype id");
  const openIndex = trimmed.indexOf("[");
  if (openIndex < 0) {
    if (/\s/.test(trimmed)) throw new Error("item prototype id 中不能包含空白；变体参数请写在 [] 中");
    return { protoId: normalizePrototypeIdOrThrow(trimmed), patches: [], hasPatches: false };
  }

  const closeIndex = findMatchingSquareBracket(trimmed, openIndex);
  if (closeIndex < 0) throw new Error("give 变体缺少闭合的 ]");
  if (trimmed.slice(closeIndex + 1).trim()) throw new Error("give 变体 ] 后存在多余内容");

  const protoId = normalizePrototypeIdOrThrow(trimmed.slice(0, openIndex).trim());
  const patchText = trimmed.slice(openIndex + 1, closeIndex);
  return { protoId, patches: parseItemPatches(patchText), hasPatches: true };
}

export function applyItemPatches(baseComponents: JsonObj, patches: ItemPatch[]): JsonObj {
  const components = deepClone(baseComponents);
  for (const patch of patches) {
    if (patch.op === "set") setPath(components, patch.path, patch.value);
    else removePath(components, patch.path);
  }
  return components;
}

export function getCommandSuggestions(runtime: GameRuntime, line: string, cursor = line.length): CommandSuggestion[] {
  const safeCursor = Math.max(0, Math.min(cursor, line.length));
  const prefix = line.slice(0, safeCursor);
  const command = readToken(line, 0);

  if (!command || safeCursor <= command.end) return commandSuggestionsFor(prefix, 0, safeCursor);

  if (command.text.toLowerCase() !== "give") return fallbackCommandSuggestions(line);

  const entity = readToken(line, command.end);
  const entityStart = entity?.start ?? skipWhitespace(line, command.end);
  if (!entity || safeCursor <= entity.end) {
    return entitySuggestions(runtime, entity?.text ?? "", entityStart, entity?.end ?? safeCursor);
  }

  const specStart = skipWhitespace(line, entity.end);
  if (safeCursor < specStart) return entitySuggestions(runtime, "", safeCursor, safeCursor);

  return giveSpecSuggestions(runtime, line, safeCursor, specStart);
}

export function itemPrototype(runtime: GameRuntime, protoId: string): ItemDefinition | undefined {
  return runtime.world.itemPrototypes[protoId] ?? runtime.world.customItemPrototypes[protoId];
}

function parseItemPatches(text: string): ItemPatch[] {
  const patches: ItemPatch[] = [];
  for (const rawPart of splitTopLevel(text, ";")) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.startsWith("!")) {
      const path = parsePath(part.slice(1).trim());
      if (!path.length) throw new Error("! 后缺少 component 或 component.field");
      patches.push({ op: "remove", path });
      continue;
    }

    const colon = findTopLevelChar(part, ":");
    if (colon < 0) throw new Error(`patch 缺少 ':'：${part}`);
    const component = part.slice(0, colon).trim();
    if (!component) throw new Error(`patch 缺少 component：${part}`);
    const assignmentsText = part.slice(colon + 1);
    const assignments = splitTopLevel(assignmentsText, ",").map((value) => value.trim()).filter(Boolean);
    if (!assignments.length) throw new Error(`component ${component} 缺少 field=value`);

    for (const assignment of assignments) {
      const equals = findTopLevelChar(assignment, "=");
      if (equals < 0) throw new Error(`赋值缺少 '='：${assignment}`);
      const fieldPath = parsePath(assignment.slice(0, equals).trim());
      if (!fieldPath.length) throw new Error(`component ${component} 存在空字段名`);
      const valueText = assignment.slice(equals + 1).trim();
      patches.push({ op: "set", path: [component, ...fieldPath], value: parseCommandValue(valueText) });
    }
  }
  return patches;
}

function parseCommandValue(text: string): unknown {
  const value = text.trim();
  if (!value) throw new Error("赋值缺少 value");
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
  const first = value[0];
  if (first === "{" || first === "[" || first === '"') return parseJsonLike(value);
  if (first === "'" && value.endsWith("'")) return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  return value;
}

function parseJsonLike(text: string): unknown {
  const errors: any[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`JSON/JSONC value 解析失败：${text}`);
  return value;
}

function setPath(root: JsonObj, path: string[], value: unknown): void {
  let target: JsonObj = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const next = target[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) target[key] = {};
    target = target[key] as JsonObj;
  }
  target[path[path.length - 1]] = deepClone(value);
}

function removePath(root: JsonObj, path: string[]): void {
  let target: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!target || typeof target !== "object" || Array.isArray(target)) return;
    target = (target as JsonObj)[path[index]];
  }
  if (target && typeof target === "object" && !Array.isArray(target)) delete (target as JsonObj)[path[path.length - 1]];
}

function parsePath(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const path = trimmed.split(".").map((part) => part.trim());
  if (path.some((part) => !part)) throw new Error(`路径格式错误：${text}`);
  return path;
}

function giveSpecSuggestions(runtime: GameRuntime, line: string, cursor: number, specStart: number): CommandSuggestion[] {
  const specPrefix = line.slice(specStart, cursor);
  const openRelative = specPrefix.indexOf("[");
  if (openRelative < 0) {
    return prototypeSuggestions(runtime, specPrefix.trimStart(), specStart + leadingWhitespaceLength(specPrefix), cursor);
  }

  const protoRaw = specPrefix.slice(0, openRelative).trim();
  const protoId = normalizePrototypeId(protoRaw);
  const patchStart = specStart + openRelative + 1;
  const patchPrefix = line.slice(patchStart, cursor);
  const segmentInfo = currentTopLevelSegment(patchPrefix, ";");
  const segment = segmentInfo.text;
  const segmentStart = patchStart + segmentInfo.start;
  const segmentContentStart = segmentStart + leadingWhitespaceLength(segment);
  const trimmedSegment = segment.trimStart();

  if (trimmedSegment.startsWith("!")) {
    const bangOffset = segment.indexOf("!");
    const pathStart = segmentStart + bangOffset + 1;
    const current = line.slice(pathStart, cursor).trimStart();
    const currentStart = pathStart + leadingWhitespaceLength(line.slice(pathStart, cursor));
    return removePathSuggestions(runtime, protoId, current, currentStart, cursor);
  }

  const colon = findTopLevelChar(segment, ":");
  if (colon < 0) {
    const current = line.slice(segmentContentStart, cursor);
    return componentSuggestions(runtime, protoId, current, segmentContentStart, cursor);
  }

  const component = segment.slice(0, colon).trim();
  const afterColonStart = segmentStart + colon + 1;
  const afterColonPrefix = line.slice(afterColonStart, cursor);
  const assignmentInfo = currentTopLevelSegment(afterColonPrefix, ",");
  const assignment = assignmentInfo.text;
  const assignmentStart = afterColonStart + assignmentInfo.start;
  const equals = findTopLevelChar(assignment, "=");
  if (equals < 0) {
    const fieldStart = assignmentStart + leadingWhitespaceLength(assignment);
    const current = line.slice(fieldStart, cursor);
    return fieldSuggestions(component, current, fieldStart, cursor);
  }

  const fieldPath = parseLoosePath(assignment.slice(0, equals));
  const valueStart = assignmentStart + equals + 1 + leadingWhitespaceLength(assignment.slice(equals + 1));
  const currentValue = line.slice(valueStart, cursor);
  return valueSuggestions(runtime, component, fieldPath, currentValue, valueStart, cursor);
}

function commandSuggestionsFor(prefix: string, replaceFrom: number, replaceTo: number): CommandSuggestion[] {
  const text = prefix.trim().toLowerCase();
  const suggestions = text
    ? COMMAND_TEMPLATES.filter((suggestion) => suggestion.label.toLowerCase().includes(text) || suggestion.insert.toLowerCase().startsWith(text))
    : COMMAND_TEMPLATES.slice(0, 6);
  return suggestions.slice(0, 8).map((suggestion) => ({ ...suggestion, replaceFrom, replaceTo }));
}

function fallbackCommandSuggestions(line: string): CommandSuggestion[] {
  const text = line.trim().toLowerCase();
  if (!text) return COMMAND_TEMPLATES.slice(0, 6).map((suggestion) => ({ ...suggestion, replaceFrom: 0, replaceTo: line.length }));
  return COMMAND_TEMPLATES
    .filter((suggestion) => {
      const haystack = `${suggestion.label} ${suggestion.insert} ${suggestion.description}`.toLowerCase();
      return haystack.includes(text) || suggestion.label.startsWith(text.split(/\s+/)[0] ?? "");
    })
    .slice(0, 6)
    .map((suggestion) => ({ ...suggestion, replaceFrom: 0, replaceTo: line.length }));
}

function entitySuggestions(runtime: GameRuntime, current: string, replaceFrom: number, replaceTo: number): CommandSuggestion[] {
  const aliases = ["@player", "@me", "@self", "@dummy", "@training-dummy"];
  const candidates = new Map<string, string>();
  for (const alias of aliases) candidates.set(alias, "实体别名");
  for (const entity of Object.values(runtime.world.entities)) {
    const display = entity.components.display?.name ?? entity.name;
    candidates.set(entity.entityId, `${entity.name}${display && display !== entity.name ? ` / ${display}` : ""}`);
  }
  return filterEntries(candidates, current)
    .slice(0, 8)
    .map(([label, description]) => ({ label, insert: `${label} `, description, replaceFrom, replaceTo }));
}

function prototypeSuggestions(runtime: GameRuntime, current: string, replaceFrom: number, replaceTo: number): CommandSuggestion[] {
  const candidates = new Map<string, string>();
  for (const [protoId, proto] of Object.entries(runtime.world.itemPrototypes)) candidates.set(protoId, proto.components.display?.name ?? "item prototype");
  for (const [protoId, proto] of Object.entries(runtime.world.customItemPrototypes)) candidates.set(protoId, proto.components.display?.name ?? "runtime custom prototype");
  return filterEntries(candidates, current)
    .slice(0, 10)
    .map(([label, description]) => ({ label, insert: label, description, replaceFrom, replaceTo }));
}

function componentSuggestions(runtime: GameRuntime, protoId: string, current: string, replaceFrom: number, replaceTo: number): CommandSuggestion[] {
  const candidates = componentCandidateMap(runtime, protoId, false);
  return filterEntries(candidates, current)
    .slice(0, 10)
    .map(([label, description]) => ({ label, insert: `${label}:`, description, replaceFrom, replaceTo }));
}

function removePathSuggestions(runtime: GameRuntime, protoId: string, current: string, replaceFrom: number, replaceTo: number): CommandSuggestion[] {
  const dot = current.indexOf(".");
  if (dot >= 0) {
    const component = current.slice(0, dot).trim();
    const fieldCurrent = current.slice(dot + 1);
    const fieldReplaceFrom = replaceFrom + dot + 1;
    return fieldSuggestions(component, fieldCurrent, fieldReplaceFrom, replaceTo)
      .map((suggestion) => ({ ...suggestion, insert: suggestion.label, description: `删除字段：${component}.${suggestion.label}` }));
  }

  const candidates = componentCandidateMap(runtime, protoId, true);
  return filterEntries(candidates, current)
    .slice(0, 10)
    .map(([label, description]) => ({ label, insert: label, description: `删除 ${description}`, replaceFrom, replaceTo }));
}

function fieldSuggestions(component: string, current: string, replaceFrom: number, replaceTo: number): CommandSuggestion[] {
  const fields = componentFieldNames(component);
  return fields
    .filter((field) => matchesCandidate(field, current))
    .slice(0, 10)
    .map((field) => ({ label: field, insert: `${field}=`, description: `${component}.${field}`, replaceFrom, replaceTo }));
}

function valueSuggestions(runtime: GameRuntime, component: string, fieldPath: string[], current: string, replaceFrom: number, replaceTo: number): CommandSuggestion[] {
  const values = valueCandidates(runtime, component, fieldPath);
  return values
    .filter((value) => matchesCandidate(value.label, current) || matchesCandidate(value.insert, current))
    .slice(0, 10)
    .map((value) => ({ ...value, replaceFrom, replaceTo }));
}

function componentCandidateMap(runtime: GameRuntime, protoId: string, existingOnly: boolean): Map<string, string> {
  const result = new Map<string, string>();
  const proto = protoId ? itemPrototype(runtime, protoId) : undefined;
  for (const component of Object.keys(proto?.components ?? {})) result.set(component, "已有组件");
  if (!existingOnly) {
    for (const component of Object.keys(itemComponentSchemas())) {
      if (!result.has(component)) result.set(component, "可新增组件");
    }
  }
  return result;
}

function valueCandidates(runtime: GameRuntime, component: string, fieldPath: string[]): Array<Pick<CommandSuggestion, "label" | "insert" | "description">> {
  const normalizedPath = fieldPath.map((part) => part.trim()).filter(Boolean);
  const last = normalizedPath[normalizedPath.length - 1];
  if (!last) return [];

  if (last === "kind" && normalizedPath.includes("effect_applier")) {
    return Object.keys(runtime.world.effects).sort().map((effectId) => ({ label: effectId, insert: effectId, description: "effect id" }));
  }
  if (component === "effect_applier" && last === "kind") {
    return Object.keys(runtime.world.effects).sort().map((effectId) => ({ label: effectId, insert: effectId, description: "effect id" }));
  }
  if (component === "entity_spawner" && (last === "prototype" || last === "entity")) {
    return Object.keys(runtime.world.entityPrototypes).sort().map((entityId) => ({ label: entityId, insert: entityId, description: "entity prototype id" }));
  }

  const schema = schemaAtPath(component, normalizedPath);
  const enumValues: unknown[] = Array.isArray(schema?.enum) ? schema.enum : [];
  return enumValues.map((value: unknown) => ({ label: String(value), insert: String(value), description: "可选值" }));
}

function itemComponentSchemas(): Record<string, any> {
  return (itemPrototypeComponentsSchema as any).properties ?? {};
}

function componentSchema(component: string): any {
  return itemComponentSchemas()[component];
}

function componentFieldNames(component: string): string[] {
  const schema = objectLikeSchema(componentSchema(component));
  return Object.keys(schema?.properties ?? {});
}

function schemaAtPath(component: string, path: string[]): any {
  let schema = objectLikeSchema(componentSchema(component));
  for (const segment of path) {
    if (!schema) return undefined;
    schema = objectLikeSchema(schema).properties?.[segment] ?? schema.properties?.[segment];
    if (schema?.oneOf || schema?.items) schema = objectLikeSchema(schema);
  }
  return schema;
}

function objectLikeSchema(schema: any): any {
  if (!schema) return undefined;
  if (schema.properties) return schema;
  if (Array.isArray(schema.oneOf)) {
    for (const option of schema.oneOf) {
      if (option?.properties) return option;
      if (option?.items?.properties) return option.items;
    }
  }
  if (schema.items?.properties) return schema.items;
  return schema;
}

function filterEntries(entries: Map<string, string>, current: string): Array<[string, string]> {
  return [...entries.entries()].filter(([label, description]) => matchesCandidate(label, current) || matchesCandidate(description, current));
}

function matchesCandidate(value: string, current: string): boolean {
  const needle = current.trim().toLowerCase();
  if (!needle) return true;
  return value.toLowerCase().includes(needle);
}

function readToken(text: string, index: number): TokenRange | undefined {
  const start = skipWhitespace(text, index);
  if (start >= text.length) return undefined;
  let end = start;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  return { text: text.slice(start, end), start, end };
}

function skipWhitespace(text: string, index: number): number {
  let cursor = Math.max(0, index);
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function leadingWhitespaceLength(text: string): number {
  const match = text.match(/^\s*/);
  return match?.[0].length ?? 0;
}

function splitTopLevel(text: string, separator: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaping) escaping = false;
      else if (char === "\\") escaping = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{" || char === "(") depth += 1;
    else if (char === "]" || char === "}" || char === ")") depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      result.push(text.slice(start, index));
      start = index + 1;
    }
  }
  result.push(text.slice(start));
  return result;
}

function findTopLevelChar(text: string, target: string): number {
  let depth = 0;
  let quote: string | undefined;
  let escaping = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaping) escaping = false;
      else if (char === "\\") escaping = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{" || char === "(") depth += 1;
    else if (char === "]" || char === "}" || char === ")") depth = Math.max(0, depth - 1);
    else if (char === target && depth === 0) return index;
  }
  return -1;
}

function currentTopLevelSegment(text: string, separator: string): { text: string; start: number } {
  let depth = 0;
  let quote: string | undefined;
  let escaping = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaping) escaping = false;
      else if (char === "\\") escaping = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{" || char === "(") depth += 1;
    else if (char === "]" || char === "}" || char === ")") depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) start = index + 1;
  }
  return { text: text.slice(start), start };
}

function findMatchingSquareBracket(text: string, openIndex: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escaping = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaping) escaping = false;
      else if (char === "\\") escaping = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseLoosePath(text: string): string[] {
  return text.split(".").map((part) => part.trim()).filter(Boolean);
}

function normalizePrototypeIdOrThrow(value: string): string {
  const normalized = normalizePrototypeId(value);
  if (!normalized) throw new Error("缺少 item prototype id");
  return normalized;
}

function normalizePrototypeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}
