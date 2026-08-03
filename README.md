# Nexa UI

TypeScript/TSX 跨平台原生 UI 工具包：通过 Perry AOT 编译为机器码，由 Rust Native UI Core + Skia 自绘，不依赖 WebView / Chromium。

> 架构决策见 [ADR-004](docs/decisions/ADR-004-framework-adapters-native-host-mvp.md)。

## 开发原则

```text
架构设计：顶层向下（先定 Counter.tsx 验收契约）
核心实现：底层向上（先纯 Rust 窗口 / 节点 / 绘制）
产品推进：垂直切片（一条链路打通再加宽）
```

当前主线：**Slice 0 已落地（静态窗口）→ 下一步 Slice 1（Rust Counter）**。

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

### Slice 0 验收

```bash
# 离屏一帧（CI / 无显示环境）
cargo run -p rust-counter -- --smoke

# 打开原生窗口：圆角矩形 + “Hello Nexa UI”
cargo run -p rust-counter
```

手动验收：窗口显示蓝色圆角色块与白色文字；缩放窗口应触发重绘。

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
