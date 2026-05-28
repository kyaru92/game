import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import {
  findNodeAtLocation,
  getNodeValue,
  Node as JsonNode,
  parseTree,
} from "jsonc-parser";
import { ATTRIBUTE_IDS } from "./schema";

export interface CrossIndex {
  effectIds: string[];
  itemIds: string[];
  attributeIds: string[];
  entityIds: string[];
}

export interface CrossValidationResult {
  index: CrossIndex;
  markers: Map<string, monaco.editor.IMarkerData[]>;
}

interface ParsedModel {
  root?: JsonNode;
  text: string;
  model: monaco.editor.ITextModel;
}

const runtimeSelectors = new Set(["@player", "@me", "@self", "@who", "@dummy"]);

export function validateCrossReferences(
  effectModel: monaco.editor.ITextModel,
  itemModel: monaco.editor.ITextModel,
  entityModel?: monaco.editor.ITextModel,
): CrossValidationResult {
  const effects = parseModel(effectModel);
  const items = parseModel(itemModel);
  const entities = entityModel ? parseModel(entityModel) : undefined;
  const effectMarkers: monaco.editor.IMarkerData[] = [];
  const itemMarkers: monaco.editor.IMarkerData[] = [];
  const entityMarkers: monaco.editor.IMarkerData[] = [];

  const effectIds = collectRootKeys(effects.root).sort();
  const itemIds = collectRootKeys(items.root).sort();
  const entityIds = collectRootKeys(entities?.root).sort();
  const effectIdSet = new Set(effectIds);
  const entityIdSet = new Set(entityIds);

  validateEffects(effects, effectMarkers);
  validateItems(items, itemMarkers, effectIdSet, entityIdSet, effects.root);
  if (entities) validateEntities(entities, entityMarkers);

  const markers = new Map([
    [effectModel.uri.toString(), effectMarkers],
    [itemModel.uri.toString(), itemMarkers],
  ]);
  if (entityModel) markers.set(entityModel.uri.toString(), entityMarkers);

  return {
    index: {
      effectIds,
      itemIds,
      entityIds,
      attributeIds: [...ATTRIBUTE_IDS],
    },
    markers,
  };
}

export function collectEffectIds(effectModel: monaco.editor.ITextModel): string[] {
  return collectRootKeys(parseTree(effectModel.getValue())).sort();
}

function parseModel(model: monaco.editor.ITextModel): ParsedModel {
  const text = model.getValue();
  return {
    text,
    model,
    root: parseTree(text, undefined, {
      allowTrailingComma: true,
      disallowComments: false,
    }),
  };
}

function validateEffects(parsed: ParsedModel, markers: monaco.editor.IMarkerData[]): void {
  const root = parsed.root;
  if (!root || root.type !== "object") return;

  for (const prop of properties(root)) {
    const key = propKey(prop);
    const value = propValue(prop);
    if (!key || !value || value.type !== "object") continue;

    const idNode = findNodeAtLocation(value, ["id"]);
    const declaredId = idNode ? getNodeValue(idNode) : undefined;
    if (typeof declaredId === "string" && declaredId !== key) {
      markers.push(
        marker(parsed.model, idNode, `effect key 是 "${key}"，但内部 id 是 "${declaredId}"。两者必须一致。`),
      );
    }

    const stacking = findNodeAtLocation(value, ["stacking"]);
    if (stacking?.type === "object") {
      const behaviorNode = findNodeAtLocation(stacking, ["overlapBehavior"]);
      const maxStacksNode = findNodeAtLocation(stacking, ["maxStacks"]);
      const onMaxNode = findNodeAtLocation(stacking, ["onMax"]);
      const onOverlapNode = findNodeAtLocation(stacking, ["onOverlap"]);
      const behavior = behaviorNode ? getNodeValue(behaviorNode) : undefined;
      const maxStacks = maxStacksNode ? getNodeValue(maxStacksNode) : undefined;
      const onMax = onMaxNode ? getNodeValue(onMaxNode) : undefined;
      const onOverlap = onOverlapNode ? getNodeValue(onOverlapNode) : undefined;

      if (behavior === "none" && typeof maxStacks === "number" && maxStacks !== 1) {
        markers.push(
          marker(
            parsed.model,
            maxStacksNode,
            `overlapBehavior="none" 表示不叠层，maxStacks 建议固定为 1；当前为 ${maxStacks}。`,
            monaco.MarkerSeverity.Warning,
          ),
        );
      }
      if (behavior !== "independent" && onMax === "replace_oldest") {
        markers.push(
          marker(
            parsed.model,
            onMaxNode,
            `onMax="replace_oldest" 只对 overlapBehavior="independent" 有意义。`,
            monaco.MarkerSeverity.Warning,
          ),
        );
      }
      if (behavior !== "none" && onOverlap !== undefined) {
        markers.push(
          marker(
            parsed.model,
            onOverlapNode,
            `onOverlap 只在 overlapBehavior="none" 时生效。`,
            monaco.MarkerSeverity.Warning,
          ),
        );
      }
    }
  }
}

