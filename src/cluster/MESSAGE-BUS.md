# Cluster Message Bus Design

> Status: **in progress** — protocol, leader route table, and follower push handling implemented.

## Overview

Extend the existing cluster (Unix domain socket, leader/follower election) from
a single-purpose embedding service into a general-purpose **message bus** for
inter-agent communication. The leader acts as a centralized message broker;
followers both send requests and receive server-pushed messages.

## Current State

```
follower A ──request──▶ leader ──response──▶ follower A
follower B ──request──▶ leader ──response──▶ follower B
```

- Single socket: `~/.mono-pilot/cluster.sock`
- Protocol: length-prefixed JSON (4-byte LE + JSON payload)
- RPC methods: `ping`, `embed`
- Follower sends `ClusterRequest`, leader replies `ClusterResponse`
- Leader does not push unsolicited messages to followers
- Follower's `ClusterClient.onData` only resolves pending RPC promises

## Target State

```
follower A ──request/send──▶ leader (broker) ──push──▶ follower B
follower B ──request/send──▶ leader (broker) ──push──▶ follower A
                                    │
                              route table
                         Map<agentId, socket>
```

## Protocol Changes

### New Wire Type: Server Push

Current `ClusterResponse` is always a reply to a request (matched by `id`).
Add a **push message** type distinguished by having no `id` field:

```typescript
/** Unsolicited message pushed from leader to follower. */
export interface ClusterPush {
  type: "push";
  method: string;       // "message" | "presence" | ...
  payload: unknown;
}
```

Follower's `onData` handler checks: if the parsed message has `type === "push"`,
route to the push handler; otherwise resolve pending RPC as before.

### New RPC Methods

| method      | direction       | params                                       | semantics                            |
|-------------|-----------------|----------------------------------------------|--------------------------------------|
| `register`  | follower→leader | `{ agentId, channels?: string[] }`           | Register in route table, subscribe   |
| `send`      | follower→leader | `{ to: agentId, channel?, payload }`         | Point-to-point message               |
| `broadcast` | follower→leader | `{ channel?, payload }`                      | Send to all subscribers of channel   |
| `subscribe` | follower→leader | `{ channels: string[] }`                     | Subscribe to additional channels     |

### Push Methods (leader→follower)

| method      | payload                                      | semantics                          |
|-------------|----------------------------------------------|------------------------------------|
| `message`   | `{ from: agentId, channel?, payload, seq }`  | Incoming message from another agent|
| `presence`  | `{ agentId, status: "joined"|"left" }`       | Agent connected/disconnected       |

## Leader: Route Table

```typescript
interface ConnectedAgent {
  agentId: string;
  socket: net.Socket;
  channels: Set<string>;
}

// Maintained in leader.ts
const agents = new Map<string, ConnectedAgent>();
let messageSeq = 0;
```

- On `connection` event: socket stored temporarily; agent registered on `register` RPC.
- On socket `close`: remove from `agents`, broadcast `presence:left`.
- On `send`: look up `to` in agents map, write push message to target socket.
- On `broadcast`: iterate agents subscribed to `channel` (or all if no channel).
- Every message assigned `++messageSeq` for total ordering.

## Follower: Bidirectional Handling

Current `ClusterClient` only handles RPC responses. Extend with push listener:

```typescript
class ClusterClient {
  // existing: pending RPC map, call(), close(), etc.

  private pushHandler?: (method: string, payload: unknown) => void;

  onPush(handler: (method: string, payload: unknown) => void): void {
    this.pushHandler = handler;
  }

  // In onData, after decoding messages:
  private handleIncoming(msg: unknown): void {
    if (isPush(msg)) {
      this.pushHandler?.(msg.method, msg.payload);
    } else {
      // existing: resolve/reject pending RPC
    }
  }
}
```

## Channel Design

Channels provide topic-based routing and information asymmetry:

| channel pattern       | semantics                               |
|-----------------------|-----------------------------------------|
| `public`              | Default; all agents receive             |
| `private:{agentId}`   | Only target agent receives              |
| `gm`                  | Only the game master / human receives   |
| `clue:{round}`        | Per-round information; selective access |

