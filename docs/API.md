# Public API Index

本页索引 Desktop Technical Preview 当前公开的 TypeScript surface。Native Host FFI 与 `@nexa/system-host` 属于底层实现边界；应用优先使用 `@nexa/ui`、`@nexa/fs`、`@nexa/dialog` 和 `@nexa/clipboard`。

## `@nexa/ui`

### Runtime

| API                       | 说明                                            |
| ------------------------- | ----------------------------------------------- |
| `mount(root)`             | 建立新 Host session，提交根树并进入原生事件循环 |
| `signal(initial)`         | 创建带 `.value` 的细粒度响应式状态              |
| `effect(fn)`              | 追踪读取的 signal，并在变化后重新执行           |
| `onCleanup(fn)`           | 注册当前 effect 的清理函数                      |
| `isSignal(value)`         | 判断值是否为 Nexa signal                        |
| `For({ each, children })` | 按数组增删原生节点的列表 primitive              |

### Primitives

| 类别     | API                                                            |
| -------- | -------------------------------------------------------------- |
| 根与布局 | `Window`, `Column`, `Row`, `Stack`, `View`, `Scroll`           |
| 组合     | `Card`, `Spacer`                                               |
| 内容     | `Text`, `Image`                                                |
| 交互     | `Button`, `Input`, `TextArea`                                  |
| 语义     | `SemanticRole`, `SemanticAction`, `Semantics`, `SemanticsProp` |

通用布局属性包括 `width`、`height`、`flexGrow`、`padding`、`gap`、`alignItems`、`justifyContent`、`backgroundColor`、`borderRadius`、`style` 与 `semantics`。布局和样式使用 typed numeric values，不解析 CSS。

`Input` 支持 `value`、`placeholder`、`disabled`、`onChange`、`onSubmit`、`onComposition`；`TextArea` 支持多行 value、`onChange` 与 `onComposition`。两者都支持 `Signal<string>` 和显式 semantics。

### Theme

| API                      | 说明                                            |
| ------------------------ | ----------------------------------------------- |
| `rgba(r, g, b, a?)`      | 编码 Host 使用的 `0xRRGGBBAA` uint32 color      |
| `defaultTheme`           | 默认 Window、Card、Text、Button、Input 主题     |
| `createTheme(overrides)` | 从 colors/spacing/radii/typography 覆盖生成主题 |

公开类型包括 `ColorToken`、`ViewStyle`、`TextStyle`、`Style`、`ThemeTokens`、`ThemeOverrides` 与 `Theme`。

## Typed Task

FS、Dialog 和 Clipboard API 都立即返回一个 Task；原生完成结果通过 `result` Promise 交付：

```ts
type Task<T> = {
  readonly id: { slot: number; generation: number };
  readonly result: Promise<T>;
  cancel(): void;
};
```

每个 Task 只有一次结果 Promise，`cancel()` 幂等。owner/window 关闭后，Task 进入 terminal 状态，迟到 completion 不再进入应用。

## `@nexa/fs`

| API                         | 权限             | 结果           |
| --------------------------- | ---------------- | -------------- |
| `readTextFile(path)`        | `system.FsRead`  | `Task<string>` |
| `writeTextFile(path, text)` | `system.FsWrite` | `Task<void>`   |

文件内容必须是 UTF-8。写入使用同目录临时文件和原子 replace；取消与最终 commit 通过 native runtime 线性化。

## `@nexa/dialog`

| API                 | 权限                | 结果               |
| ------------------- | ------------------- | ------------------ |
| `openFile(options)` | `system.DialogOpen` | `DialogTask<string | null>` |
| `saveFile(options)` | `system.DialogSave` | `DialogTask<string | null>` |

`FileDialogOptions` 支持 `title`、`defaultPath` 和 `filters`；每个 filter 包含显示名与 extension 列表。用户取消解析为 `null`。

当前 `rfd::FileDialog` native backend 只暴露 selected path 或 `None`，没有真实 `PLATFORM_FAILURE` 返回分支。Task cancel/owner invalidation 终止结果交付，但不能主动关闭已显示的 picker。

## `@nexa/clipboard`

| API               | 权限                    | 结果           |
| ----------------- | ----------------------- | -------------- |
| `readText()`      | `system.ClipboardRead`  | `Task<string>` |
| `writeText(text)` | `system.ClipboardWrite` | `Task<void>`   |

## 错误合同

System Task 失败会 reject 为保留完整 native detail 的 `NexaSystemError`。稳定错误名包括：

```text
INVALID_ARGUMENT  INVALID_KIND      WRONG_OWNER
STALE_HANDLE      INVALID_STATE     NOT_FOUND
PERMISSION_DENIED CANCELLED         PLATFORM_FAILURE
INVALID_DATA      INTERNAL_FAILURE
```

错误对象保留 `domain`、numeric `code`、`severity`、`operation`、`retryable`、`context`、可选 `platformCode` 与递归 `cause`。应用逻辑应按稳定 code/name 分支，不解析 message 文本。

## Framework Adapters

| Package                 | 当前 surface                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `@nexa/adapter-solid`   | **Tier-1 public** Solid universal renderer、`render`、JSX runtime 与常用 Solid primitives |
| `@nexa/adapter-vue`     | Private candidate：Vue 3 custom renderer、`createApp`、`render`、`h`                      |
| `@nexa/adapter-react`   | Private candidate：React reconciler、`createRoot`、`render` 与常用 React API              |
| `@nexa/compiler-svelte` | Private candidate：`compileToHost` 与 Counter 子集 runtime                                |

`@nexa/adapter-solid` 是唯一的 Tier-1 外部框架路径，作为九包 Technical Preview
release train 的公开成员。`tools/solid-notes-e2e.test.mjs` 覆盖其 Notes 核心
切片的语义编辑、保存和 dispose；`tools/release-packages.test.mjs` 约束其
`dist`/types/JSX exports。Minimal TSX 仍是文档与 Desktop Notes MVP 的参考路径。
Vue、React 和 Svelte 的现有合同/AOT 证据不构成公开或 Tier-1 承诺。

## 权威源码

- UI exports：[`packages/ui/src/index.ts`](../packages/ui/src/index.ts)
- FS：[`packages/fs/src/index.ts`](../packages/fs/src/index.ts)
- Dialog：[`packages/dialog/src/index.ts`](../packages/dialog/src/index.ts)
- Clipboard：[`packages/clipboard/src/index.ts`](../packages/clipboard/src/index.ts)
- Manifest schema：[`protocol/schema/app-manifest.schema.json`](../protocol/schema/app-manifest.schema.json)
