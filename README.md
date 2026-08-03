# Nexa UI

TypeScript/TSX 跨平台原生 UI 工具包：通过 Perry AOT 编译为机器码，由 Rust Native UI Core + Skia 自绘，不依赖 WebView / Chromium。

> 架构决策见 [ADR-004](docs/decisions/ADR-004-framework-adapters-native-host-mvp.md)。

## 开发原则

```text
架构设计：顶层向下（先定 Counter.tsx 验收契约）
核心实现：底层向上（先纯 Rust 窗口 / 节点 / 绘制）
产品推进：垂直切片（一条链路打通再加宽）
```

当前主线：**Slice 5 已落地（Solid Adapter）→ 下一步按需扩展 Vue / 布局 playground**。

## 仓库结构

```text
crates/           Rust Native UI Core + 平台 / 渲染 / 布局 / Perry Bridge
packages/         Minimal TSX (@nexa/ui) 与框架 Adapter（多数延后）
examples/         验收 Demo（rust-counter / counter TSX / todo…）
docs/decisions/   ADR
.github/workflows CI（按路径与切片门禁）
```

## 快速开始

### 前置

- Rust stable（`rustfmt` + `clippy`）
- Node ≥ 22、pnpm ≥ 9
- 首次编译会下载 `skia-safe` 预编译二进制，可能较慢

### Slice 5 验收（Solid Adapter）

```bash
cd examples/solid-counter
pnpm build
./solid-counter
```

验收：标准 Solid `createSignal` Counter；`Show` / `For` 局部更新 Host；无 DOM。JSX 经 `babel-preset-solid`（universal）预编译后再交给 Perry。

### Slice 4 验收（Todo + Taffy + Scroll）

```bash
cd examples/todo
perry compile main.tsx -o todo
./todo
```

验收：Add / Done / Remove 动态增删列表；滚轮滚动 Scroll 视口；布局走 Taffy。

### Slice 3 验收（Minimal TSX）

```bash
# 需要本机安装 Perry：npm i -g @perryts/perry（并装好平台包）
cd examples/counter
perry compile main.tsx -o counter
./counter
```

验收：TSX 经 `@nexa/ui` mount → Host；点击 Increment 只 `setText`，不重建整棵树。
响应式写法：`<Text>Count: {count}</Text>`（传 signal，不要写 `count.value`）。

### Slice 2 验收（Perry Host FFI）

```bash
# 需要本机安装 Perry：npm i -g @perryts/perry（并装好平台包）
cd packages/nui-host && cargo build --release
cd ../../examples/perry-counter
perry compile main.ts -o perry-counter
./perry-counter
```

验收：TS 命令式 Host API 创建节点；点击 Increment 走 Rust→Perry 回调并更新 Text。

### Slice 1 验收

```bash
# 离屏：布局 + 绘制 + 模拟点击 Increment
cargo run -p rust-counter -- --smoke

# 打开窗口：点击 Increment，Count 应递增；缩放应重新布局
cargo run -p rust-counter
```

### Slice 0 回归

```bash
# Hello 帧仍可通过库函数验证（单元测试覆盖）
cargo test -p nui-render-skia
```

### 其他命令

```bash
cargo check --workspace
cargo test --workspace
pnpm install && pnpm typecheck && pnpm format:check
```

## 垂直切片路线

| Slice | 目标          | 验收                             |
| ----: | ------------- | -------------------------------- |
|     0 | 静态窗口      | winit + Skia 显示文字 / 圆角矩形 |
|     1 | Rust Counter  | 纯 Rust 点击更新 Text            |
|     2 | Perry 驱动    | TS 经 FFI 调用 Host              |
|     3 | Minimal TSX   | `examples/counter` 可运行        |
|     4 | Todo + 布局   | 动态列表 / Taffy / Scroll        |
|     5 | Solid Adapter | 不经 DOM 驱动同一 Host           |

首个效果出来之前，不要并行做多框架 Adapter、完整 CSS、移动端、DevTools、组件库。

## CI 设计

见 [`.github/workflows/README.md`](.github/workflows/README.md)。

## 许可证

MIT OR Apache-2.0
