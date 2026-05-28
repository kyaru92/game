import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent } from "react";
import effectText from "../effect.jsonc?raw";
import entityText from "../entity.jsonc?raw";
import itemText from "../item.jsonc?raw";
import {
  cooldownRemainingMs,
  createGameRuntime,
  describeTarget,
  executeCommand,
  displayItemName,
  effectColor,
  formatMs,
  getEffectSummaries,
  itemIcon,
  targetForItem,
  type EffectSummary,
  type Entity,
  type GameRuntime,
  type ItemInstance,
  type Target,
  type World,
} from "./gameEngine";

interface CanvasLayout {
  originX: number;
  originY: number;
  scale: number;
  width: number;
  height: number;
}

interface WorldPoint {
  x: number;
  y: number;
}

interface CommandSuggestion {
  label: string;
  insert: string;
  description: string;
}

const COMMAND_SUGGESTIONS: CommandSuggestion[] = [
  { label: "help", insert: "help", description: "显示所有指令和示例" },
  { label: "entities", insert: "entities", description: "列出当前世界里的实体" },
  { label: "spawn", insert: 'spawn hatched-monster slime_1 6 6 {"resources":{"hp":50,"max_hp":50}}', description: "按 entity prototype 生成实体，可附加 overrides" },
  { label: "component", insert: 'component slime ai {"state":"patrol","range":5}', description: "给实体写入/覆盖自定义 component" },
  { label: "item", insert: 'item @player debug-potion {"display":{"name":"调试药水"},"targeting":{"mode":"self"},"activation":{"max":3},"effect_applier":[{"kind":"regeneration","target":"self"}]}', description: "创建自定义 component 物品并放入背包" },
  { label: "give", insert: "give @player poison-cloud-grenade", description: "给予已有 item.jsonc 物品" },
  { label: "apply", insert: "apply poison @dummy", description: "直接对实体施加 effect" },
  { label: "damage", insert: "damage crate-1 15 impact", description: "造成指定类型伤害；木箱只接受 impact/fire" },
  { label: "heal", insert: "heal @player 100", description: "恢复生命" },
  { label: "remove", insert: "remove slime", description: "移除非玩家实体" },
];

