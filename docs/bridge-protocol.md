# Pi Pocket 桥接协议

pi 终端（TUI）与 Pi Pocket 之间唯一的通信契约。两侧实现：
`extensions/pi-pocket-bridge.ts`（pi 侧）和 `src/bridge-client.mjs` / `src/tui-hub.mjs`（服务端）。
改协议必须同时改这几处，并跑 `npm run check:bridge`。

## 为什么需要它

**问题**：默认情况下，终端里的 pi 和 Pi Pocket 各自 spawn 一个 pi 进程去操作同一个会话文件。
两个进程各有各的内存消息列表，互不知情 —— 手机能看到完整历史（因为它重读会话文件重建），
而终端 TUI 只显示自己那之后的消息，用户在手机上发的消息它根本看不见。
同时两个进程写同一个文件，还可能互相覆盖。

**解法**：一个会话只保留**一个** agent 进程（终端里那个），其余全部作为客户端连上它：

```
                ┌───────────────────────────┐
   终端 TUI ──── │  pi 进程（唯一 agent）     │
   （原生 UI）    │   └ pi-pocket-bridge 扩展  │
                └───────────┬───────────────┘
                           │ Unix socket（每个 pi 一个）
                    ┌──────┴───────┐
                    │  Pi Pocket   │
                    │  服务 8787   │
                    └──────┬───────┘
                           │ WebSocket
                    手机 / 其它浏览器
```

终端 UI 由 pi 自己渲染（不受影响），手机通过桥接读事件流 + 发消息，两边看到的是
同一个 agent 的同一份状态。

## 传输：为什么是 Unix socket 而不是固定端口

最初用固定端口 8788，**实践中直接失败**：

- 端口是先到先得。同时开着几个 pi 时，只有最先启动的能占住，而它往往不是你当前
  正在用的那个会话。
- Pi Pocket 自己 spawn 的 rpc 进程也会去抢端口，而且抢到之后很快就退出 ——
  结果是「你想同步的那个会话反而连不上」。

现在每个 pi 实例各自监听：

```
<agentDir>/pi-pocket-bridge/<pid>.sock      # agentDir 默认 ~/.pi/agent
```

服务端**扫描该目录**，逐个读 `hello`，于是能按**会话文件**精确匹配到
「哪个 pi 正在跑这个会话」，与启动顺序完全无关。多个 pi 可以同时提供桥接。

服务端自己 spawn 的 rpc 进程带 `PI_POCKET_AGENT=1` 且 `mode === "rpc"`，不提供桥接
（服务端已经直连它的 stdin/stdout，再开 socket 只会造成混乱）。

### 自愈

Unix socket 是**文件**，任何外部因素都可能把它删掉（清理临时目录、脚本 `rm -rf`、
tmpfiles 之类）。文件没了但进程还占着 fd 时，外部连接会直接 `ENOENT` ——
现象是「手机莫名退回独立进程、两端不同步」，而且**完全看不出原因**。

因此扩展每 20 秒检查一次 socket 文件是否还在（`session_start` 时也检查），
不在就重建监听。

## 帧格式

JSON 文本帧，一行一个对象。

## 扩展 → 服务端（事件）

```jsonc
// 扩展就绪后，每个新连接都会先收到它
{ "t": "hello", "v": 1, "sessionId": "01a0...", "sessionFile": "/path/x.jsonl",
  "cwd": "/Users/you/proj", "mode": "tui", "pid": 12345,
  "model": "anthropic/claude-sonnet-4-5", "thinkingLevel": "medium",
  "isIdle": true, "sessionName": "可选", "socket": "/path/to/<pid>.sock" }

// 完整历史（新连接立刻收到，手机端据此重建界面）
{ "t": "history", "entries": [ /* SessionEntry[] */ ] }

// 原样转发 pi 的会话事件，类型见下表
{ "t": "event", "event": { "type": "message_update", "...": "..." } }

// agent 空闲状态变化
{ "t": "status", "isIdle": false }

// 出错
{ "t": "error", "message": "..." }
```

