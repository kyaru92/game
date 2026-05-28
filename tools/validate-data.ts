import Ajv, { type ErrorObject } from "ajv";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse, type ParseError, printParseErrorCode } from "jsonc-parser";
import {
  ATTRIBUTE_IDS,
  createEffectDefinitionsSchema,
  createEntityDefinitionsSchema,
  createItemDefinitionsSchema,
} from "../src/domain/componentSchemas";
import type { EffectDefinitions, EntityDefinitions, ItemDefinitions } from "../src/domain/componentTypes";

interface ParsedJsonc<T> {
  value: T;
}

type Severity = "error" | "warning";

interface Diagnostic {
  severity: Severity;
  file: string;
  message: string;
  pointer?: string;
}

interface GameData {
  effects: EffectDefinitions;
  items: ItemDefinitions;
  entities: EntityDefinitions;
}

const DATA_FILES = {
  effects: path.join("data", "effect.jsonc"),
  items: path.join("data", "item.jsonc"),
  entities: path.join("data", "entity.jsonc"),
} as const;

const runtimeEntityComponents = new Set(["active_effects", "casting", "_deathLogged", "hotbar", "loadout", "projectile"]);
const runtimeItemActivationFields = new Set(["_cooldownUntilMs"]);
const runtimeFirearmFields = new Set(["loadedRounds", "_reloadFinishAtMs", "_reloadOwnerId"]);

async function main(): Promise<void> {
  const rootDir = process.cwd();
  const diagnostics: Diagnostic[] = [];

  const effects = await parseJsoncFile<EffectDefinitions>(path.join(rootDir, DATA_FILES.effects), diagnostics);
  const entities = await parseJsoncFile<EntityDefinitions>(path.join(rootDir, DATA_FILES.entities), diagnostics);
  const items = await parseJsoncFile<ItemDefinitions>(path.join(rootDir, DATA_FILES.items), diagnostics);

  if (!effects || !entities || !items) return finish(diagnostics);

  validateSchema(DATA_FILES.effects, effects.value, createEffectDefinitionsSchema(), diagnostics);
  validateSchema(DATA_FILES.entities, entities.value, createEntityDefinitionsSchema(), diagnostics);
  validateSchema(
    DATA_FILES.items,
    items.value,
    createItemDefinitionsSchema({
      effectIds: Object.keys(effects.value),
      entityIds: Object.keys(entities.value),
    }),
    diagnostics,
  );

  validateCrossReferences({ effects: effects.value, items: items.value, entities: entities.value }, diagnostics);

  printDiagnostics(diagnostics);
  const errorCount = diagnostics.filter((item) => item.severity === "error").length;
  const warningCount = diagnostics.filter((item) => item.severity === "warning").length;
  if (errorCount > 0) {
    console.error(`\n数据校验失败：${errorCount} error(s), ${warningCount} warning(s)。`);
    process.exit(1);
  }
  console.log(`数据校验通过：0 error(s), ${warningCount} warning(s)。`);
}

async function parseJsoncFile<T>(filePath: string, diagnostics: Diagnostic[]): Promise<ParsedJsonc<T> | undefined> {
  const text = await readFile(filePath, "utf8");
  const parseErrors: ParseError[] = [];
  const value = parse(text, parseErrors, { allowTrailingComma: true, disallowComments: false }) as T | undefined;
  const label = path.basename(filePath);

  for (const error of parseErrors) {
    diagnostics.push({
      severity: "error",
      file: label,
      message: `JSONC 解析失败：${printParseErrorCode(error.error)} @ offset ${error.offset}`,
    });
  }

  return {
    value: value ?? ({} as T),
  };
}

function validateSchema(file: string, value: unknown, schema: object, diagnostics: Diagnostic[]): void {
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  const validate = ajv.compile(schema);
  if (validate(value)) return;
  for (const error of validate.errors ?? []) diagnostics.push(schemaDiagnostic(file, error));
}

function schemaDiagnostic(file: string, error: ErrorObject): Diagnostic {
  const pointer = error.instancePath || "/";
  const detail = error.message ?? "不符合 schema";
  const pathText = pointer === "/" ? "根对象" : pointer;
  return {
    severity: "error",
    file,
    pointer,
    message: `${pathText} ${detail}`,
  };
}