export default function App() {
  const runtime = useMemo<GameRuntime>(() => createGameRuntime(effectText, itemText, entityText), []);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const logListRef = useRef<HTMLDivElement | null>(null);
  const movementKeysRef = useRef(new Set<string>());
  const shouldStickLogRef = useRef(true);
  const selectedTargetRef = useRef<Target>({ kind: "entity", entityId: "dummy" });
  const [selectedTarget, setSelectedTargetState] = useState<Target>(selectedTargetRef.current);
  const [commandLine, setCommandLine] = useState("");
  const [commandFocused, setCommandFocused] = useState(false);
  const [sideTab, setSideTab] = useState<"status" | "inventory" | "supply">("status");
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [, forceRender] = useState(0);

  const setSelectedTarget = useCallback((target: Target) => {
    selectedTargetRef.current = target;
    setSelectedTargetState(target);
  }, []);

  const refreshUi = useCallback(() => forceRender((value) => value + 1), []);

  const filteredSuggestions = useMemo(() => filterCommandSuggestions(commandLine), [commandLine]);
  const showSuggestions = commandFocused && filteredSuggestions.length > 0;

  const applyCommandSuggestion = useCallback((suggestion: CommandSuggestion) => {
    setCommandLine(suggestion.insert);
    setSuggestionIndex(0);
    requestAnimationFrame(() => {
      commandInputRef.current?.focus();
      commandInputRef.current?.setSelectionRange(suggestion.insert.length, suggestion.insert.length);
    });
  }, []);

  const handleCommandKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSuggestionIndex((value) => (value + 1) % filteredSuggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSuggestionIndex((value) => (value - 1 + filteredSuggestions.length) % filteredSuggestions.length);
    } else if (event.key === "Tab") {
      event.preventDefault();
      applyCommandSuggestion(filteredSuggestions[suggestionIndex] ?? filteredSuggestions[0]);
    } else if (event.key === "Escape") {
      setCommandFocused(false);
    }
  }, [applyCommandSuggestion, filteredSuggestions, showSuggestions, suggestionIndex]);

  const useInventoryItem = useCallback((index: number) => {
    const itemId = runtime.world.inventory("player")[index];
    if (!itemId) {
      runtime.world.log(`没有第 ${index + 1} 个物品。`);
      refreshUi();
      return;
    }
    const item = runtime.world.items[itemId];
    const target = targetForItem(runtime.world, item, selectedTargetRef.current);
    runtime.activationSystem.startUse("player", index, target);
    refreshUi();
  }, [refreshUi, runtime]);

  const cancelCasting = useCallback(() => {
    runtime.activationSystem.cancel("player");
    refreshUi();
  }, [refreshUi, runtime]);

  const giveItem = useCallback((protoId: string) => {
    runtime.world.give("player", protoId);
    refreshUi();
  }, [refreshUi, runtime]);

  const submitCommand = useCallback(() => {
    const line = commandLine.trim();
    if (!line) return;
    shouldStickLogRef.current = true;
    runtime.world.log(`> ${line}`);
    executeCommand(runtime, line);
    runtime.world.tick();
    setCommandLine("");
    refreshUi();
  }, [commandLine, refreshUi, runtime]);

  useEffect(() => {
    setSuggestionIndex(0);
  }, [commandLine]);

  useEffect(() => {
    const logList = logListRef.current;
    if (logList && shouldStickLogRef.current) logList.scrollTop = logList.scrollHeight;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let frame = 0;
    let lastUiAt = 0;
    let lastFrameAt = performance.now();
    const loop = (time: number) => {
      const deltaSeconds = Math.min(0.05, Math.max(0, (time - lastFrameAt) / 1000));
      lastFrameAt = time;
      updatePlayerFreeMovement(runtime, movementKeysRef.current, deltaSeconds);
      runtime.world.tick();
      resizeCanvas(canvas);
      drawWorld(context, runtime, selectedTargetRef.current);
      if (time - lastUiAt > 120) {
        lastUiAt = time;
        forceRender((value) => value + 1);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [runtime]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      const key = event.key.toLowerCase();

      if (key in MOVEMENT_VECTORS) {
        event.preventDefault();
        movementKeysRef.current.add(key);
        return;
      }

      if (/^[1-9]$/.test(key)) {
        event.preventDefault();
        useInventoryItem(Number(key) - 1);
        return;
      }

      if (key === "c" || key === "escape") {
        event.preventDefault();
        cancelCasting();
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      movementKeysRef.current.delete(event.key.toLowerCase());
    };

    const clearMovement = () => movementKeysRef.current.clear();

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearMovement);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearMovement);
    };
  }, [cancelCasting, useInventoryItem]);

  const handleCanvasClick = useCallback((event: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const point = eventToWorldPoint(canvas, event.clientX, event.clientY, runtime.world);
    if (!point) return;
    const entity = runtime.world.entityAt(point.x, point.y);
    const target: Target = entity ? { kind: "entity", entityId: entity.entityId } : { kind: "position", position: [point.x, point.y] };
    setSelectedTarget(target);
    runtime.world.log(`选择目标：${describeTarget(runtime.world, target)}`);
    refreshUi();
  }, [refreshUi, runtime, setSelectedTarget]);

  const world = runtime.world;
  const player = world.entities.player;
  const inventory = world.inventory("player").map((itemId) => world.items[itemId]).filter(Boolean);
  const entities = Object.values(world.entities).sort((a, b) => (a.entityId === "player" ? -1 : b.entityId === "player" ? 1 : a.entityId.localeCompare(b.entityId)));
  const visibleEntities = entities.slice(0, 4);
  const casting = player.components.casting;
  const castProgress = casting ? 1 - Math.max(0, casting.finishAtMs - world.nowMs()) / Math.max(1, casting.finishAtMs - casting.startedAtMs) : 0;

  return (
    <main className="game-shell">
      <header className="top-bar">
        <div>
          <h1>Canvas ECS MVP</h1>
          <p>TypeScript + Canvas 自由移动世界：操控、物品栏、Effect 表现与指令生成。</p>
        </div>
        <div className="control-hints">
          <kbd>WASD</kbd>/<kbd>方向键</kbd> 按住移动 · <kbd>点击场景</kbd> 选择目标 · <kbd>1-9</kbd> 使用物品 · <kbd>C</kbd> 取消施法
        </div>
      </header>

      <section className="game-layout">
        <div className="canvas-panel">
          <canvas ref={canvasRef} className="game-canvas" onClick={handleCanvasClick} />
          <div className="canvas-caption">
            <span>当前目标：<strong>{describeTarget(world, selectedTarget)}</strong></span>
            <span>世界坐标为连续数值；Effect 会以角色光环、头顶色块、倒计时条和浮动数字显示。</span>
          </div>
        </div>

        <aside className="side-panel">
          <section className="panel-card target-panel">
            <div className="row between">
              <h2>目标与施法</h2>
              <span className="target-inline">{describeTarget(world, selectedTarget)}</span>
            </div>
            {casting ? (
              <div className="casting-box compact-cast">
                <div className="row between"><span>正在使用</span><strong>{casting.itemName}</strong></div>
                <div className="progress"><i style={{ width: `${Math.round(castProgress * 100)}%` }} /></div>
                <button onClick={cancelCasting}>取消</button>
              </div>
            ) : <p className="muted compact">无施法</p>}
          </section>

          <nav className="side-tabs">
            <button className={sideTab === "status" ? "active" : ""} onClick={() => setSideTab("status")}>实体</button>
            <button className={sideTab === "inventory" ? "active" : ""} onClick={() => setSideTab("inventory")}>物品</button>
            <button className={sideTab === "supply" ? "active" : ""} onClick={() => setSideTab("supply")}>补给</button>
          </nav>

          <section className="panel-card side-tab-panel">
            {sideTab === "status" && (
              <div className="entity-panel">
                <div className="row between title-row">
                  <h2>实体状态</h2>
                  <span className="muted">{entities.length} 个实体</span>
                </div>
                <div className="entity-list">
                  {visibleEntities.map((entity) => <EntityStatus key={entity.entityId} entity={entity} runtime={runtime} />)}
                </div>
                {entities.length > visibleEntities.length && <p className="muted compact">另有 {entities.length - visibleEntities.length} 个实体，可用 entities 指令查看。</p>}
              </div>
            )}

            {sideTab === "inventory" && (
              <div className="inventory-card">
                <div className="row between title-row">
                  <h2>物品栏</h2>
                  <span className="muted">数字键对应槽位</span>
                </div>
                <div className="inventory-list">
                  {inventory.length ? inventory.map((item, index) => (
                    <InventoryRow
                      key={item.instanceId}
                      index={index}
                      item={item}
                      world={world}
                      onUse={() => useInventoryItem(index)}
                    />
                  )) : <p className="muted">背包为空，下面可以补给。</p>}
                </div>
                {inventory.length > 4 && <p className="muted compact">滚动物品栏查看更多；数字键仍对应真实槽位。</p>}
              </div>
            )}

            {sideTab === "supply" && (
              <div>
                <h2>补给测试物品</h2>
                <div className="supply-grid">
                  {Object.keys(world.itemPrototypes).map((protoId) => (
                    <button key={protoId} onClick={() => giveItem(protoId)}>{itemIcon(protoId)} {protoId}</button>
                  ))}
                </div>
              </div>
            )}
          </section>
        </aside>
      </section>

      <section className="command-log-panel">
        <form
          className="command-bar"
          onSubmit={(event) => {
            event.preventDefault();
            submitCommand();
          }}
        >
          <span>指令</span>
          <div className="command-input-wrap">
            <input
              ref={commandInputRef}
              value={commandLine}
              onFocus={() => setCommandFocused(true)}
              onBlur={() => window.setTimeout(() => setCommandFocused(false), 120)}
              onKeyDown={handleCommandKeyDown}
              onChange={(event) => setCommandLine(event.target.value)}
              placeholder='help / spawn hatched-monster slime_1 6 6 {"resources":{"hp":50,"max_hp":50}} / item @player debug {"display":{"name":"调试物品"}}'
            />
            {showSuggestions && (
              <div className="command-suggestions">
                {filteredSuggestions.map((suggestion, index) => (
                  <button
                    type="button"
                    key={suggestion.label}
                    className={index === suggestionIndex ? "active" : ""}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applyCommandSuggestion(suggestion);
                    }}
                  >
                    <strong>{suggestion.label}</strong>
                    <span>{suggestion.description}</span>
                    <code>{suggestion.insert}</code>
                  </button>
                ))}
                <small>↑/↓ 选择，Tab 补全，Enter 执行</small>
              </div>
            )}
          </div>
          <button type="submit">执行</button>
        </form>
        <div
          ref={logListRef}
          className="log-list"
          onScroll={(event) => {
            const node = event.currentTarget;
            shouldStickLogRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 10;
          }}
        >
          {world.messages.slice(-40).map((message, index) => <LogEntry key={`${index}-${message}`} message={message} />)}
        </div>
      </section>
    </main>
  );
}