- `broadcast` without `channel` defaults to `public`.
- `subscribe` controls which channels a follower receives.
- Leader can enforce access control (e.g. reject subscribe to `private:*`).

## Message Ordering & Persistence

- Leader assigns monotonically increasing `seq` to every routed message.
- Optional: append to `~/.mono-pilot/bus/messages.jsonl` for replay.
- Reconnecting follower can send `{ method: "replay", params: { since: lastSeq } }`
  to catch up on missed messages.

## Bus API (`bus.ts`)

High-level wrapper over `ClusterClient` RPC + push. Hides protocol details;
exposes a simple event-driven interface for agent code.

### Interface

```typescript
export interface BusHandle {
  /** Send a direct message to a specific agent. */
  send(to: string, payload: unknown, channel?: string): Promise<{ seq: number }>;
  /** Broadcast to all subscribers of a channel (default: "public"). */
  broadcast(payload: unknown, channel?: string): Promise<{ seq: number; delivered: number }>;
  /** Subscribe to additional channels. */
  subscribe(channels: string[]): Promise<{ channels: string[] }>;
  /** Register a handler for incoming messages from other agents. */
  onMessage(handler: (msg: { from: string; channel?: string; payload: unknown; seq: number }) => void): void;
  /** Register a handler for presence events (agent joined/left). */
  onPresence(handler: (event: { agentId: string; status: "joined" | "left" }) => void): void;
  /** Disconnect from the bus. */
  close(): void;
}
```

### Lifecycle

1. Caller obtains a `FollowerHandle` (already done by `embedding-service.ts`).
2. `connectBus(client, agentId, channels?)` calls `register` RPC, wires
   `client.onPush()` to dispatch `message` and `presence` events, returns `BusHandle`.
3. `send()` / `broadcast()` are thin wrappers around `client.call("send", ...)` /
   `client.call("broadcast", ...)`.
4. `close()` is a no-op on the socket (owned by `FollowerHandle`); it only
   unregisters push handlers so the bus can be detached without killing the
   embedding connection.

### Why a Separate File

- `follower.ts` owns the socket lifecycle and low-level RPC (`ClusterClient`).
- `bus.ts` owns the messaging semantics (register, send, broadcast, events).
- Keeps both files under ~150 lines each.
- Agent code imports only `bus.ts`; never touches `ClusterClient` directly
  for messaging.

### Usage Example

```typescript
import { connectBus } from "./bus.js";

// After obtaining a FollowerHandle from embedding-service.ts:
const bus = await connectBus(handle.client, "agent-alice", ["public", "gm"]);

bus.onMessage((msg) => {
  console.log(`[${msg.from}] ${msg.payload}`);
});

bus.onPresence((evt) => {
  console.log(`${evt.agentId} ${evt.status}`);
});

await bus.broadcast({ text: "大家好，我是 Alice" });
await bus.send("agent-bob", { text: "Bob，你昨晚在哪？" });
```

## File Changes

| file                    | change                                              |
|-------------------------|-----------------------------------------------------|
| `protocol.ts`           | ✅ Add `ClusterPush` type, `ClusterMessage` union, `isPush()`, bus RPC param types, push payload types. Protocol version → 2. |
| `leader.ts`             | ✅ Route table (`Map<agentId, ConnectedAgent>`), `register`/`send`/`broadcast`/`subscribe` handlers, `presence` broadcasts, connection cleanup. |
| `follower.ts`           | ✅ `handleIncoming()` with `isPush()` dispatch, `onPush()` API, `ClusterClient` exported, `FollowerHandle.client` field. |
| `bus.ts` (new)          | ✅ `connectBus()` → `BusHandle`. Event buffering during register + nextTick flush. |
| `embedding-service.ts`  | No change (embedding RPC continues as before)       |
| `socket.ts`             | No change (single socket, single lock)              |

Additional behaviors implemented:
- `register` auto-subscribes `public` + `private:{agentId}`.
- Late joiner receives `presence:joined` for all existing agents on register.
- `connectBus` buffers push events during register, flushes on `nextTick` so
  caller can register handlers synchronously after `await connectBus(...)`.