转发的事件类型（`FORWARD` 集合）：

```
agent_start  agent_end  agent_settled
turn_start   turn_end
message_start  message_update  message_end
tool_execution_start  tool_execution_update  tool_execution_end
```

> 注意：`queue_update` / `compaction_start` / `compaction_end` / `auto_retry_*`
> **不是 pi 扩展事件**（它们只存在于 RPC 事件流），不要往这里加。

`event` 里的结构与 Pi Pocket 前端处理的事件完全一致（服务端原样转发），
所以前端不需要区分「桥接会话」和「独立进程会话」。

## 服务端 → 扩展（命令）

```jsonc
{ "id": "c1", "t": "prompt",    "message": "你好" }   // 发消息，会触发一个 turn
{ "id": "c2", "t": "steer",     "message": "换个方向" } // 生成中插话
{ "id": "c3", "t": "follow_up", "message": "做完再看这个" }
{ "id": "c4", "t": "abort" }                          // 中止当前 turn
{ "id": "c5", "t": "history" }                        // 取历史
{ "id": "c6", "t": "set_name",     "name": "重构 auth" }
{ "id": "c7", "t": "set_thinking", "level": "high" }
{ "id": "c8", "t": "get_commands" }                   // 列出斜杠命令
```

生成中（`isIdle === false`）发 `prompt` 会自动降级为 `steer`，否则会被 pi 拒绝。

不在白名单里的命令返回 `{ ok: false, error: "..." }`，不会静默失败。

## 扩展 → 服务端（回复）

```jsonc
{ "id": "c1", "ok": true }                                  // 成功
{ "id": "c5", "ok": true, "entries": [ /* ... */ ] }        // history 的应答
{ "id": "c4", "ok": false, "error": "没有正在运行的任务" }   // 失败
```

主动推送的历史用 `{ t: "history" }`，应答请求用 `{ id, ok, entries }`，服务端两种都要处理。

## 进程级单例（/reload 必须考虑）

`/reload` 会重新加载扩展模块、**创建新的扩展实例，但不销毁旧实例**（旧的事件订阅仍然活着）。
如果把 socket 服务建在实例里，reload 后就会出现「服务归旧实例、事件处理器在新实例」的错位 ——
表现是 `hello` / `history` 正常但**事件全丢**，极难排查（踩过一次）。

因此 socket 服务与客户端集合挂在 `globalThis.__piPocketBridgeCore` 上：

- 新实例发现已有 core，就把 `emit` / `getHello` / `getHistory` / `handleCommand`
  重新绑定到自己，不再重复监听 socket；
- `session_shutdown` 在 `reason === "reload"` / `"new"` / `"resume"` / `"fork"` 时
  **不能**关闭服务，只有真正退出（`quit`）才清理。

## 服务端判定逻辑

对每个会话：

1. `findBridgeForSession()` 扫描 socket 目录，按**会话文件路径**精确匹配。
2. 匹配到 → **bridge 模式**：历史、事件、发消息全部走桥接，不 spawn 任何 pi 进程。
3. 没匹配到 → 回退到 **resume / copy / new**（spawn `pi --mode rpc`）。
4. 回退时若检测到终端里有 pi 在跑（`terminalPiCount() > 0`），在会话上带一条
   `warning`，手机端显示成横幅解释「为什么两端不同步」以及怎么处理。

## 已知限制

- 桥接只在终端以 **TUI 模式**运行 pi 且加载了该扩展时可用。
- 终端用 `--no-session` 启动时没有会话文件，无法对应到具体会话，桥接不生效。
- 扩展与 pi 的 node_modules 解析路径不同（扩展经 jiti 加载），所以**不能用任何 npm 依赖** ——
  WebSocket 服务端是用 `node:http` 手写的（文本帧 / ping-pong / 分片）。