function filterCommandSuggestions(input: string): CommandSuggestion[] {
  const text = input.trim().toLowerCase();
  if (!text) return COMMAND_SUGGESTIONS.slice(0, 6);
  return COMMAND_SUGGESTIONS
    .filter((suggestion) => {
      const haystack = `${suggestion.label} ${suggestion.insert} ${suggestion.description}`.toLowerCase();
      return haystack.includes(text) || suggestion.label.startsWith(text.split(/\s+/)[0] ?? "");
    })
    .slice(0, 6);
}

function LogEntry({ message }: { message: string }) {
  const multiline = message.includes("\n");
  return (
    <article className={multiline ? "log-entry multiline" : "log-entry"}>
      {multiline ? <pre>{message}</pre> : <span>{message}</span>}
    </article>
  );
}

function EntityStatus({ entity, runtime }: { entity: Entity; runtime: GameRuntime }) {
  const resources = entity.components.resources ?? {};
  const baseAttrs = entity.components.attributes ?? {};
  const finalAttrs = runtime.attributeSystem.finalAttributes(entity);
  const effects = getEffectSummaries(runtime.world, entity);
  const visibleEffects = effects.slice(0, 2);
  const hasHp = typeof resources.hp === "number";
  const hp = Number(resources.hp ?? 0);
  const maxHp = Number(resources.max_hp ?? (hp || 1));
  const hpPct = hasHp ? Math.max(0, Math.min(100, (hp / maxHp) * 100)) : 0;
  const position = entity.components.position ?? { x: 0, y: 0 };

  return (
    <article className="entity-card">
      <div className="row between">
        <strong>{entity.name}</strong>
        <span className="muted">({formatNumber(position.x)}, {formatNumber(position.y)})</span>
      </div>
      {hasHp ? <div className="hp-bar"><i style={{ width: `${hpPct}%` }} /><span>{hp}/{maxHp}</span></div> : <p className="muted compact">{entity.components.damageable?.destructible === false ? "固定障碍 / 不可损毁" : "无生命资源"}</p>}
      <div className="attrs">
        {Object.keys(finalAttrs).sort().map((key) => {
          const base = Number(baseAttrs[key] ?? 0);
          const final = Number(finalAttrs[key] ?? 0);
          const changed = Math.abs(final - base) > 0.0001;
          return (
            <span key={key} className={changed ? "attr changed" : "attr"}>
              {key}: {formatNumber(final)}{changed ? ` (${formatSigned(final - base)})` : ""}
            </span>
          );
        })}
      </div>
      <EffectList effects={visibleEffects} />
      {effects.length > visibleEffects.length && <p className="muted compact">+{effects.length - visibleEffects.length} effects</p>}
    </article>
  );
}

