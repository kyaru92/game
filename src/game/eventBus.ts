import type { EventData, JsonObj } from "./types";

export class EventBus {
  private listeners = new Map<string, Array<(event: EventData) => void>>();

  subscribe(eventName: string, listener: (event: EventData) => void): void {
    const list = this.listeners.get(eventName) ?? [];
    list.push(listener);
    this.listeners.set(eventName, list);
  }

  emit(eventName: string, data: JsonObj): void {
    const event = { name: eventName, data };
    for (const listener of this.listeners.get(eventName) ?? []) listener(event);
  }
}