## Backward Compatibility

- `register` is optional; unregistered connections still work for `ping`/`embed`.
- Existing embedding RPC is completely unchanged.
- Bus features are additive — agents that don't call `register` simply don't
  participate in messaging.

## Game Integration: Murder Mystery

The message bus is designed to support multi-agent scenarios like a murder
mystery game. This section describes how the bus connects to actual agent
conversations.

### Architecture Layers

```
┌─────────────────────────────────┐
│  pi-coding-agent (对话层)        │  agent 的 LLM 对话: system prompt + user messages + tool calls
│  每个 agent 是一个独立的 pi 会话   │
├─────────────────────────────────┤
│  mono-pilot extension (编排层)   │  hooks, tools, session lifecycle
├─────────────────────────────────┤
│  cluster message bus (通信层)    │  send / broadcast / onMessage (已完成)
└─────────────────────────────────┘
```

通信层已就绪。**缺失的是通信层与对话层之间的桥。**

### GM (Game Master) 角色

初期由人类手动担任 GM，通过 CLI 工具连接 bus 发消息。好处：
- 完全可控，随时调整节奏
- 能观察每一步发生了什么
- 不需要额外的 GM agent 逻辑

后期可以将 GM 逻辑迁移到一个专用 agent session，实现自动编排。

### 消息桥接方案（bus ↔ agent 对话）

**入方向（bus → agent LLM）**：
- `input` hook 在每轮对话前检查待处理的 bus 消息
- 将消息拼入 user message envelope，例如：
  ```
  [来自 Alice] 我昨晚一直在图书馆看书
  [来自 GM] 有人看到你 10 点出现在花园附近，你怎么解释？
  ```
- Agent 看到这些消息后自然产生回复

**出方向（agent LLM → bus）**：
- 提供 `bus_send` tool，agent 调用来发送消息
- System prompt 告诉 agent 游戏规则 + 用 `bus_send` 发言

### 最小可玩流程

```
1. GM (人) → broadcast:  "第一幕：昨晚花园里发生了一起谋杀。每人陈述昨晚的行踪。"
2. Alice 收到 → LLM 思考 → bus_send: "我昨晚一直在图书馆看书"
3. Bob   收到 → LLM 思考 → bus_send: "我在厨房准备晚餐"
4. GM    → send(alice):  "有人看到你 10 点出现在花园附近" (私聊线索)
5. Alice → bus_send:     "那时我去花园透气了一下，很快就回来了"
6. GM    → broadcast:    "现在开始投票，你们认为谁是凶手？"
7. 各 agent 投票...
```

### 实现计划

| 序号 | 组件 | 说明 | 状态 |
|------|------|------|------|
| 1 | `bus_send` tool | Agent 用来发消息到 bus。参数: `to?`, `channel?`, `message`。注册到 mono-pilot.ts | ⬜ |
| 2 | 消息注入 hook | `input` hook 中检查 bus 消息队列，拼入 user message | ⬜ |
| 3 | GM CLI | 独立脚本，连接 bus，stdin 读命令，支持 `/send alice ...` `/broadcast ...` | ⬜ |
| 4 | 角色 system prompt | 每个 agent 的角色设定 + 游戏规则 + bus_send 使用说明 | ⬜ |

实现顺序: 3 → 1 → 2 → 4（先有 GM 能发消息，再让 agent 能收到和回复）

### Open Questions

1. **消息格式**: 自由 JSON 还是约定 `{ text: string, metadata?: ... }` schema?
2. **回合控制**: Agent 是收到消息就立即回复，还是等 GM 显式指令？
3. **消息持久化**: 是否需要 `messages.jsonl` 落盘 + `replay` 机制？初期可能不需要。
4. **Agent 启动顺序**: 先启动所有 agent 再开始游戏？还是允许中途加入？
5. **多轮对话上下文**: Bus 消息注入后，agent 的对话历史会自然积累。是否需要额外的记忆管理？