function EffectList({ effects }: { effects: EffectSummary[] }) {
  if (!effects.length) return <p className="muted compact">无 active effects</p>;
  return (
    <div className="effect-list">
      {effects.map((effect) => (
        <div key={effect.id} className="effect-row" style={{ borderColor: effect.color }}>
          <div className="row between">
            <strong style={{ color: effect.color }}>{effect.name} ×{effect.stacks}</strong>
            <span>{effect.remainingText}</span>
          </div>
          <div className="progress"><i style={{ width: `${Math.round(effect.progress * 100)}%`, background: effect.color }} /></div>
          <small>{describeEffectMechanics(effect)}</small>
        </div>
      ))}
    </div>
  );
}

function InventoryRow({ index, item, world, onUse }: { index: number; item: ItemInstance; world: World; onUse: () => void }) {
  const activation = item.components.activation;
  const cooldown = cooldownRemainingMs(item, world);
  const charges = activation ? `${activation.charges}/${activation.maxCharges}` : "-";
  const disabled = !activation || cooldown > 0 || Number(activation.charges ?? 0) <= 0;
  const targetMode = item.components.targeting?.mode ?? "self";
  return (
    <article className="inventory-row">
      <div className="slot-index">{index + 1}</div>
      <div className="item-icon">{itemIcon(item.protoId)}</div>
      <div className="item-main">
        <div className="row between"><strong>{displayItemName(item)}</strong><span className="muted">{targetMode}</span></div>
        <p>{interpolateItemText(item.components.display?.description ?? item.protoId, item)}</p>
        <div className="item-meta">
          <span>次数 {charges}</span>
          <span>CD {cooldown > 0 ? formatMs(cooldown) : "就绪"}</span>
          <span>施法 {formatMs(Number(activation?.castDurationMs ?? 0))}</span>
        </div>
      </div>
      <button disabled={disabled} onClick={onUse}>使用</button>
    </article>
  );
}

