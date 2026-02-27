import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

export type EventDef<T> = { type: string };

export const BusEvent = {
  define: <T>(type: string, _schema: unknown): EventDef<T> => ({ type }),
};

export const Bus = {
  publish: <T>(event: EventDef<T>, props: T) => {
    emitter.emit(event.type, { properties: props });
  },
  subscribe: <T>(
    event: EventDef<T>,
    handler: (data: { properties: T }) => void,
  ): (() => void) => {
    emitter.on(event.type, handler);
    return () => emitter.off(event.type, handler);
  },
};