function validateItems(
  parsed: ParsedModel,
  markers: monaco.editor.IMarkerData[],
  effectIdSet: Set<string>,
  entityIdSet: Set<string>,
  effectRoot?: JsonNode,
): void {
  const root = parsed.root;
  if (!root || root.type !== "object") return;

  for (const prop of properties(root)) {
    const itemId = propKey(prop) ?? "<unknown>";
    const item = propValue(prop);
    if (!item || item.type !== "object") continue;

    const components = findNodeAtLocation(item, ["components"]);
    if (!components || components.type !== "object") continue;

    const activation = findNodeAtLocation(components, ["activation"]);
    const effectApplier = findNodeAtLocation(components, ["effect_applier"]);
    const damageApplier = findNodeAtLocation(components, ["damage_applier"]);
    const targeting = findNodeAtLocation(components, ["targeting"]);
    const teleporter = findNodeAtLocation(components, ["teleporter"]);
    const entitySpawner = findNodeAtLocation(components, ["entity_spawner"]);
    const targetingModeNode = targeting ? findNodeAtLocation(targeting, ["mode"]) : undefined;
    const targetingMode = targetingModeNode ? getNodeValue(targetingModeNode) : "self";

    if (activation && !effectApplier && !damageApplier && !teleporter && !entitySpawner) {
      markers.push(
        marker(
          parsed.model,
          activation,
          `"${itemId}" 有 activation，但目前没有任何已知激活监听组件（effect_applier/damage_applier/teleporter/entity_spawner）。`,
          monaco.MarkerSeverity.Warning,
        ),
      );
    }

    if (!activation && targeting) {
      markers.push(
        marker(
          parsed.model,
          targeting,
          `"${itemId}" 有 targeting 但没有 activation；该目标配置不会被 use 指令使用。`,
          monaco.MarkerSeverity.Hint,
        ),
      );
    }

    for (const applier of normalizeApplierNodes(effectApplier)) {
      const kindNode = findNodeAtLocation(applier, ["kind"]);
      const kind = kindNode ? getNodeValue(kindNode) : undefined;
      if (typeof kind === "string" && !effectIdSet.has(kind)) {
        markers.push(
          marker(parsed.model, kindNode, `effect_applier.kind 引用了不存在的 effect："${kind}"。`),
        );
      }

      const targetNode = findNodeAtLocation(applier, ["target"]);
      const target = targetNode ? getNodeValue(targetNode) : "activation_target";
      if (typeof target === "string" && target.startsWith("@") && !runtimeSelectors.has(target)) {
        markers.push(
          marker(
            parsed.model,
            targetNode,
            `未知运行时选择器 "${target}"。MVP 当前支持：${[...runtimeSelectors].join(", ")}。`,
            monaco.MarkerSeverity.Warning,
          ),
        );
      }
      if (target === "activation_target" && targetingMode === "position") {
        markers.push(
          marker(
            parsed.model,
            targetNode ?? applier,
            `effect_applier 需要实体目标，但 "${itemId}" 的 targeting.mode 是 "position"。请改为 entity/self，或让 effect_applier.target 指向 self/@dummy。`,
          ),
        );
      }

      if (typeof kind === "string" && effectIdSet.has(kind) && effectRoot) {
        const effectDuration = findNodeAtLocation(effectRoot, [kind, "durationMs"]);
        const overrideDuration = findNodeAtLocation(applier, ["overrides", "durationMs"]);
        if (effectDuration && overrideDuration) {
          const durationValue = getNodeValue(effectDuration);
          const overrideValue = getNodeValue(overrideDuration);
          if (typeof durationValue === "number" && durationValue < 0 && typeof overrideValue === "number" && overrideValue >= 0) {
            markers.push(
              marker(
                parsed.model,
                overrideDuration,
                `"${kind}" 默认是永久效果，但该 applier 用 overrides.durationMs 把它改成了限时效果。`,
                monaco.MarkerSeverity.Hint,
              ),
            );
          }
        }
      }
    }

    if (entitySpawner) {
      if (targetingMode !== "position") {
        markers.push(
          marker(parsed.model, entitySpawner, `entity_spawner 需要 targeting.mode="position"，当前为 "${targetingMode}"。`),
        );
      }
      const prototypeNode = findNodeAtLocation(entitySpawner, ["prototype"]);
      const prototype = prototypeNode ? getNodeValue(prototypeNode) : undefined;
      if (typeof prototype === "string" && entityIdSet.size > 0 && !entityIdSet.has(prototype)) {
        markers.push(marker(parsed.model, prototypeNode, `entity_spawner.prototype 引用了不存在的 entity prototype："${prototype}"。`));
      }
    }

    if (teleporter) {
      if (targetingMode !== "position") {
        markers.push(
          marker(parsed.model, teleporter, `teleporter 需要 targeting.mode="position"，当前为 "${targetingMode}"。`),
        );
      }
      const targetNode = findNodeAtLocation(teleporter, ["target"]);
      if (targetNode && getNodeValue(targetNode) !== "activation_target") {
        markers.push(marker(parsed.model, targetNode, `teleporter.target 目前只支持 "activation_target"。`));
      }
    }
  }
}