function interpolateItemText(text: string, item: ItemInstance): string {
  const vars: Record<string, string | number> = {
    modifyAttr: item.components.modifyAttr ?? item.components.effect_applier?.[0]?.modifyAttr ?? "hp",
    modifyValueRate: item.components.modifyValueRate ?? item.components.effect_applier?.[0]?.modifyValueRate ?? inferPeriodicValue(item),
  };

  return text.replace(/\{\$attribute\[([^\]]+)\]\.name\}/g, (_match, rawKey: string) => {
    const key = rawKey.startsWith("$") ? String(vars[rawKey.slice(1)] ?? rawKey) : rawKey;
    return ATTRIBUTE_NAMES[key] ?? key;
  }).replace(/\{\$([A-Za-z0-9_]+)\}/g, (_match, key: string) => String(vars[key] ?? ""));
}

function inferPeriodicValue(item: ItemInstance): number | string {
  const applier = Array.isArray(item.components.effect_applier) ? item.components.effect_applier[0] : item.components.effect_applier;
  const kind = applier?.kind;
  if (kind === "adrenaline") return 2;
  if (kind === "regeneration") return 5;
  if (kind === "poison") return -4;
  return "?";
}

const ATTRIBUTE_NAMES: Record<string, string> = {
  hp: "生命值",
  max_hp: "最大生命值",
  move_speed: "移动速度",
  attack_speed: "攻击速度",
};

const MOVEMENT_VECTORS: Record<string, WorldPoint> = {
  arrowup: { x: 0, y: -1 },
  w: { x: 0, y: -1 },
  arrowdown: { x: 0, y: 1 },
  s: { x: 0, y: 1 },
  arrowleft: { x: -1, y: 0 },
  a: { x: -1, y: 0 },
  arrowright: { x: 1, y: 0 },
  d: { x: 1, y: 0 },
};

function updatePlayerFreeMovement(runtime: GameRuntime, pressedKeys: Set<string>, deltaSeconds: number): void {
  if (deltaSeconds <= 0) return;
  let x = 0;
  let y = 0;
  for (const key of pressedKeys) {
    const vector = MOVEMENT_VECTORS[key];
    if (!vector) continue;
    x += vector.x;
    y += vector.y;
  }
  const length = Math.hypot(x, y);
  if (length <= 0) return;

  const player = runtime.world.entities.player;
  if (!player) return;
  const attrs = runtime.attributeSystem.finalAttributes(player);
  const unitsPerSecond = Math.max(0, Number(attrs.move_speed ?? 100)) / 25;
  if (unitsPerSecond <= 0) return;

  runtime.world.tryMove(
    "player",
    (x / length) * unitsPerSecond * deltaSeconds,
    (y / length) * unitsPerSecond * deltaSeconds,
    { logFailure: false },
  );
}

