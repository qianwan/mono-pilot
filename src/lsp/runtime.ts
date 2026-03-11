import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

type Logger = {
  info: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
  clone: () => Logger;
  tag: (k: string, v: unknown) => Logger;
};

export const Log = {
  create: (_meta: Record<string, string>): Logger => ({
    info: (_msg, _data) => {},
    error: (msg, data) => console.error(`[lsp] ${msg}`, data ?? ""),
    clone() {
      return this;
    },
    tag(_k, _v) {
      return this;
    },
  }),
};

let dir = process.cwd();

export const LspState = {
  get directory() {
    return dir;
  },
  set directory(d: string) {
    dir = d;
  },
};

const exists = (p: string) =>
  fs.access(p).then(() => true).catch(() => false);

async function* filesUp(opts: {
  targets: string[];
  start: string;
  stop: string;
}): AsyncGenerator<string> {
  let current = opts.start;
  while (true) {
    for (const target of opts.targets) {
      const p = path.join(current, target);
      if (await exists(p)) yield p;
    }
    if (current === opts.stop || !current.startsWith(opts.stop)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export const Filesystem = {
  readText: (p: string) => fs.readFile(p, "utf8"),
  exists,
  normalizePath: (p: string) => path.normalize(p),
  up: filesUp,
};

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
    ),
  ]);
}

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
