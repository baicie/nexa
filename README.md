# Nexa UI

TypeScript/TSX 跨平台原生 UI 工具包：通过 Perry AOT 编译为机器码，由 Rust Native UI Core + Skia 自绘，不依赖 WebView / Chromium。

> 架构决策见 [ADR-004](docs/decisions/ADR-004-framework-adapters-native-host-mvp.md)、[ADR-005](docs/decisions/ADR-005-system-host-permissions-plugins.md)、[ADR-006](docs/decisions/ADR-006-application-runtime-composition-p0.md)。

## 开发原则

```text
架构设计：顶层向下（先定 Counter.tsx 验收契约）
核心实现：底层向上（先纯 Rust 窗口 / 节点 / 绘制）
产品推进：垂直切片（一条链路打通再加宽）
```

当前主线：**ADR-006 P0 契约已归档**（App Runtime / 文本管线 / 语义 / Platform View）。实现上仍推进垂直切片；勿在 Layout/Paint 或无文本协议下堆功能。

## 仓库结构

```text
crates/           Rust：NUI / System / Text / App Runtime / 平台 / Bridge
packages/         Minimal TSX、Host FFI、System Host、框架 Adapter
examples/         各切片验收 Demo + framework-parity
docs/decisions/   ADR-004 … ADR-006
.github/workflows CI（按路径与切片门禁）
```

## 快速开始

### 前置

- Rust stable（`rustfmt` + `clippy`）
- Node ≥ 22、pnpm ≥ 9
- Perry CLI（平台包齐全）
- 首次编译会下载 `skia-safe` 预编译二进制，可能较慢

### 框架 Counter 一览

| 框架 | 目录 | 命令 |
|------|------|------|
| Minimal TSX | `examples/counter` | `perry compile main.tsx -o counter` |
| Solid | `examples/solid-counter` | `pnpm build` |
| Vue 3 | `examples/vue-counter` | `perry compile main.ts -o vue-counter` |
| React | `examples/react-counter` | `perry compile main.tsx -o react-counter` |
| Svelte | `examples/svelte-counter` | `perry compile main.ts -o svelte-counter` |
| Layout | `examples/layout-playground` | `perry compile main.tsx -o layout-playground` |
| Image | `examples/image-demo` | `cd examples/image-demo && pnpm start` |
| Clipboard | `examples/clipboard-demo` | `cd examples/clipboard-demo && pnpm start` |

对照清单见 [examples/framework-parity](examples/framework-parity/README.md)。

### Slice 4 Todo

```bash
cd examples/todo && perry compile main.tsx -o todo && ./todo
```

### Rust / Host 回归

```bash
cargo run -p rust-counter -- --smoke
cargo test --workspace
```

### 其他命令

```bash
pnpm install && pnpm typecheck && pnpm format:check
```

## 垂直切片路线

| Slice | 目标 | 状态 |
| ----: | ---- | ---- |
| 0 | 静态窗口 | 完成 |
| 1 | Rust Counter | 完成 |
| 2 | Perry Host FFI | 完成 |
| 3 | Minimal TSX | 完成 |
| 4 | Todo + Taffy + Scroll | 完成 |
| 5 | Solid Adapter | 完成 |
| 6 | Vue 3 Adapter | 完成 |
| 7 | React Adapter | 完成 |
| 8 | Svelte compiler backend | 完成（Counter 子集 runtime） |
| 9 | Input（单行） | 完成（Host focus + IME/键盘 + Todo） |
| 10 | ADR §11 复合组件 | 完成（Stack / Spacer / Card + flexGrow/align） |
| 11 | Image（本地） | 完成（set_image + Skia decode/paint + image-demo） |
| 12 | System Host + Clipboard | 完成（ADR-005、`@nexa/clipboard`） |
| — | ADR-006 P0 契约 | 完成（文档 + `nui-text` / `nui-app-runtime` 骨架 + Semantics） |

## 刻意未做（ADR）

完整 HarfBuzz 文本 / AccessKit 桥 / Task cancel 产品化 / Surface 重建 / PlatformView / Image 网络 / TextArea / fs·dialog 完整面 / 通知托盘 / 移动端。

架构决策见 [ADR-004](docs/decisions/ADR-004-framework-adapters-native-host-mvp.md)、[ADR-005](docs/decisions/ADR-005-system-host-permissions-plugins.md)、[ADR-006](docs/decisions/ADR-006-application-runtime-composition-p0.md)。

## CI 设计

见 [`.github/workflows/README.md`](.github/workflows/README.md)。

## 许可证

MIT OR Apache-2.0