function describeEffectMechanics(effect: EffectSummary): string {
  const parts: string[] = [];
  for (const modifier of effect.modifiers) {
    const op = modifier.op === "mul" ? "×" : modifier.op === "override" ? "=" : "+";
    parts.push(`${modifier.attribute} ${op}${modifier.value} (${modifier.stackType ?? "none"})`);
  }
  if (effect.periodicEffect) {
    const p = effect.periodicEffect;
    parts.push(`每 ${formatMs(Number(p.intervalMs ?? 1000))} ${p.attribute} ${Number(p.value) >= 0 ? "+" : ""}${p.value}`);
  }
  parts.push(`叠层: ${effect.behavior}`);
  return parts.join(" · ");
}

function resizeCanvas(canvas: HTMLCanvasElement): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function getLayout(canvas: HTMLCanvasElement, world: World): CanvasLayout {
  const rect = canvas.getBoundingClientRect();
  const padding = 22;
  const availableWidth = Math.max(1, rect.width - padding * 2);
  const availableHeight = Math.max(1, rect.height - padding * 2);
  const scale = Math.min(availableWidth / world.width, availableHeight / world.height);
  const width = scale * world.width;
  const height = scale * world.height;
  return {
    originX: Math.floor((rect.width - width) / 2),
    originY: Math.floor((rect.height - height) / 2),
    scale,
    width,
    height,
  };
}

function eventToWorldPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number, world: World): WorldPoint | undefined {
  const rect = canvas.getBoundingClientRect();
  const layout = getLayout(canvas, world);
  const x = (clientX - rect.left - layout.originX) / layout.scale;
  const y = (clientY - rect.top - layout.originY) / layout.scale;
  if (!world.isInside(x, y)) return undefined;
  return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
}

function drawWorld(context: CanvasRenderingContext2D, runtime: GameRuntime, selectedTarget: Target): void {
  const canvas = context.canvas;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const world = runtime.world;
  const layout = getLayout(canvas, world);
  context.fillStyle = "#08111f";
  context.fillRect(0, 0, rect.width, rect.height);
  drawGround(context, layout);
  drawSelection(context, world, layout, selectedTarget);
  drawVisualEvents(context, world, layout);
  for (const entity of Object.values(world.entities)) drawEntity(context, runtime, entity, layout);
  drawLegend(context, rect.width, rect.height);
}

