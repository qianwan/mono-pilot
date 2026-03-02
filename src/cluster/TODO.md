# Cluster Subsystem — TODO

## Architecture

- [ ] Extract `src/cluster/init.ts` — unified `initCluster()` / `shutdownCluster()` entry point
  - Absorb config reading, embedding service init, `setMemoryWorkersEmbeddingProvider` from `mono-pilot.ts`
  - `mono-pilot.ts` only calls `initCluster({ agentId, getSessionId })` + `shutdownCluster()`
  - Future services (reranker, summarizer) register inside `initCluster`, not in `mono-pilot.ts`

- [ ] Generalize `leader.ts` request handler
  - Currently embed logic is hardcoded in `handleRequest` switch
  - Make handler registration-based so multiple services can coexist on the same socket

## Reliability

- [ ] Fix stale socket detection in `socket.ts`
  - When leader exits, socket file may linger before cleanup
  - `tryListen()` hits `EADDRINUSE` → returns `null` → falls back to standalone
  - Fix: add `isSocketAlive()` probe — try connect, if refused then delete stale socket and retry listen

## Config

- [ ] Implement `gpuLayers` config
  - Default `0` (CPU) for safety; support `number | "auto" | "max"`
  - Add to `config/types.ts`, `config/defaults.ts`, `config/resolve.ts`
  - Pass through `embeddings/local.ts` → `getLlama()` / `loadLlamaModel()`

- [ ] Fix model config URI
  - Current default points to wrong HF repo for Qwen3-Embedding-0.6B
  - Correct: `hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf`

- [ ] Decide on `mmr` / `temporalDecay` — implement or remove from config schema

- [ ] Add `cache.maxEntries` to default config (e.g. `10000`) to bound embedding cache growth

## Observability

- [ ] Leader embed request logs should distinguish follower origin
  - Protocol now carries `from: { pid, agentId, sessionId }` ✓
  - Leader's own embed calls don't appear in cluster log (direct provider call, no socket)
  - Consider: add optional logging in leader's own embed path for parity

## Future

- [ ] Hyperswarm integration for cross-network clustering (remote agents sharing one embedding service)
- [ ] Leader handoff / graceful migration (currently leader stays until exit, no demotion)