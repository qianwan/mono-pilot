let dir = process.cwd();

export const LspState = {
  get directory() {
    return dir;
  },
  set directory(d: string) {
    dir = d;
  },
};