function drawGround(context: CanvasRenderingContext2D, layout: CanvasLayout): void {
  context.save();
  context.translate(layout.originX, layout.originY);
  const gradient = context.createLinearGradient(0, 0, layout.width, layout.height);
  gradient.addColorStop(0, "#0f1b2d");
  gradient.addColorStop(1, "#111827");
  context.fillStyle = gradient;
  context.fillRect(0, 0, layout.width, layout.height);

  context.strokeStyle = "rgba(96, 165, 250, 0.14)";
  context.lineWidth = 2;
  context.beginPath();
  context.ellipse(layout.width * 0.32, layout.height * 0.36, layout.width * 0.22, layout.height * 0.16, -0.25, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.ellipse(layout.width * 0.72, layout.height * 0.62, layout.width * 0.18, layout.height * 0.2, 0.35, 0, Math.PI * 2);
  context.stroke();

  context.strokeStyle = "#30445f";
  context.lineWidth = 2;
  context.strokeRect(0, 0, layout.width, layout.height);
  context.restore();
}

function drawSelection(context: CanvasRenderingContext2D, world: World, layout: CanvasLayout, selectedTarget: Target): void {
  context.save();
  context.strokeStyle = "#fbbf24";
  context.lineWidth = 3;

  if (selectedTarget.kind === "entity" && selectedTarget.entityId) {
    const entity = world.entities[selectedTarget.entityId];
    const position = entity?.components.position;
    if (!entity || !position) {
      context.restore();
      return;
    }
    if (isBoxCollider(entity)) {
      const bounds = world.entityBounds(entity);
      const topLeft = worldToCanvas(layout, bounds.left, bounds.top);
      const bottomRight = worldToCanvas(layout, bounds.right, bounds.bottom);
      context.strokeRect(topLeft.x - 5, topLeft.y - 5, bottomRight.x - topLeft.x + 10, bottomRight.y - topLeft.y + 10);
    } else {
      const center = worldToCanvas(layout, position.x, position.y);
      context.beginPath();
      context.arc(center.x, center.y, world.entityRadius(entity) * layout.scale + 8, 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();
    return;
  }

  if (selectedTarget.kind !== "position" || !selectedTarget.position) {
    context.restore();
    return;
  }
  const center = worldToCanvas(layout, selectedTarget.position[0], selectedTarget.position[1]);
  context.beginPath();
  context.arc(center.x, center.y, 10, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.moveTo(center.x - 14, center.y);
  context.lineTo(center.x + 14, center.y);
  context.moveTo(center.x, center.y - 14);
  context.lineTo(center.x, center.y + 14);
  context.stroke();
  context.restore();
}

function drawEntity(context: CanvasRenderingContext2D, runtime: GameRuntime, entity: Entity, layout: CanvasLayout): void {
  const world = runtime.world;
  const position = entity.components.position ?? { x: 0, y: 0 };
  const center = worldToCanvas(layout, position.x, position.y);
  const bounds = world.entityBounds(entity);
  const bodyWidth = Math.max(24, bounds.width * layout.scale);
  const bodyHeight = Math.max(24, bounds.height * layout.scale);
  const visualRadius = Math.max(bodyWidth, bodyHeight) / 2;
  const summaries = getEffectSummaries(world, entity);
  const now = world.nowMs();

  context.save();
  summaries.forEach((effect, index) => {
    const pulse = Math.sin(now / 220 + index) * 2;
    context.strokeStyle = effect.color;
    context.globalAlpha = 0.35;
    context.lineWidth = 4;
    context.beginPath();
    context.arc(center.x, center.y, visualRadius + 7 + index * 5 + pulse, 0, Math.PI * 2);
    context.stroke();
  });
  context.globalAlpha = 1;

  const display = entity.components.display ?? {};
  const isPlayer = entity.entityId === "player";
  context.fillStyle = display.color ?? (isPlayer ? "#38bdf8" : "#f87171");
  context.strokeStyle = display.strokeColor ?? (isPlayer ? "#bae6fd" : "#fecaca");
  context.lineWidth = 3;
  context.beginPath();
  if (isBoxCollider(entity)) {
    roundRect(context, center.x - bodyWidth / 2, center.y - bodyHeight / 2, bodyWidth, bodyHeight, 7);
  } else {
    context.arc(center.x, center.y, visualRadius, 0, Math.PI * 2);
  }
  context.fill();
  context.stroke();

  context.fillStyle = "#07111f";
  context.font = `700 ${Math.max(13, visualRadius * 0.85)}px Inter, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(display.glyph ?? (isPlayer ? "P" : "?")), center.x, center.y + 1);

  drawHealthBar(context, entity, center.x, center.y - visualRadius - 14, Math.max(44, bodyWidth));
  drawCastingRing(context, entity, center, visualRadius + 2);
  drawEffectChips(context, summaries, center.x, center.y + visualRadius + 10, Math.max(48, visualRadius * 3));

  context.fillStyle = "#cbd5e1";
  context.font = "12px Inter, sans-serif";
  context.textBaseline = "top";
  context.fillText(entity.name, center.x, center.y + visualRadius + 25);
  context.restore();
}

function drawHealthBar(context: CanvasRenderingContext2D, entity: Entity, x: number, y: number, width: number): void {
  const resources = entity.components.resources ?? {};
  if (typeof resources.hp !== "number") return;
  const hp = Number(resources.hp ?? 0);
  const maxHp = Number(resources.max_hp ?? (hp || 1));
  const pct = Math.max(0, Math.min(1, hp / maxHp));
  context.fillStyle = "rgba(15, 23, 42, 0.85)";
  roundRect(context, x - width / 2, y, width, 7, 3);
  context.fill();
  context.fillStyle = pct > 0.45 ? "#22c55e" : pct > 0.2 ? "#f59e0b" : "#ef4444";
  roundRect(context, x - width / 2, y, width * pct, 7, 3);
  context.fill();
}

function drawCastingRing(context: CanvasRenderingContext2D, entity: Entity, center: { x: number; y: number }, radius: number): void {
  const casting = entity.components.casting;
  if (!casting) return;
  const now = performance.now();
  const total = Math.max(1, casting.finishAtMs - casting.startedAtMs);
  const progress = 1 - Math.max(0, casting.finishAtMs - now) / total;
  context.strokeStyle = "#60a5fa";
  context.lineWidth = 4;
  context.beginPath();
  context.arc(center.x, center.y, radius + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  context.stroke();
}

function drawEffectChips(context: CanvasRenderingContext2D, effects: EffectSummary[], x: number, y: number, size: number): void {
  const chipWidth = Math.min(44, size * 0.85);
  const startX = x - (effects.length * (chipWidth + 4) - 4) / 2;
  effects.slice(0, 5).forEach((effect, index) => {
    const px = startX + index * (chipWidth + 4);
    context.fillStyle = "rgba(15, 23, 42, 0.88)";
    roundRect(context, px, y, chipWidth, 13, 4);
    context.fill();
    context.fillStyle = effect.color;
    roundRect(context, px, y, chipWidth * effect.progress, 13, 4);
    context.fill();
    context.fillStyle = "#020617";
    context.font = "10px Inter, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(`${effect.name.slice(0, 1)}${effect.stacks > 1 ? effect.stacks : ""}`, px + chipWidth / 2, y + 6.5);
  });
}

function drawVisualEvents(context: CanvasRenderingContext2D, world: World, layout: CanvasLayout): void {
  const now = world.nowMs();
  for (const event of world.visualEvents) {
    const age = now - event.createdAtMs;
    const t = Math.max(0, Math.min(1, age / event.durationMs));
    const center = worldToCanvas(layout, event.x, event.y);
    context.save();
    context.globalAlpha = 1 - t;
    if (event.kind === "text") {
      context.fillStyle = event.color;
      context.font = "700 16px Inter, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(event.text ?? "", center.x, center.y - 12 - t * 30);
    } else {
      context.strokeStyle = event.color;
      context.lineWidth = 4 * (1 - t) + 1;
      context.beginPath();
      context.arc(center.x, center.y, 8 + t * layout.scale * 0.55, 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();
  }
}

function drawLegend(context: CanvasRenderingContext2D, width: number, height: number): void {
  const entries = [
    ["adrenaline", "肾上腺素: 攻速/移速 + 回血"],
    ["regeneration", "再生: 周期回血"],
    ["poison", "中毒: 减速 + 扣血"],
    ["focus", "专注: 攻速提升"],
  ] as const;
  context.save();
  context.fillStyle = "rgba(2, 6, 23, 0.72)";
  roundRect(context, 16, height - 92, Math.min(520, width - 32), 76, 10);
  context.fill();
  context.font = "12px Inter, sans-serif";
  context.textAlign = "left";
  context.textBaseline = "middle";
  entries.forEach(([id, label], index) => {
    const x = 30 + (index % 2) * 250;
    const y = height - 70 + Math.floor(index / 2) * 28;
    context.fillStyle = effectColor(id);
    context.beginPath();
    context.arc(x, y, 6, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#cbd5e1";
    context.fillText(label, x + 12, y);
  });
  context.restore();
}

function isBoxCollider(entity: Entity): boolean {
  const collision = entity.components.collision ?? {};
  return collision.shape === "box" || typeof collision.width === "number" || typeof collision.height === "number";
}

function worldToCanvas(layout: CanvasLayout, x: number, y: number): { x: number; y: number } {
  return {
    x: layout.originX + x * layout.scale,
    y: layout.originY + y * layout.scale,
  };
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatSigned(value: number): string {
  const prefix = value >= 0 ? "+" : "";
  return `${prefix}${formatNumber(value)}`;
}
