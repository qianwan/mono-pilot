import fs from "node:fs/promises";
import path from "node:path";

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
