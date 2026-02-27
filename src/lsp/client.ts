import { Bus, BusEvent } from "./bus.js";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/lib/node/main.js";
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types";
import { Log } from "./log.js";
import { LANGUAGE_EXTENSIONS } from "./language.js";
import type { LSPServer } from "./server.js";
import { withTimeout } from "./timeout.js";
import { LspState } from "./state.js";
import { Filesystem } from "./filesystem.js";

const DIAGNOSTICS_DEBOUNCE_MS = 150;

export namespace LSPClient {
  const log = Log.create({ service: "lsp.client" });

  export type Info = NonNullable<Awaited<ReturnType<typeof create>>>;
  export type Diagnostic = VSCodeDiagnostic;

  export const Event = {
    Diagnostics: BusEvent.define<{ serverID: string; path: string }>(
      "lsp.client.diagnostics",
      null,
    ),
  };

  export async function create(input: {
    serverID: string;
    server: LSPServer.Handle;
    root: string;
  }) {
    const l = log.clone().tag("serverID", input.serverID);
    l.info("starting client");

    const connection = createMessageConnection(
      new StreamMessageReader(input.server.process.stdout as any),
      new StreamMessageWriter(input.server.process.stdin as any),
    );

    const diagnostics = new Map<string, Diagnostic[]>();

    connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: { uri: string; diagnostics: Diagnostic[] }) => {
        const filePath = Filesystem.normalizePath(fileURLToPath(params.uri));
        const existed = diagnostics.has(filePath);
        diagnostics.set(filePath, params.diagnostics);
        // TypeScript sends empty diagnostics on first open; skip until we have a prior entry
        if (!existed && input.serverID === "typescript") return;
        Bus.publish(Event.Diagnostics, { path: filePath, serverID: input.serverID });
      },
    );

    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onRequest("workspace/configuration", async () => [input.server.initialization ?? {}]);
    connection.onRequest("client/registerCapability", async () => {});
    connection.onRequest("client/unregisterCapability", async () => {});
    connection.onRequest("workspace/workspaceFolders", async () => [
      { name: "workspace", uri: pathToFileURL(input.root).href },
    ]);
    connection.listen();

    l.info("sending initialize");
    await withTimeout(
      connection.sendRequest("initialize", {
        rootUri: pathToFileURL(input.root).href,
        processId: input.server.process.pid,
        workspaceFolders: [{ name: "workspace", uri: pathToFileURL(input.root).href }],
        initializationOptions: { ...input.server.initialization },
        capabilities: {
          window: { workDoneProgress: true },
          workspace: {
            configuration: true,
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
          textDocument: {
            synchronization: { didOpen: true, didChange: true },
            publishDiagnostics: { versionSupport: true },
          },
        },
      }),
      45_000,
    ).catch((err) => {
      const e = new Error(`LSP initialize failed: ${input.serverID}`);
      (e as any).cause = err;
      throw e;
    });

    await connection.sendNotification("initialized", {});

    if (input.server.initialization) {
      await connection.sendNotification("workspace/didChangeConfiguration", {
        settings: input.server.initialization,
      });
    }

    const files: Record<string, number> = {};

    const result = {
      root: input.root,
      get serverID() {
        return input.serverID;
      },
      get connection() {
        return connection;
      },
      notify: {
        async open(inp: { path: string }) {
          const p = path.isAbsolute(inp.path)
            ? inp.path
            : path.resolve(LspState.directory, inp.path);
          const text = await Filesystem.readText(p);
          const ext = path.extname(p);
          const languageId =
            LANGUAGE_EXTENSIONS[ext as keyof typeof LANGUAGE_EXTENSIONS] ?? "plaintext";
          const uri = pathToFileURL(p).href;
          const version = files[p];

          if (version !== undefined) {
            await connection.sendNotification("workspace/didChangeWatchedFiles", {
              changes: [{ uri, type: 2 }],
            });
            const next = version + 1;
            files[p] = next;
            await connection.sendNotification("textDocument/didChange", {
              textDocument: { uri, version: next },
              contentChanges: [{ text }],
            });
            return;
          }

          await connection.sendNotification("workspace/didChangeWatchedFiles", {
            changes: [{ uri, type: 1 }],
          });
          diagnostics.delete(p);
          await connection.sendNotification("textDocument/didOpen", {
            textDocument: { uri, languageId, version: 0, text },
          });
          files[p] = 0;
        },
      },
      get diagnostics() {
        return diagnostics;
      },
      async waitForDiagnostics(inp: { path: string }) {
        const normalized = Filesystem.normalizePath(
          path.isAbsolute(inp.path)
            ? inp.path
            : path.resolve(LspState.directory, inp.path),
        );
        let unsub: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        return withTimeout(
          new Promise<void>((resolve) => {
            unsub = Bus.subscribe(Event.Diagnostics, (event) => {
              if (
                event.properties.path === normalized &&
                event.properties.serverID === result.serverID
              ) {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                  unsub?.();
                  resolve();
                }, DIAGNOSTICS_DEBOUNCE_MS);
              }
            });
          }),
          3000,
        )
          .catch(() => {})
          .finally(() => {
            if (timer) clearTimeout(timer);
            unsub?.();
          });
      },
      async shutdown() {
        connection.end();
        connection.dispose();
        input.server.process.kill();
      },
    };

    l.info("initialized");
    return result;
  }
}
