import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent } from "react";
import effectText from "../data/effect.jsonc?raw";
import entityText from "../data/entity.jsonc?raw";
import itemText from "../data/item.jsonc?raw";
import {
  cooldownRemainingMs,
  createGameRuntime,
  describeTarget,
  executeCommand,
  displayItemName,
  getCommandCompletions,
  effectColor,
  formatMs,
  getEffectSummaries,
  isEquipmentItem,
  itemCategory,
  itemIcon,
  targetForItem,
  PresentationState,
  PresentationDeriver,
  LoopbackTransport,
  ServerSession,
  ClientSession,
  type EffectSummary,
  type GameCommand,
  type LootContainerView,
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
  replaceFrom?: number;
  replaceTo?: number;
}

const COMMAND_HISTORY_LIMIT = 100;

function commandExecutionResult(messages: string[]): string {
  return messages.map((message) => message.trim()).filter(Boolean).join("\n") || "执行完成。";
}

function formatCommandExecutionLog(line: string, resultMessages: string[]): string {
  return `指令：${line}\n结果：${commandExecutionResult(resultMessages)}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function App() {
  // 网络栈（docs/networking.md §4.3）：同进程 loopback 跑通「预测 → 权威 → 快照 → 校正」。
  // - serverRuntime：唯一权威世界（跑全部 system）。
  // - clientRuntime：客户端预测世界（仅预测本地移动；每 tick 被服务端快照同步 = 权威视图）。
  // UI/渲染一律读 clientRuntime；调试 DSL / 补给直给作用到 serverRuntime。
  const net = useMemo(() => {
    const serverRuntime = createGameRuntime(effectText, itemText, entityText);
    const clientRuntime = createGameRuntime(effectText, itemText, entityText);
    const transport = new LoopbackTransport(0);
    const server = new ServerSession(serverRuntime, transport.server);
    const presentation = new PresentationState();
    const deriver = new PresentationDeriver(presentation);
    const client = new ClientSession(clientRuntime, transport.client, deriver);
    // 丢弃客户端启动日志：权威启动日志由服务端首帧快照的事件流带来，避免重复。
    clientRuntime.world.drainSimEvents();
    return { serverRuntime, clientRuntime, transport, server, client, presentation, deriver };
  }, []);
  const runtime: GameRuntime = net.clientRuntime;
  const serverRuntime: GameRuntime = net.serverRuntime;
  const presentation = net.presentation;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const commandHistoryRef = useRef<string[]>([]);
  const commandHistoryIndexRef = useRef<number | null>(null);
  const commandDraftRef = useRef("");
  const logListRef = useRef<HTMLDivElement | null>(null);
  const movementKeysRef = useRef(new Set<string>());
  const shouldStickLogRef = useRef(true);
  const selectedTargetRef = useRef<Target>({ kind: "none" });
  const cursorPositionRef = useRef<[number, number] | undefined>(undefined);
  const [selectedTarget, setSelectedTargetState] = useState<Target>(selectedTargetRef.current);
  const [commandLine, setCommandLine] = useState("");
  const [commandCursor, setCommandCursor] = useState(0);
  const [commandFocused, setCommandFocused] = useState(false);
  const [sideTab, setSideTab] = useState<"status" | "inventory" | "supply">("status");
  const [backpackOpen, setBackpackOpen] = useState(false);
  const [openLootContainerId, setOpenLootContainerId] = useState<string | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [, forceRender] = useState(0);

  const setSelectedTarget = useCallback((target: Target) => {
    selectedTargetRef.current = target;
    setSelectedTargetState(target);
  }, []);

  const refreshUi = useCallback(() => forceRender((value) => value + 1), []);

  const filteredSuggestions = useMemo(() => getCommandCompletions(runtime, commandLine, commandCursor), [commandCursor, commandLine, runtime]);
  const showSuggestions = commandFocused && filteredSuggestions.length > 0;

  const applyCommandSuggestion = useCallback((suggestion: CommandSuggestion) => {
    const replaceFrom = suggestion.replaceFrom ?? 0;
    const replaceTo = suggestion.replaceTo ?? commandLine.length;
    const next = `${commandLine.slice(0, replaceFrom)}${suggestion.insert}${commandLine.slice(replaceTo)}`;
    const cursor = replaceFrom + suggestion.insert.length;
    setCommandLine(next);
    setCommandCursor(cursor);
    setSuggestionIndex(0);
    requestAnimationFrame(() => {
      commandInputRef.current?.focus();
      commandInputRef.current?.setSelectionRange(cursor, cursor);
    });
  }, [commandLine]);

  const setCommandLineFromHistory = useCallback((line: string) => {
    setCommandLine(line);
    setCommandCursor(line.length);
    setSuggestionIndex(0);
    requestAnimationFrame(() => {
      commandInputRef.current?.focus();
      commandInputRef.current?.setSelectionRange(line.length, line.length);
    });
  }, []);

  const pushCommandHistory = useCallback((line: string) => {
    const history = commandHistoryRef.current;
    history.push(line);
    if (history.length > COMMAND_HISTORY_LIMIT) history.splice(0, history.length - COMMAND_HISTORY_LIMIT);
    commandHistoryIndexRef.current = null;
    commandDraftRef.current = "";
  }, []);

  const navigateCommandHistory = useCallback((direction: -1 | 1) => {
    const history = commandHistoryRef.current;
    if (!history.length) return false;

    const currentIndex = commandHistoryIndexRef.current;
    if (currentIndex === null) {
      if (direction > 0) return false;
      commandDraftRef.current = commandLine;
      commandHistoryIndexRef.current = history.length - 1;
      setCommandLineFromHistory(history[history.length - 1]);
      return true;
    }

    if (direction < 0) {
      const nextIndex = Math.max(0, currentIndex - 1);
      commandHistoryIndexRef.current = nextIndex;
      setCommandLineFromHistory(history[nextIndex]);
      return true;
    }

    const nextIndex = currentIndex + 1;
    if (nextIndex >= history.length) {
      commandHistoryIndexRef.current = null;
      setCommandLineFromHistory(commandDraftRef.current);
    } else {
      commandHistoryIndexRef.current = nextIndex;
      setCommandLineFromHistory(history[nextIndex]);
    }
    return true;
  }, [commandLine, setCommandLineFromHistory]);

  const handleCommandKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    const browsingHistory = commandLine.trim().length === 0;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (browsingHistory) {
        if (navigateCommandHistory(event.key === "ArrowUp" ? -1 : 1)) event.preventDefault();
        return;
      }
      if (showSuggestions) {
        event.preventDefault();
        setSuggestionIndex((value) => event.key === "ArrowDown"
          ? (value + 1) % filteredSuggestions.length
          : (value - 1 + filteredSuggestions.length) % filteredSuggestions.length);
      }
      return;
    }
    if (!showSuggestions) return;
    if (event.key === "Tab") {
      event.preventDefault();
      applyCommandSuggestion(filteredSuggestions[suggestionIndex] ?? filteredSuggestions[0]);
    } else if (event.key === "Escape") {
      setCommandFocused(false);
    }
  }, [applyCommandSuggestion, commandLine, filteredSuggestions, navigateCommandHistory, showSuggestions, suggestionIndex]);

  // 玩家本地命令的统一入口：经客户端会话「本地预测（仅 move）+ 上行发送」。
  // 其余命令仅上行，由服务端权威结算后随快照回灌。
  const dispatch = useCallback((command: GameCommand) => {
    net.client.send(command);
    refreshUi();
  }, [net, refreshUi]);

  const useItem = useCallback((itemId: string) => {
    const item = runtime.world.items[itemId];
    if (!item || !runtime.world.services.inventory.has("player", itemId)) {
      runtime.world.log(`物品不在背包中：${itemId}`);
      refreshUi();
      return;
    }
    const target = targetForItem(runtime.world, item, {
      actorId: "player",
      selectedTarget: selectedTargetRef.current,
      cursorPosition: cursorPositionRef.current,
      requireExplicitEntity: true,
    });
    dispatch({ kind: "useItem", itemId, target });
  }, [dispatch, refreshUi, runtime]);

  const equipItem = useCallback((itemId: string) => {
    const item = runtime.world.items[itemId];
    if (!item || !isEquipmentItem(item)) {
      runtime.world.log(item ? `${displayItemName(item)} 不是装备。` : `找不到装备：${itemId}`);
      refreshUi();
      return;
    }
    dispatch({ kind: "equipItem", itemId });
  }, [dispatch, refreshUi, runtime]);

  const activateHotbarSlot = useCallback((slotIndex: number) => {
    const itemId = runtime.world.services.inventory.hotbar("player")[slotIndex];
    if (!itemId) {
      runtime.world.log(`快捷栏 ${slotIndex + 1} 是空的。`);
      refreshUi();
      return;
    }
    const item = runtime.world.items[itemId];
    if (!item) {
      refreshUi();
      return;
    }
    if (isEquipmentItem(item)) equipItem(itemId);
    else useItem(itemId);
  }, [equipItem, refreshUi, runtime, useItem]);

  const assignHotbarSlot = useCallback((slotIndex: number, itemId: string) => {
    dispatch({ kind: "assignHotbarSlot", slot: slotIndex, itemId });
  }, [dispatch]);

  const reloadActiveEquipment = useCallback(() => {
    const itemId = runtime.world.services.inventory.activeItemId("player");
    if (!itemId) {
      runtime.world.log("当前没有装备。提示：按 1-7 切换装备。");
      refreshUi();
      return;
    }
    dispatch({ kind: "reloadItem", itemId });
  }, [dispatch, refreshUi, runtime]);

  const cancelCasting = useCallback(() => {
    dispatch({ kind: "cancelCast" });
  }, [dispatch]);

  const closeLootContainer = useCallback(() => {
    dispatch({ kind: "lootCancelSearch", containerId: openLootContainerId ?? undefined, reason: "中断搜索" });
    setOpenLootContainerId(null);
  }, [dispatch, openLootContainerId]);

  const openLootContainer = useCallback((containerId: string) => {
    setOpenLootContainerId(containerId);
    dispatch({ kind: "lootBeginSearch", containerId });
  }, [dispatch]);

  const interactLootContainer = useCallback(() => {
    const nearest = runtime.lootSystem.nearestContainer("player");
    if (!nearest) {
      runtime.world.log("附近没有可交互的掉落箱。");
      refreshUi();
      return;
    }
    openLootContainer(nearest.entityId);
  }, [openLootContainer, refreshUi, runtime]);

  const takeLootItem = useCallback((itemId: string) => {
    if (!openLootContainerId) return;
    dispatch({ kind: "lootTakeItem", containerId: openLootContainerId, itemId });
  }, [dispatch, openLootContainerId]);

  const organizeBackpack = useCallback(() => {
    dispatch({ kind: "organizeInventory" });
  }, [dispatch]);

  // 补给直给是管理通道：作用到权威（服务端）世界，结果随快照回灌客户端。
  const giveItem = useCallback((protoId: string) => {
    serverRuntime.world.give("player", protoId);
    refreshUi();
  }, [refreshUi, serverRuntime]);

  const submitCommand = useCallback(() => {
    const line = commandLine.trim();
    if (!line) return;
    pushCommandHistory(line);
    shouldStickLogRef.current = true;

    // 调试 DSL 是独立管理通道（docs/networking.md §3.4）：作用到权威（服务端）世界，
    // 结果经事件流/快照回灌客户端。
    const world = serverRuntime.world;
    const originalLog = world.log;
    const resultMessages: string[] = [];
    world.log = (message: string) => {
      resultMessages.push(message);
    };
    try {
      executeCommand(serverRuntime, line);
    } catch (error) {
      resultMessages.push(`指令执行失败：${formatError(error)}`);
    } finally {
      world.log = originalLog;
    }

    world.log(formatCommandExecutionLog(line, resultMessages));
    setCommandLine("");
    setCommandCursor(0);
    commandHistoryIndexRef.current = null;
    commandDraftRef.current = "";
    setSuggestionIndex(0);
    refreshUi();
  }, [commandLine, pushCommandHistory, refreshUi, serverRuntime]);

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
    const tickIntervalMs = runtime.world.tickIntervalMs;
    const maxCatchUpTicks = 5; // 防止掉帧后螺旋补帧
    let accumulatorMs = 0;
    const loop = (time: number) => {
      const frameMs = Math.min(250, Math.max(0, time - lastFrameAt));
      lastFrameAt = time;
      accumulatorMs += frameMs;

      let ticksThisFrame = 0;
      while (accumulatorMs >= tickIntervalMs && ticksThisFrame < maxCatchUpTicks) {
        // 本地移动：产出 move 命令经客户端会话（本地预测 + 上行）。
        if (!runtime.lootSystem.isActorSearching("player")) {
          const dir = movementDirFromKeys(movementKeysRef.current);
          if (dir.x !== 0 || dir.y !== 0) net.client.send({ kind: "move", dir });
        }
        // 服务端推进一个权威 tick：消费上行命令 → tick → 下发快照；
        // loopback 即时回灌客户端，在 onServerMessage 内 applySnapshot + 回滚重放 + 派生表现。
        net.server.step();
        net.transport.advance(net.serverRuntime.world.currentTick); // 驱动延迟队列（latency=0 时无副作用）
        accumulatorMs -= tickIntervalMs;
        ticksThisFrame += 1;
      }
      // 超出补帧上限时丢弃积欠，避免恢复后一次性快进。
      if (ticksThisFrame >= maxCatchUpTicks) accumulatorMs = 0;

      // 客户端本地（UI 校验等）产生的事件单独派生；服务端权威事件已在收快照时派生。
      net.deriver.consume(runtime.world.drainSimEvents(), runtime.world.nowMs());
      net.deriver.age(runtime.world.nowMs());

      resizeCanvas(canvas);
      // alpha：距下一 tick 的进度，供远端实体在最近两帧快照间平滑插值。
      const alpha = Math.max(0, Math.min(1, accumulatorMs / tickIntervalMs));
      drawWorld(context, runtime, selectedTargetRef.current, presentation, net.client, alpha);
      if (time - lastUiAt > 120) {
        lastUiAt = time;
        forceRender((value) => value + 1);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [net, runtime, presentation]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      const key = event.key.toLowerCase();

      const searchingLoot = runtime.lootSystem.isActorSearching("player");

      if ((key === "c" || key === "escape") && searchingLoot) {
        event.preventDefault();
        closeLootContainer();
        return;
      }

      if (key in MOVEMENT_VECTORS) {
        event.preventDefault();
        if (!searchingLoot) movementKeysRef.current.add(key);
        return;
      }

      if (key === "e") {
        event.preventDefault();
        if (!searchingLoot) interactLootContainer();
        return;
      }

      if (searchingLoot && key !== "escape" && key !== "c") {
        event.preventDefault();
        return;
      }

      if (/^[1-7]$/.test(key)) {
        event.preventDefault();
        activateHotbarSlot(Number(key) - 1);
        return;
      }

      if (key === "b") {
        event.preventDefault();
        setBackpackOpen((open) => {
          const next = !open;
          setSideTab(next ? "inventory" : "status");
          return next;
        });
        return;
      }

      if (key === "r") {
        event.preventDefault();
        reloadActiveEquipment();
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
  }, [activateHotbarSlot, cancelCasting, interactLootContainer, openLootContainerId, refreshUi, reloadActiveEquipment, runtime]);

  const handleCanvasMouseMove = useCallback((event: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const point = eventToWorldPoint(canvas, event.clientX, event.clientY, runtime.world);
    cursorPositionRef.current = point ? [point.x, point.y] : undefined;
  }, [runtime]);

  const handleCanvasClick = useCallback((event: MouseEvent<HTMLCanvasElement>) => {
    if (runtime.lootSystem.isActorSearching("player")) {
      runtime.world.log("正在搜索，无法操作。按 Esc 可中断搜索。");
      refreshUi();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const point = eventToWorldPoint(canvas, event.clientX, event.clientY, runtime.world);
    if (!point) return;
    cursorPositionRef.current = [point.x, point.y];
    const entity = runtime.world.services.spatial.entityAt(point.x, point.y);
    if (entity?.components.loot_container && runtime.lootSystem.canInteract("player", entity.entityId)) {
      openLootContainer(entity.entityId);
      return;
    }
    const activeItemId = runtime.world.services.inventory.activeItemId("player");
    const activeItem = activeItemId ? runtime.world.items[activeItemId] : undefined;

    if (activeItem && isEquipmentItem(activeItem)) {
      if (entity && entity.entityId !== "player") {
        const selected = selectedTargetRef.current;
        if (selected.kind !== "entity" || selected.entityId !== entity.entityId) {
          const target: Target = { kind: "entity", entityId: entity.entityId };
          setSelectedTarget(target);
          runtime.world.log(`选择目标：${describeTarget(runtime.world, target)}`);
          refreshUi();
          return;
        }
      }
      const target = targetForItem(runtime.world, activeItem, {
        actorId: "player",
        selectedTarget: selectedTargetRef.current,
        cursorPosition: [point.x, point.y],
        requireExplicitEntity: true,
      });
      dispatch({ kind: "useItem", itemId: activeItem.instanceId, target });
      return;
    }

    const target: Target = entity ? { kind: "entity", entityId: entity.entityId } : { kind: "position", position: [point.x, point.y] };
    setSelectedTarget(target);
    runtime.world.log(`选择目标：${describeTarget(runtime.world, target)}`);
    refreshUi();
  }, [dispatch, openLootContainer, refreshUi, runtime, setSelectedTarget]);

  useEffect(() => {
    if (!openLootContainerId) return;
    if (runtime.world.entities[openLootContainerId] && runtime.lootSystem.canInteract("player", openLootContainerId)) return;
    net.client.send({ kind: "lootCancelSearch", containerId: openLootContainerId, reason: "离开箱子范围" });
    setOpenLootContainerId(null);
    refreshUi();
  }, [net, openLootContainerId, refreshUi, runtime]);

  const world = runtime.world;
  const player = world.entities.player;
  const inventory = world.services.inventory.get("player").map((itemId) => world.items[itemId]).filter((item): item is ItemInstance => Boolean(item));
  const hotbarSlots = world.services.inventory.hotbar("player");
  const activeItemId = world.services.inventory.activeItemId("player");
  const selectedEntity = selectedTarget.kind === "entity" && selectedTarget.entityId ? world.entities[selectedTarget.entityId] : undefined;
  const entities = Object.values(world.entities).sort((a, b) => (a.entityId === "player" ? -1 : b.entityId === "player" ? 1 : a.entityId.localeCompare(b.entityId)));
  const visibleEntities = entities.slice(0, 4);
  const nearbyLootContainer = runtime.lootSystem.nearestContainer("player");
  const lootContainerOpen = openLootContainerId && world.entities[openLootContainerId] && runtime.lootSystem.canInteract("player", openLootContainerId) ? openLootContainerId : null;
  const lootView = lootContainerOpen ? runtime.lootSystem.containerView("player", lootContainerOpen) : undefined;
  const casting = player.components.casting;
  const castProgress = casting ? 1 - Math.max(0, casting.finishAtMs - world.nowMs()) / Math.max(1, casting.finishAtMs - casting.startedAtMs) : 0;

  return (
    <main className="game-shell">
      <header className="top-bar">
        <div>
          <h1>Canvas ECS MVP</h1>
          <p>TypeScript + Canvas 自由移动世界：装备、快捷栏、Effect 表现与指令生成。</p>
        </div>
        <div className="control-hints">
          <kbd>WASD</kbd>/<kbd>方向键</kbd> 移动 · <kbd>1-7</kbd> 快捷栏 · <kbd>B</kbd> 背包 · <kbd>左键</kbd> 使用装备 · <kbd>R</kbd> 装填 · <kbd>C</kbd> 取消
        </div>
      </header>

      <section className="game-layout">
        <div className="canvas-panel">
          <div className="playfield">
            <canvas ref={canvasRef} className="game-canvas" onClick={handleCanvasClick} onMouseMove={handleCanvasMouseMove} />
            <PlayerHud player={player} runtime={runtime} />
            <TargetHud entity={selectedEntity} runtime={runtime} />
            <Hotbar slots={hotbarSlots} world={world} activeItemId={activeItemId} onSlot={activateHotbarSlot} />
          </div>
          <div className="canvas-caption">
            <span>当前目标：<strong>{describeTarget(world, selectedTarget)}</strong></span>
            <span>{nearbyLootContainer ? <>附近箱子：<strong>{nearbyLootContainer.name}</strong>，按 <kbd>E</kbd> 交互。</> : "点击非玩家实体先选中；当前位置目标会使用鼠标位置。"}</span>
          </div>
        </div>

        <aside className={backpackOpen ? "side-panel backpack-open" : "side-panel"}>
          <section className="panel-card target-panel">
            <div className="row between">
              <h2>目标与施法</h2>
              <span className="target-inline">{describeTarget(world, selectedTarget)}</span>
            </div>
            {lootView ? (
              <LootPanel view={lootView} onTake={takeLootItem} onClose={closeLootContainer} />
            ) : casting ? (
              <div className="casting-box compact-cast">
                <div className="row between"><span>正在使用</span><strong>{casting.itemName}</strong></div>
                <div className="progress"><i style={{ width: `${Math.round(castProgress * 100)}%` }} /></div>
                <button onClick={cancelCasting}>取消</button>
              </div>
            ) : <p className="muted compact">无施法</p>}
          </section>

          <nav className="side-tabs">
            <button className={sideTab === "status" ? "active" : ""} onClick={() => { setSideTab("status"); setBackpackOpen(false); }}>实体</button>
            <button className={sideTab === "inventory" ? "active" : ""} onClick={() => { setSideTab("inventory"); setBackpackOpen(true); }}>背包</button>
            <button className={sideTab === "supply" ? "active" : ""} onClick={() => { setSideTab("supply"); setBackpackOpen(false); }}>补给</button>
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
                  <h2>背包</h2>
                  <span className="muted">{backpackOpen ? "按 B 关闭" : "按 B 打开"} · 设置 1-7 快捷栏</span>
                  <button className="tiny-action" onClick={organizeBackpack}>整理</button>
                </div>
                <div className="inventory-list">
                  {inventory.length ? inventory.map((item, index) => (
                    <InventoryRow
                      key={item.instanceId}
                      index={index}
                      item={item}
                      world={world}
                      onPrimary={() => isEquipmentItem(item) ? equipItem(item.instanceId) : useItem(item.instanceId)}
                      onAssignHotbar={(slotIndex) => assignHotbarSlot(slotIndex, item.instanceId)}
                    />
                  )) : <p className="muted">背包为空，下面可以补给。</p>}
                </div>
                {inventory.length > 4 && <p className="muted compact">滚动物品栏查看更多；数字键只对应快捷栏。</p>}
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
              onFocus={(event) => {
                setCommandFocused(true);
                setCommandCursor(event.currentTarget.selectionStart ?? commandLine.length);
              }}
              onBlur={() => window.setTimeout(() => setCommandFocused(false), 120)}
              onKeyDown={handleCommandKeyDown}
              onKeyUp={(event) => setCommandCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
              onChange={(event) => {
                commandHistoryIndexRef.current = null;
                commandDraftRef.current = "";
                setCommandLine(event.target.value);
                setCommandCursor(event.target.selectionStart ?? event.target.value.length);
              }}
              onSelect={(event) => {
                setCommandCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
                setSuggestionIndex(0);
              }}
              placeholder='help / give @player poison-cloud-grenade[targeting:range=60;activation:maxCharges=5;!economy]'
            />
            {showSuggestions && (
              <div className="command-suggestions">
                {filteredSuggestions.map((suggestion, index) => (
                  <button
                    type="button"
                    key={`${suggestion.label}-${suggestion.replaceFrom ?? 0}-${suggestion.insert}`}
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
                <small>↑/↓ 选择建议；输入框为空时浏览历史；Tab 补全，Enter 执行</small>
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
          {presentation.messages.slice(-40).map((message, index) => <LogEntry key={`${index}-${message}`} message={message} />)}
        </div>
      </section>
    </main>
  );
}

function LogEntry({ message }: { message: string }) {
  const multiline = message.includes("\n");
  return (
    <article className={multiline ? "log-entry multiline" : "log-entry"}>
      {multiline ? <pre>{message}</pre> : <span>{message}</span>}
    </article>
  );
}

function PlayerHud({ player, runtime }: { player: Entity; runtime: GameRuntime }) {
  return <HudCard title="玩家" entity={player} runtime={runtime} emptyText="玩家状态不可用" />;
}

function TargetHud({ entity, runtime }: { entity?: Entity; runtime: GameRuntime }) {
  return <HudCard title="选中目标" entity={entity} runtime={runtime} emptyText="未选中实体" align="right" />;
}

function HudCard({ title, entity, runtime, emptyText, align = "left" }: { title: string; entity?: Entity; runtime: GameRuntime; emptyText: string; align?: "left" | "right" }) {
  if (!entity) {
    return (
      <section className={`hud-card ${align === "right" ? "target-hud" : "player-hud"}`}>
        <div className="hud-title"><span>{title}</span><strong>{emptyText}</strong></div>
      </section>
    );
  }

  const resources = entity.components.resources ?? {};
  const hp = Number(resources.hp ?? 0);
  const maxHp = Number(resources.max_hp ?? (hp || 1));
  const hasHp = typeof resources.hp === "number";
  const effects = getEffectSummaries(runtime.world, entity).slice(0, 5);
  return (
    <section className={`hud-card ${align === "right" ? "target-hud" : "player-hud"}`}>
      <div className="hud-title"><span>{title}</span><strong>{entity.name}</strong></div>
      {hasHp ? <HudHpBar hp={hp} maxHp={maxHp} /> : <p className="muted compact">无生命资源</p>}
      <div className="hud-effects">
        {effects.length ? effects.map((effect) => (
          <span key={effect.id} className="hud-effect" style={{ borderColor: effect.color, color: effect.color }}>{effect.name.slice(0, 2)}{effect.stacks > 1 ? `×${effect.stacks}` : ""}</span>
        )) : <span className="muted">无 buff</span>}
      </div>
    </section>
  );
}

function HudHpBar({ hp, maxHp }: { hp: number; maxHp: number }) {
  const pct = Math.max(0, Math.min(100, (hp / Math.max(1, maxHp)) * 100));
  return <div className="hud-hp"><i style={{ width: `${pct}%` }} /><span>{hp}/{maxHp}</span></div>;
}

function LootPanel({ view, onTake, onClose }: { view: LootContainerView; onTake: (itemId: string) => void; onClose: () => void }) {
  return (
    <div className="loot-panel">
      <div className="row between loot-title">
        <strong>{view.title}</strong>
        <button className="tiny-action" onClick={onClose}>{view.isSearching ? "中断" : "关闭"}</button>
      </div>
      {view.isSearching && <div className="searching-hidden">正在搜索……</div>}
      <div className="loot-list">
        {view.revealedItems.length ? view.revealedItems.map((item) => (
          <article key={item.itemId} className="loot-row">
            <div className="item-icon">{itemIcon(item.protoId)}</div>
            <div className="item-main">
              <div className="row between"><strong>{item.name}{item.quantity ? ` ×${item.quantity}` : ""}</strong><span className="muted">{item.category}</span></div>
              <p>{item.description}</p>
            </div>
            <button disabled={!item.canTake || view.isSearching} onClick={() => onTake(item.itemId)}>拿取</button>
          </article>
        )) : <p className="muted compact">尚未发现物品。</p>}
      </div>
      <div className="search-next passive-search-state">
        {view.isSearching ? "自动搜索中" : view.hasMoreUnknownItems ? "等待继续搜索" : "箱子已搜空"}
      </div>
      <p className="muted compact">打开箱子后会自动逐个搜索；搜索期间无法移动，搜索耗时和剩余数量不会显示。</p>
    </div>
  );
}

function Hotbar({ slots, world, activeItemId, onSlot }: { slots: Array<string | null>; world: World; activeItemId?: string; onSlot: (slotIndex: number) => void }) {
  return (
    <div className="hotbar" aria-label="快捷栏">
      {slots.map((itemId, index) => {
        const item = itemId ? world.items[itemId] : undefined;
        const cooldown = item ? cooldownRemainingMs(item, world) : 0;
        const classes = ["hotbar-slot", item?.instanceId === activeItemId ? "active" : "", cooldown > 0 ? "cooling" : ""].filter(Boolean).join(" ");
        return (
          <button key={index} type="button" className={classes} disabled={!item} onClick={() => onSlot(index)} title={item ? displayItemName(item) : `空快捷栏 ${index + 1}`}>
            <span className="hotbar-key">{index + 1}</span>
            <span className="hotbar-icon">{item ? itemIcon(item.protoId) : ""}</span>
            {item && <span className="hotbar-count">{hotbarItemStatus(item)}</span>}
            {cooldown > 0 && <span className="hotbar-cooldown">{formatMs(cooldown)}</span>}
          </button>
        );
      })}
    </div>
  );
}

function hotbarItemStatus(item: ItemInstance): string {
  const firearm = item.components.firearm;
  if (firearm) return `${(firearm.loadedRounds ?? []).length}/${firearm.magazineSize}`;
  const stacking = item.components.stacking;
  if (stacking && Number(stacking.max ?? 1) > 1) return `×${stacking.quantity}`;
  const activation = item.components.activation;
  if (activation && activation.consumeCharge !== false) return String(activation.charges ?? activation.maxCharges ?? 1);
  if (isEquipmentItem(item)) return "装备";
  return itemCategory(item);
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

function InventoryRow({ index, item, world, onPrimary, onAssignHotbar }: { index: number; item: ItemInstance; world: World; onPrimary: () => void; onAssignHotbar: (slotIndex: number) => void }) {
  const activation = item.components.activation;
  const cooldown = cooldownRemainingMs(item, world);
  const isEquipment = isEquipmentItem(item);
  const charges = activation ? (activation.consumeCharge === false ? "∞" : `${activation.charges}/${activation.maxCharges}`) : "-";
  const stacking = item.components.stacking;
  const stackText = stacking && Number(stacking.max ?? 1) > 1 ? `数量 ${stacking.quantity ?? 1}/${stacking.max}` : undefined;
  const disabled = !isEquipment && (!activation || cooldown > 0 || (activation.consumeCharge !== false && Number(activation.charges ?? 0) <= 0));
  const targetMode = item.components.targeting?.mode ?? (isEquipment ? "装备" : "self");
  const canHotbar = isEquipment || Boolean(activation);
  return (
    <article className="inventory-row">
      <div className="slot-index">{index + 1}</div>
      <div className="item-icon">{itemIcon(item.protoId)}</div>
      <div className="item-main">
        <div className="row between"><strong>{displayItemName(item)}</strong><span className="muted">{itemCategory(item)} · {targetMode}</span></div>
        <p>{interpolateItemText(String(item.components.display?.description ?? item.protoId), item)}</p>
        <div className="item-meta">
          {stackText && <span>{stackText}</span>}
          <span>次数 {charges}</span>
          <span>CD {cooldown > 0 ? formatMs(cooldown) : "就绪"}</span>
          <span>施法 {formatMs(Number(activation?.castDurationMs ?? 0))}</span>
        </div>
      </div>
      <div className="inventory-actions">
        <button disabled={disabled} onClick={onPrimary}>{isEquipment ? "装备" : "使用"}</button>
        {canHotbar && (
          <div className="hotbar-picker" aria-label="设置快捷栏">
            {[0, 1, 2, 3, 4, 5, 6].map((slotIndex) => <button key={slotIndex} type="button" onClick={() => onAssignHotbar(slotIndex)}>{slotIndex + 1}</button>)}
          </div>
        )}
      </div>
    </article>
  );
}

function interpolateItemText(text: string, item: ItemInstance): string {
  const vars: Record<string, string | number> = {
    modifyAttr: asTextVar(item.components.modifyAttr) ?? "hp",
    modifyValueRate: asTextVar(item.components.modifyValueRate) ?? inferPeriodicValue(item),
  };

  return text.replace(/\{\$attribute\[([^\]]+)\]\.name\}/g, (_match, rawKey: string) => {
    const key = rawKey.startsWith("$") ? String(vars[rawKey.slice(1)] ?? rawKey) : rawKey;
    return ATTRIBUTE_NAMES[key] ?? key;
  }).replace(/\{\$([A-Za-z0-9_]+)\}/g, (_match, key: string) => String(vars[key] ?? ""));
}

function asTextVar(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
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

function movementDirFromKeys(pressedKeys: Set<string>): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const key of pressedKeys) {
    const vector = MOVEMENT_VECTORS[key];
    if (!vector) continue;
    x += vector.x;
    y += vector.y;
  }
  return { x, y };
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
  if (!world.services.spatial.isInside(x, y)) return undefined;
  return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
}

function drawWorld(context: CanvasRenderingContext2D, runtime: GameRuntime, selectedTarget: Target, presentation: PresentationState, client: ClientSession, alpha: number): void {
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
  drawVisualEvents(context, presentation, layout, world.nowMs());
  for (const entity of Object.values(world.entities)) {
    // 本地玩家用预测位置；远端实体用最近两帧快照插值，避免 30Hz tick 下的卡顿。
    const renderPosition = client.interpolatedPosition(entity.entityId, alpha) ?? entity.components.position;
    drawEntity(context, runtime, entity, layout, renderPosition);
  }
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
      const bounds = world.services.spatial.entityBounds(entity);
      const topLeft = worldToCanvas(layout, bounds.left, bounds.top);
      const bottomRight = worldToCanvas(layout, bounds.right, bounds.bottom);
      context.strokeRect(topLeft.x - 5, topLeft.y - 5, bottomRight.x - topLeft.x + 10, bottomRight.y - topLeft.y + 10);
    } else {
      const center = worldToCanvas(layout, position.x, position.y);
      context.beginPath();
      context.arc(center.x, center.y, world.services.spatial.entityRadius(entity) * layout.scale + 8, 0, Math.PI * 2);
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

function drawEntity(context: CanvasRenderingContext2D, runtime: GameRuntime, entity: Entity, layout: CanvasLayout, renderPosition?: { x: number; y: number }): void {
  const world = runtime.world;
  const position = renderPosition ?? entity.components.position ?? { x: 0, y: 0 };
  const center = worldToCanvas(layout, position.x, position.y);
  const bounds = world.services.spatial.entityBounds(entity);
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

  const display = entity.components.display;
  const isPlayer = entity.entityId === "player";
  context.fillStyle = display?.color ?? (isPlayer ? "#38bdf8" : "#f87171");
  context.strokeStyle = display?.strokeColor ?? (isPlayer ? "#bae6fd" : "#fecaca");
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
  context.fillText(String(display?.glyph ?? (isPlayer ? "P" : "?")), center.x, center.y + 1);

  drawHealthBar(context, entity, center.x, center.y - visualRadius - 14, Math.max(44, bodyWidth));
  drawCastingRing(context, entity, center, visualRadius + 2, now);
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

function drawCastingRing(context: CanvasRenderingContext2D, entity: Entity, center: { x: number; y: number }, radius: number, now: number): void {
  const casting = entity.components.casting;
  if (!casting) return;
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

function drawVisualEvents(context: CanvasRenderingContext2D, presentation: PresentationState, layout: CanvasLayout, now: number): void {
  for (const event of presentation.visualEvents) {
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
