# ADR-012: 文件系统 Task、Promise Await 与事件循环唤醒 v1

- 状态：Accepted（Desktop Notes MVP）
- 日期：2026-08-07
- 依赖：ADR-006、ADR-007、ADR-010、ADR-011
- 实现任务：G4-05

## 背景

G4-01～G4-04 已经定义 generation-bearing Task、worker completion queue、结构化
`NexaError` 和 manifest permission，但还没有一条能够让 TypeScript Promise 真正
settle 的生产链。文件读写如果直接在 FFI 函数中同步执行，会阻塞 UI 线程；如果只
把 worker 结果放入队列而不唤醒 winit，也会在窗口空闲时永久停留在队列中。

原子保存还存在一个竞态：临时文件已经 flush/sync 并完成 rename 后，取消请求可能
仍然到达。此时写入已经对外可见，不能再把成功写入报告成 `CANCELLED`。

## 决策

### 1. System protocol 扩展

在现有稳定 ID 后追加 `system.FsRead`、`system.FsWrite` permission，追加
`ReadTextFile`、`WriteTextFile` 和内部传输命令 `AwaitTask`，追加对应的
`ReadTextFile`/`WriteTextFile` TaskKind，并追加 `INVALID_DATA` error code；既有 ID
不重排。

两个 start FFI 只做参数/权限校验和 non-blocking task submit，返回
`nexa_result_json_v1` 编码的 `HandleRef`。`AwaitTask` 不提供字符串化通用
`invoke` API，只接收 Task handle 并返回 `promise<string>`；Promise resolved string
始终是 `nexa_result_json_v1`，业务成功和可恢复失败由同一个 decoder 处理。

### 2. Task settlement 与 winit wakeup

System Host 持有进程内 TaskRuntime 与 task-result/awaiter registry。worker 只能把
结果送入 `Dispatcher::System`；`HostWindowApp::tick` 只在
`TickPhase::SystemCompletion` 调用 completion hook，并以当前 scheduler phase 作为
settlement 证明。hook 不能从 Framework 或 worker 线程直接 resolve Promise。

Dispatcher 从 idle 变为 pending 时通过 winit `EventLoopProxy` 发送无业务含义的
user event，唤醒 `about_to_wait` 后继续正常 tick。owner close/reset 先建立 terminal
fence，再取消 token；迟到 completion 只能进入 tombstone/drop 计数，不能触达
Perry/Framework。

### 3. Atomic write cancellation linearization

FS Core 使用同目录唯一临时文件，依次执行 write、flush、`sync_all`，然后在 rename
前唯一一次调用 `try_begin_commit`。cancel 先赢则删除临时文件并返回 `CANCELLED`；
commit 先赢则执行 atomic replace，之后的 cancel 是 no-op；rename 失败映射为
`NOT_FOUND`、`INVALID_DATA` 或 `PLATFORM_FAILURE`，不伪装成取消。rename 成功是对外
可见的线性化点。backend 可注入，读写只接受 UTF-8。

### 4. TypeScript API

`@nexa/fs` 只暴露 typed functions：

```ts
export type Task<T> = {
  readonly id: TaskId;
  readonly result: Promise<T>;
  cancel(): void;
};

export function readTextFile(path: string): Task<string>;
export function writeTextFile(path: string, text: string): Task<void>;
```

路径和文本在 FFI 边界转换；错误由 `NexaSystemError` 保留 `NOT_FOUND`、
`INVALID_DATA`、`PERMISSION_DENIED`、`CANCELLED` 和 `PLATFORM_FAILURE` 的区别。

## 验收标准

1. protocol/schema/generated outputs、canonical permission table 与 app manifest enum
   exact-set 一致并有 drift test。
2. UTF-8 read/write、missing file、invalid UTF-8、atomic replace、temp cleanup 和
   cancel/commit race 有 deterministic integration tests。
3. worker 不在 UI 线程执行阻塞 I/O；completion 只在 `SystemCompletion` settle；空闲
   winit 窗口在 worker 完成后能被唤醒；Promise 只 settle 一次。
4. rename 成功后取消不会产生 `CANCELLED`；owner close 后迟到结果不会进入
   Framework。
5. `@nexa/fs` typecheck、contract tests、Rust strict Clippy 和 locked checks 通过。

## 边界

目录 scope、symlink policy、文件 watcher、编码自动探测和 native OS 对话框不属于
本 ADR；detached worker 不能持有 UI/Framework/Skia 引用，也不能在 owner terminal
fence 后触达 Promise。
