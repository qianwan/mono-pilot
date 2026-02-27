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
