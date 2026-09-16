# Pi Pocket 桥接协议

pi 终端（TUI）与 Pi Pocket 之间唯一的通信契约。两侧实现：`extensions/pi-pocket-bridge.ts`（pi 侧）
和 `src/tui-hub.mjs`（服务端）。改协议必须同时改这两处，并跑 `npm run check:sync`。

## 为什么需要它

**问题**：默认情况下，终端里的 pi 和 Pi Pocket 各自 spawn 一个 pi 进程去操作同一个会话文件。
两个进程各有各的内存消息列表，互不知情 —— 手机能看到完整的（因为它每次从文件重读并重建），
而终端 TUI 只显示自己那之后的消息，用户的原始提问对它不可见。

**解法**：一个会话只保留**一个** agent 进程（终端里那个），其余全部作为客户端连上它：

```
                ┌───────────────────────────┐
   终端 TUI ──── │  pi 进程（唯一 agent）      │
   （原生 UI）    │   └ pi-pocket-bridge 扩展  │
                └───────────┬───────────────┘
                           │ WebSocket :8788
                    ┌──────┴───────┐
                    │  Pi Pocket   │
                    │  服务 8787   │
                    └──────┬───────┘
                           │ WebSocket
                    手机 / 其它浏览器
```

终端 UI 由 pi 自己渲染（不受影响），手机通过桥接读事件流 + 发消息，两边看到的是
同一个 agent 的同一份状态。

## 传输

- **单向监听**：扩展在 `127.0.0.1` 上起 WebSocket 服务端，默认端口 **8788**
  （可用环境变量 `PI_POCKET_BRIDGE_PORT` 覆盖）。
- 只绑定回环地址，不对外暴露。
- 帧格式：JSON 文本帧，一行一个对象。

## 扩展 → 服务端（事件）

```jsonc
// 扩展启动后立即发送，服务端据此判断是否可桥接
{ "t": "hello", "v": 1, "sessionId": "01a0...", "sessionFile": "/path/x.jsonl",
  "cwd": "/Users/you/proj", "mode": "tui", "pid": 12345,
  "model": "anthropic/claude-sonnet-4-5", "thinkingLevel": "medium",
  "isIdle": true, "sessionName": "可选" }

// 原样转发 pi 的会话事件（类型见 pi 的 AgentSessionEvent）
{ "t": "event", "event": { "type": "message_update", "...": "..." } }

// 客户端一接入就主动推送的完整历史（与服务端请求的 history 应答二选一，
// 服务端两边都要能处理）
{ "t": "history", "entries": [ /* SessionEntry[] */ ] }

// agent 空闲状态变化（服务端用来决定 UI 上显示"生成中/空闲"）
{ "t": "status", "isIdle": false }

// 出错
{ "t": "error", "message": "..." }
```

`event` 里的类型与 Pi Pocket 现有前端处理的事件完全一致（因为服务端就是把 pi 的事件
原样转发），前端无需区分"桥接会话"和"spawn 会话"。

## 服务端 → 扩展（命令）

```jsonc
// 发一条用户消息；会触发一个 turn
{ "id": "c1", "t": "prompt", "message": "你好" }
// 生成中插话
{ "id": "c2", "t": "steer", "message": "换个方向" }
// 中止当前 turn
{ "id": "c3", "t": "abort" }
// 取历史（扩展回复 history，用于首次连接时回填）
{ "id": "c4", "t": "history" }
// 改会话名
{ "id": "c5", "t": "set_name", "name": "重构 auth" }
// 切换模型 / 思考等级
{ "id": "c6", "t": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-5" }
{ "id": "c7", "t": "set_thinking", "level": "high" }
// 让 pi 自己处理一个斜杠命令（如 /compact、/reload）
{ "id": "c8", "t": "command", "text": "/compact" }
```

## 扩展 → 服务端（回复）

```jsonc
{ "id": "c1", "ok": true }                              // 成功
{ "id": "c4", "ok": true, "entries": [ /* SessionEntry[] */ ] }
{ "id": "c3", "ok": false, "error": "没有正在运行的任务" }  // 失败
```

## 服务端判定逻辑

对每个会话：

1. 若桥接可用（8788 有响应且 `sessionFile` 与本会话相同）→ **attach 方式**：
   历史、事件、发消息全部走桥接，不 spawn 任何 pi 进程。
2. 否则 → 回退到现有 spawn 方式（`pi --mode rpc`），功能不变。

桥接可用性在打开会话时探测一次，结果缓存；桥接断开时通知前端并提示可切回独立进程。

## 已知限制

- 桥接只在**终端里以 TUI 模式运行 pi 且加载了该扩展**时可用。
- 端口固定，同时只能有一个 pi 实例提供桥接（第二个实例启动时会探测到端口被占用，
  此时它不做桥接，继续走 spawn 回退）。
- `pi -p`（print 模式）下扩展也能加载，但没有交互界面，桥接意义不大。
