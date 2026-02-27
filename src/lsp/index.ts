import { Log } from "./log.js";
import { LSPClient } from "./client.js";
import { LSPServer } from "./server.js";
import { LspState } from "./state.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

export namespace LSP {
  const log = Log.create({ service: "lsp" });

  type State = {
    clients: LSPClient.Info[];
    servers: Record<string, LSPServer.Info>;
    broken: Set<string>;
    spawning: Map<string, Promise<LSPClient.Info | undefined>>;
  };

  let _state: State | undefined;

  function getState(): State {
    if (!_state) {
      _state = {
        clients: [],
        servers: {
          typescript: LSPServer.Typescript,
          pyright: LSPServer.Pyright,
          gopls: LSPServer.Gopls,
          rust: LSPServer.RustAnalyzer,
          clangd: LSPServer.Clangd,
        },
        broken: new Set(),
        spawning: new Map(),
      };
    }
    return _state;
  }

  export function init(directory: string) {
    LspState.directory = directory;
    log.info("LSP initialized", { directory });
  }

  export async function shutdown() {
    if (!_state) return;
    await Promise.all(_state.clients.map((c) => c.shutdown()));
    _state = undefined;
  }

  async function getClients(file: string): Promise<LSPClient.Info[]> {
    const s = getState();
    const ext = path.parse(file).ext || file;
    const result: LSPClient.Info[] = [];

    async function schedule(
      server: LSPServer.Info,
      root: string,
      key: string,
    ): Promise<LSPClient.Info | undefined> {
      const handle = await server
        .spawn(root)
        .then((v) => {
          if (!v) s.broken.add(key);
          return v;
        })
        .catch((err) => {
          s.broken.add(key);
          log.error(`failed to spawn ${server.id}`, { error: String(err) });
          return undefined;
        });

      if (!handle) return undefined;

      const client = await LSPClient.create({
        serverID: server.id,
        server: handle,
        root,
      }).catch((err) => {
        s.broken.add(key);
        handle.process.kill();
        log.error(`failed to init ${server.id}`, { error: String(err) });
        return undefined;
      });

      if (!client) {
        handle.process.kill();
        return undefined;
      }

      // Race condition guard: another concurrent call may have added the same client
      const existing = s.clients.find((x) => x.root === root && x.serverID === server.id);
      if (existing) {
        handle.process.kill();
        return existing;
      }

      s.clients.push(client);
      return client;
    }

    for (const server of Object.values(s.servers)) {
      if (server.extensions.length && !server.extensions.includes(ext)) continue;

      const root = await server.root(file);
      if (!root) continue;

      const key = root + server.id;
      if (s.broken.has(key)) continue;

      const match = s.clients.find((x) => x.root === root && x.serverID === server.id);
      if (match) {
        result.push(match);
        continue;
      }

      const inflight = s.spawning.get(key);
      if (inflight) {
        const c = await inflight;
        if (c) result.push(c);
        continue;
      }

      const task = schedule(server, root, key);
      s.spawning.set(key, task);
      task.finally(() => {
        if (s.spawning.get(key) === task) s.spawning.delete(key);
      });

      const client = await task;
      if (client) result.push(client);
    }

    return result;
  }

  export async function touchFile(file: string, wait?: boolean) {
    const clients = await getClients(file);
    await Promise.all(
      clients.map(async (client) => {
        const pending = wait
          ? client.waitForDiagnostics({ path: file })
          : Promise.resolve();
        await client.notify.open({ path: file });
        return pending;
      }),
    ).catch((err) => log.error("failed to touch file", { err: String(err), file }));
  }

  export async function diagnostics(): Promise<Record<string, LSPClient.Diagnostic[]>> {
    const s = getState();
    const results: Record<string, LSPClient.Diagnostic[]> = {};
    for (const client of s.clients) {
      for (const [p, diags] of client.diagnostics.entries()) {
        results[p] = [...(results[p] ?? []), ...diags];
      }
    }
    return results;
  }

  export async function workspaceSymbol(query: string) {
    const s = getState();
    // Filter to meaningful symbol kinds: Class(5), Method(6), Enum(10), Interface(11), Function(12)
    const meaningful = new Set([5, 6, 10, 11, 12, 13, 14, 23]);
    const tasks = s.clients.map((c) =>
      c.connection
        .sendRequest("workspace/symbol", { query })
        .then((r: any) =>
          (r ?? [])
            .filter((x: any) => meaningful.has(x.kind))
            .slice(0, 10),
        )
        .catch(() => [] as any[]),
    );
    return (await Promise.all(tasks)).flat();
  }

  export namespace Diagnostic {
    const severityLabel: Record<number, string> = {
      1: "ERROR",
      2: "WARN",
      3: "INFO",
      4: "HINT",
    };

    export function pretty(d: LSPClient.Diagnostic): string {
      const sev = severityLabel[d.severity ?? 1] ?? "ERROR";
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      return `${sev} [${line}:${col}] ${d.message}`;
    }
  }
}
