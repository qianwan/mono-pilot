import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { Log } from "./log.js";
import { Filesystem } from "./filesystem.js";
import { LspState } from "./state.js";

export namespace LSPServer {
  const log = Log.create({ service: "lsp.server" });

  // Directory for npm-installed LSP servers
  const binDir = path.join(os.homedir(), ".mono-pilot", "lsp");

  export interface Handle {
    process: ChildProcessWithoutNullStreams;
    initialization?: Record<string, unknown>;
  }

  type RootFunction = (file: string) => Promise<string | undefined>;

  export interface Info {
    id: string;
    extensions: string[];
    root: RootFunction;
    spawn(root: string): Promise<Handle | undefined>;
  }

  function which(cmd: string): string | undefined {
    const w = process.platform === "win32" ? "where" : "which";
    try {
      return execSync(`${w} ${cmd}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
        .trim()
        .split("\n")[0] || undefined;
    } catch {
      return undefined;
    }
  }

  async function npmInstall(...pkgs: string[]): Promise<void> {
    await fs.mkdir(binDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      const proc = spawn(npm, ["install", "--prefix", binDir, ...pkgs], { stdio: "pipe" });
      proc.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`npm install ${pkgs.join(" ")} failed (exit ${code})`)),
      );
      proc.on("error", reject);
    });
  }

  async function* filesUp(opts: { targets: string[]; start: string; stop: string }): AsyncGenerator<string> {
    let current = opts.start;
    while (true) {
      for (const target of opts.targets) {
        const p = path.join(current, target);
        if (await Filesystem.exists(p)) yield p;
      }
      if (current === opts.stop || !current.startsWith(opts.stop)) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  const NearestRoot = (includePatterns: string[], excludePatterns?: string[]): RootFunction => {
    return async (file) => {
      const dir = path.dirname(file);
      const stop = LspState.directory;

      if (excludePatterns) {
        const gen = filesUp({ targets: excludePatterns, start: dir, stop });
        const first = await gen.next();
        await gen.return(undefined);
        if (first.value) return undefined;
      }

      const gen = filesUp({ targets: includePatterns, start: dir, stop });
      const first = await gen.next();
      await gen.return(undefined);
      if (!first.value) return stop;
      return path.dirname(first.value);
    };
  };

  export const Typescript: Info = {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    root: NearestRoot(
      ["package-lock.json", "package.json", "yarn.lock", "pnpm-lock.yaml"],
      ["deno.json", "deno.jsonc"],
    ),
    async spawn(root) {
      // Try to find the project's tsserver.js for initialization
      const req = createRequire(path.join(root, "_"));
      let tsserver: string | undefined;
      try {
        tsserver = req.resolve("typescript/lib/tsserver.js");
      } catch {
        // TypeScript not in project node_modules; server will use its own
      }

      let bin = which("typescript-language-server");
      if (!bin) {
        const local = path.join(binDir, "node_modules", ".bin", "typescript-language-server");
        if (!(await Filesystem.exists(local))) {
          log.info("installing typescript-language-server");
          try {
            await npmInstall("typescript-language-server", "typescript");
          } catch (e) {
            log.error("failed to install typescript-language-server", { error: String(e) });
            return;
          }
        }
        if (await Filesystem.exists(local)) bin = local;
      }

      if (!bin) {
        log.error("typescript-language-server not found");
        return;
      }

      return {
        process: spawn(bin, ["--stdio"], { cwd: root }),
        initialization: tsserver ? { tsserver: { path: tsserver } } : undefined,
      };
    },
  };

  export const Pyright: Info = {
    id: "pyright",
    extensions: [".py", ".pyi"],
    root: NearestRoot([
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      "pyrightconfig.json",
    ]),
    async spawn(root) {
      let bin = which("pyright-langserver");
      if (!bin) {
        const local = path.join(binDir, "node_modules", ".bin", "pyright-langserver");
        if (!(await Filesystem.exists(local))) {
          log.info("installing pyright");
          try {
            await npmInstall("pyright");
          } catch (e) {
            log.error("failed to install pyright", { error: String(e) });
            return;
          }
        }
        if (await Filesystem.exists(local)) bin = local;
      }

      if (!bin) {
        log.error("pyright-langserver not found");
        return;
      }

      // Detect virtualenv for python path initialization
      const initialization: Record<string, string> = {};
      const venvPaths = [
        process.env["VIRTUAL_ENV"],
        path.join(root, ".venv"),
        path.join(root, "venv"),
      ].filter((p): p is string => p !== undefined);

      for (const venv of venvPaths) {
        const python =
          process.platform === "win32"
            ? path.join(venv, "Scripts", "python.exe")
            : path.join(venv, "bin", "python");
        if (await Filesystem.exists(python)) {
          initialization["pythonPath"] = python;
          break;
        }
      }

      return {
        process: spawn(bin, ["--stdio"], { cwd: root }),
        initialization,
      };
    },
  };

  export const Gopls: Info = {
    id: "gopls",
    extensions: [".go"],
    root: async (file) => {
      const work = await NearestRoot(["go.work"])(file);
      if (work) return work;
      return NearestRoot(["go.mod", "go.sum"])(file);
    },
    async spawn(root) {
      const bin = which("gopls");
      if (!bin) {
        log.error("gopls not found. Install with: go install golang.org/x/tools/gopls@latest");
        return;
      }
      return { process: spawn(bin, { cwd: root }) };
    },
  };

  export const RustAnalyzer: Info = {
    id: "rust",
    extensions: [".rs"],
    root: async (file) => {
      const crate = await NearestRoot(["Cargo.toml", "Cargo.lock"])(file);
      if (!crate) return undefined;

      // Walk up to find workspace-level Cargo.toml
      let current = crate;
      while (true) {
        const content = await fs.readFile(path.join(current, "Cargo.toml"), "utf8").catch(() => "");
        if (content.includes("[workspace]")) return current;
        const parent = path.dirname(current);
        if (parent === current || !parent.startsWith(LspState.directory)) break;
        current = parent;
      }
      return crate;
    },
    async spawn(root) {
      const bin = which("rust-analyzer");
      if (!bin) {
        log.error("rust-analyzer not found. Install with: rustup component add rust-analyzer");
        return;
      }
      return { process: spawn(bin, { cwd: root }) };
    },
  };

  export const Clangd: Info = {
    id: "clangd",
    extensions: [".c", ".cpp", ".cxx", ".cc", ".c++", ".h", ".hpp", ".hxx", ".hh"],
    // compile_commands.json is the gold standard; fall back to CMake/Makefile markers
    root: NearestRoot([
      "compile_commands.json",
      "compile_flags.txt",
      ".clangd",
      "CMakeLists.txt",
      "Makefile",
    ]),
    async spawn(root) {
      const bin = which("clangd");
      if (!bin) {
        log.error(
          "clangd not found. Install with: brew install llvm, or apt install clangd",
        );
        return;
      }
      return {
        process: spawn(bin, ["--background-index", "--clang-tidy"], { cwd: root }),
      };
    },
  };
}