function validateCrossReferences(data: GameData, diagnostics: Diagnostic[]): void {
  const effectIds = new Set(Object.keys(data.effects));
  const itemIds = new Set(Object.keys(data.items));
  const entityIds = new Set(Object.keys(data.entities));
  const attributeIds = new Set<string>(ATTRIBUTE_IDS);

  for (const [effectId, effect] of Object.entries(data.effects)) {
    if (effect.id !== effectId) {
      diagnostics.push({
        severity: "error",
        file: DATA_FILES.effects,
        pointer: `/${effectId}/id`,
        message: `effect key 是 "${effectId}"，但内部 id 是 "${effect.id}"。两者必须一致。`,
      });
    }

    const stacking = effect.stacking;
    if (stacking.overlapBehavior === "none" && stacking.maxStacks !== 1) {
      diagnostics.push({
        severity: "warning",
        file: DATA_FILES.effects,
        pointer: `/${effectId}/stacking/maxStacks`,
        message: `overlapBehavior="none" 表示不叠层，maxStacks 建议固定为 1；当前为 ${stacking.maxStacks}。`,
      });
    }
    if (stacking.overlapBehavior !== "independent" && stacking.onMax === "replace_oldest") {
      diagnostics.push({
        severity: "warning",
        file: DATA_FILES.effects,
        pointer: `/${effectId}/stacking/onMax`,
        message: `onMax="replace_oldest" 只对 overlapBehavior="independent" 有意义。`,
      });
    }
    if (stacking.overlapBehavior !== "none" && stacking.onOverlap !== undefined) {
      diagnostics.push({
        severity: "warning",
        file: DATA_FILES.effects,
        pointer: `/${effectId}/stacking/onOverlap`,
        message: "onOverlap 只在 overlapBehavior=\"none\" 时生效。",
      });
    }
  }

  for (const [itemId, item] of Object.entries(data.items)) {
    const components = item.components;
    const activation = components.activation;
    const hasKnownActivationListener = Boolean(
      components.effect_applier
      || components.damage_applier
      || components.teleporter
      || components.entity_spawner
      || components.firearm
      || components.projectile_launcher,
    );

    if (activation && !hasKnownActivationListener) {
      diagnostics.push({
        severity: "warning",
        file: DATA_FILES.items,
        pointer: `/${itemId}/components/activation`,
        message: `"${itemId}" 有 activation，但目前没有任何已知激活监听组件。`,
      });
    }
    if (!activation && components.targeting) {
      diagnostics.push({
        severity: "warning",
        file: DATA_FILES.items,
        pointer: `/${itemId}/components/targeting`,
        message: `"${itemId}" 有 targeting 但没有 activation；该目标配置不会被 use 指令使用。`,
      });
    }

    for (const field of runtimeItemActivationFields) {
      if (activation && field in activation) {
        diagnostics.push({
          severity: "error",
          file: DATA_FILES.items,
          pointer: `/${itemId}/components/activation/${field}`,
          message: `${field} 是运行时字段，不应写在 item prototype 中。`,
        });
      }
    }
    for (const field of runtimeFirearmFields) {
      if (components.firearm && field in components.firearm) {
        diagnostics.push({
          severity: "error",
          file: DATA_FILES.items,
          pointer: `/${itemId}/components/firearm/${field}`,
          message: `${field} 是运行时字段，不应写在 item prototype 中。`,
        });
      }
    }

    const targetingMode = components.targeting?.mode ?? "self";
    for (const applier of normalizeAppliers(components.effect_applier)) {
      if (!effectIds.has(applier.kind)) {
        diagnostics.push({
          severity: "error",
          file: DATA_FILES.items,
          pointer: `/${itemId}/components/effect_applier/kind`,
          message: `effect_applier.kind 引用了不存在的 effect："${applier.kind}"。`,
        });
      }
      if (applier.target === "activation_target" && targetingMode === "position") {
        diagnostics.push({
          severity: "error",
          file: DATA_FILES.items,
          pointer: `/${itemId}/components/effect_applier/target`,
          message: `effect_applier 需要实体目标，但 "${itemId}" 的 targeting.mode 是 "position"。`,
        });
      }
      if (applier.target?.startsWith("@") && !["@player", "@me", "@who", "@dummy"].includes(applier.target)) {
        diagnostics.push({
          severity: "warning",
          file: DATA_FILES.items,
          pointer: `/${itemId}/components/effect_applier/target`,
          message: `未知运行时选择器 "${applier.target}"。`,
        });
      }
    }

    for (const applier of normalizeAppliers(components.ammo?.effect_applier)) {
      if (!effectIds.has(applier.kind)) {
        diagnostics.push({
          severity: "error",
          file: DATA_FILES.items,
          pointer: `/${itemId}/components/ammo/effect_applier/kind`,
          message: `ammo.effect_applier.kind 引用了不存在的 effect："${applier.kind}"。`,
        });
      }
    }

    for (const applier of normalizeAppliers(components.projectile_launcher?.effect_applier)) {
      if (!effectIds.has(applier.kind)) {
        diagnostics.push({
          severity: "error",
          file: DATA_FILES.items,
          pointer: `/${itemId}/components/projectile_launcher/effect_applier/kind`,
          message: `projectile_launcher.effect_applier.kind 引用了不存在的 effect："${applier.kind}"。`,
        });
      }
    }

    const spawner = components.entity_spawner;
    if (spawner) {
      if (targetingMode !== "position") {
        diagnostics.push({
          severity: "error",
          file: DATA_FILES.items,
          pointer: `/${itemId}/components/entity_spawner`,
          message: `entity_spawner 需要 targeting.mode="position"，当前为 "${targetingMode}"。`,
        });
      }
      if (!entityIds.has(spawner.prototype)) {
        diagnostics.push({
          severity: "error",
          file: DATA_FILES.items,
          pointer: `/${itemId}/components/entity_spawner/prototype`,
          message: `entity_spawner.prototype 引用了不存在的 entity prototype："${spawner.prototype}"。`,
        });
      }
    }

    if (components.teleporter && targetingMode !== "position") {
      diagnostics.push({
        severity: "error",
        file: DATA_FILES.items,
        pointer: `/${itemId}/components/teleporter`,
        message: `teleporter 需要 targeting.mode="position"，当前为 "${targetingMode}"。`,
      });
    }
  }

  for (const [entityId, entity] of Object.entries(data.entities)) {
    const components = entity.components;
    for (const runtimeName of runtimeEntityComponents) {
      if (runtimeName in components) {
        diagnostics.push({
          severity: "error",
          file: DATA_FILES.entities,
          pointer: `/${entityId}/components/${runtimeName}`,
          message: `${runtimeName} 是运行时状态，不应写在 entity prototype "${entityId}" 中。`,
        });
      }
    }
    const loot = components.loot;
    if (loot) {
      const containerPrototype = loot.containerPrototype ?? "loot-crate";
      if (!entityIds.has(containerPrototype)) {
        diagnostics.push({
          severity: "error",
          file: DATA_FILES.entities,
          pointer: `/${entityId}/components/loot/containerPrototype`,
          message: `loot.containerPrototype 引用了不存在的 entity prototype："${containerPrototype}"。`,
        });
      }
      for (const [index, entry] of (loot.entries ?? []).entries()) {
        if (!itemIds.has(entry.item)) {
          diagnostics.push({
            severity: "error",
            file: DATA_FILES.entities,
            pointer: `/${entityId}/components/loot/entries/${index}/item`,
            message: `loot.entries 引用了不存在的 item prototype："${entry.item}"。`,
          });
        }
        validateLootQuantity(entityId, `loot/entries/${index}`, entry.quantity, diagnostics);
      }
      for (const [index, entry] of (loot.guarantee?.pool ?? []).entries()) {
        if (!itemIds.has(entry.item)) {
          diagnostics.push({
            severity: "error",
            file: DATA_FILES.entities,
            pointer: `/${entityId}/components/loot/guarantee/pool/${index}/item`,
            message: `loot.guarantee.pool 引用了不存在的 item prototype："${entry.item}"。`,
          });
        }
        validateLootQuantity(entityId, `loot/guarantee/pool/${index}`, entry.quantity, diagnostics);
      }
      if ((loot.entries?.length ?? 0) === 0 && (loot.guarantee?.pool?.length ?? 0) === 0) {
        diagnostics.push({
          severity: "warning",
          file: DATA_FILES.entities,
          pointer: `/${entityId}/components/loot`,
          message: "loot 没有 entries 或 guarantee.pool，死亡后不会生成有内容的箱子。",
        });
      }
    }

    for (const attr of Object.keys(components.attributes ?? {})) {
      if (!attributeIds.has(attr)) {
        diagnostics.push({
          severity: "warning",
          file: DATA_FILES.entities,
          pointer: `/${entityId}/components/attributes/${attr}`,
          message: `未知属性 "${attr}"。当前已知属性：${ATTRIBUTE_IDS.join(", ")}。`,
        });
      }
    }
  }
}

function validateLootQuantity(entityId: string, pointer: string, quantity: { min?: number; max?: number } | undefined, diagnostics: Diagnostic[]): void {
  if (!quantity || quantity.min === undefined || quantity.max === undefined) return;
  if (Number(quantity.min) > Number(quantity.max)) {
    diagnostics.push({
      severity: "error",
      file: DATA_FILES.entities,
      pointer: `/${entityId}/components/${pointer}/quantity`,
      message: `quantity.min 不能大于 quantity.max；当前为 ${quantity.min} > ${quantity.max}。`,
    });
  }
}

function normalizeAppliers<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const label = diagnostic.severity === "error" ? "ERROR" : "WARN";
    const pointer = diagnostic.pointer ? ` ${diagnostic.pointer}` : "";
    const writer = diagnostic.severity === "error" ? console.error : console.warn;
    writer(`[${label}] ${diagnostic.file}${pointer}: ${diagnostic.message}`);
  }
}

function finish(diagnostics: Diagnostic[]): never {
  printDiagnostics(diagnostics);
  process.exit(diagnostics.some((item) => item.severity === "error") ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