function validateEntities(parsed: ParsedModel, markers: monaco.editor.IMarkerData[]): void {
  const root = parsed.root;
  if (!root || root.type !== "object") return;
  const knownAttributes = new Set(ATTRIBUTE_IDS);

  for (const prop of properties(root)) {
    const entityId = propKey(prop) ?? "<unknown>";
    const entity = propValue(prop);
    if (!entity || entity.type !== "object") continue;
    const components = findNodeAtLocation(entity, ["components"]);
    if (!components || components.type !== "object") continue;

    for (const runtimeName of ["active_effects", "casting", "_deathLogged"]) {
      const runtimeComponent = findNodeAtLocation(components, [runtimeName]);
      if (runtimeComponent) {
        markers.push(
          marker(
            parsed.model,
            runtimeComponent,
            `${runtimeName} 是运行时状态，通常不建议写在 entity prototype "${entityId}" 中。`,
            monaco.MarkerSeverity.Hint,
          ),
        );
      }
    }

    const attributes = findNodeAtLocation(components, ["attributes"]);
    if (attributes?.type === "object") {
      for (const attrProp of properties(attributes)) {
        const attr = propKey(attrProp);
        if (attr && !knownAttributes.has(attr as any)) {
          markers.push(
            marker(
              parsed.model,
              attrProp.children?.[0],
              `未知属性 "${attr}"。MVP 当前已知属性：${ATTRIBUTE_IDS.join(", ")}。`,
              monaco.MarkerSeverity.Warning,
            ),
          );
        }
      }
    }
  }
}

function normalizeApplierNodes(effectApplier?: JsonNode): JsonNode[] {
  if (!effectApplier) return [];
  if (effectApplier.type === "object") return [effectApplier];
  if (effectApplier.type === "array") return effectApplier.children?.filter((node) => node.type === "object") ?? [];
  return [];
}

function collectRootKeys(root?: JsonNode): string[] {
  if (!root || root.type !== "object") return [];
  return properties(root)
    .map((prop) => propKey(prop))
    .filter((key): key is string => typeof key === "string");
}

function properties(node: JsonNode): JsonNode[] {
  return node.children?.filter((child) => child.type === "property") ?? [];
}

function propKey(prop: JsonNode): string | undefined {
  const keyNode = prop.children?.[0];
  const key = keyNode ? getNodeValue(keyNode) : undefined;
  return typeof key === "string" ? key : undefined;
}

function propValue(prop: JsonNode): JsonNode | undefined {
  return prop.children?.[1];
}

function marker(
  model: monaco.editor.ITextModel,
  node: JsonNode | undefined,
  message: string,
  severity: monaco.MarkerSeverity = monaco.MarkerSeverity.Error,
): monaco.editor.IMarkerData {
  if (!node) {
    return {
      severity,
      message,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 2,
      source: "cross-ref",
    };
  }

  const start = model.getPositionAt(node.offset);
  const end = model.getPositionAt(node.offset + Math.max(1, node.length));
  return {
    severity,
    message,
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
    source: "cross-ref",
  };
}
