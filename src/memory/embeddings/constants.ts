import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LOCAL_MODEL =
	"hf:gpustack/bge-m3-GGUF/bge-m3-Q8_0.gguf";

export const DEFAULT_MODEL_CACHE_DIR = join(homedir(), ".mono-pilot", "models");