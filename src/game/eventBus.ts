import type { EventData, GameEventMap } from "./types";

type Listener<K extends keyof GameEventMap> = (event: EventData<K>) => void;

export class EventBus {
  private listeners: Partial<{ [K in keyof GameEventMap]: Listener<K>[] }> = {};

  subscribe<K extends keyof GameEventMap>(eventName: K, listener: Listener<K>): void {
    const list = this.listeners[eventName] as Listener<K>[] | undefined;
    if (list) list.push(listener);
    else this.listeners[eventName] = [listener] as Partial<{ [P in keyof GameEventMap]: Listener<P>[] }>[K];
  }

  emit<K extends keyof GameEventMap>(eventName: K, data: GameEventMap[K]): void {
    const event = { name: eventName, data } as EventData<K>;
    const list = this.listeners[eventName] as Listener<K>[] | undefined;
    for (const listener of list ?? []) listener(event);
  }
}
