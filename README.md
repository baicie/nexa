# Nexa UI

TypeScript/TSX 跨平台原生 UI 工具包：通过 Perry AOT 编译为机器码，由 Rust Native UI Core + Skia 自绘，不依赖 WebView / Chromium。

> 架构决策见 [ADR-004](docs/decisions/ADR-004-framework-adapters-native-host-mvp.md)、[ADR-005](docs/decisions/ADR-005-system-host-permissions-plugins.md)、[ADR-006](docs/decisions/ADR-006-application-runtime-composition-p0.md)、[ADR-007](docs/decisions/ADR-007-protocol-handle-error-v1.md)、[ADR-008](docs/decisions/ADR-008-typescript-aot-scriptc-vs-perry.md)、[ADR-009](docs/decisions/ADR-009-text-pipeline-dependency-spike.md)。

## 开发原则

```text
架构设计：顶层向下（先定 Counter.tsx 验收契约）
核心实现：底层向上（先纯 Rust 窗口 / 节点 / 绘制）
产品推进：垂直切片（一条链路打通再加宽）
```

当前主线：**Desktop Notes MVP / Desktop Technical Preview**。G0-G4 已落地；G5 的 Notes Shell、五个稳定语义节点、基础 Theme 与 CLI `new`/`dev`/`build`/`package`/`doctor` 已实现。`@nexa/adapter-solid` 已选为唯一 Tier-1 外部 Adapter：Solid Notes 核心切片的语义编辑、保存与生命周期释放通过本地 E2E，并进入九包公开 release train。通用 create-to-package Perry AOT/link smoke 已在本地 macOS 通过。无 fixture 的 real-picker probe 与双阶段 package workflow 已配置并 fail closed；本机 macOS 因 Accessibility 未授权只证明了准确失败、子进程退出和临时目录清理，尚不构成真实选择/取消成功。G5-03/G5-04/G5-09 仍分别缺 Windows UI Automation runtime、macOS/Windows real-picker 成功和双平台 hosted clean-runner 成功记录；workflow 配置不等于这些平台门禁已有成功证据。

## 仓库结构

```text
crates/           Rust：NUI / System / Text / App Runtime / 平台 / Bridge
packages/         Minimal TSX、CLI、Host FFI、System Host、框架 Adapter
examples/         各切片验收 Demo + framework-parity
docs/decisions/   ADR-004 … ADR-010
.github/workflows CI（按路径与切片门禁）
```

## 快速开始

### 前置

- Rust stable（`rustfmt` + `clippy`）
- Node ≥ 22、pnpm ≥ 9
- Perry CLI（平台包齐全）
- 首次编译会下载 `skia-safe` 预编译二进制，可能较慢

### 框架 Counter 一览

| 框架             | 目录                         | 命令                                             |
| ---------------- | ---------------------------- | ------------------------------------------------ |
| Minimal TSX      | `examples/counter`           | `perry compile main.tsx -o counter`              |
| Solid            | `examples/solid-counter`     | `pnpm build`                                     |
| Vue 3            | `examples/vue-counter`       | `perry compile main.ts -o vue-counter`           |
| React            | `examples/react-counter`     | `perry compile main.tsx -o react-counter`        |
| Svelte           | `examples/svelte-counter`    | `perry compile main.ts -o svelte-counter`        |
| Layout           | `examples/layout-playground` | `perry compile main.tsx -o layout-playground`    |
| Image            | `examples/image-demo`        | `cd examples/image-demo && pnpm start`           |
| Clipboard        | `examples/clipboard-demo`    | `cd examples/clipboard-demo && pnpm start`       |
| Input E2E        | `examples/input-e2e`         | `pnpm --filter @nexa/example-input-e2e start`    |
| Semantic harness | `examples/semantic-e2e`      | `pnpm --filter @nexa/example-semantic-e2e start` |

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

### CLI `new` / `dev` / `build` / `package` / `doctor`

```bash
pnpm --filter @nexa/cli test
pnpm --filter @nexa/cli smoke:build
pnpm --filter @nexa/cli smoke:package
cd examples/reference-notes
node ../../packages/cli/src/bin.mjs doctor --json
```

`nexa new <directory>` 生成独立 Minimal TSX 项目骨架和 deny-all manifest，不安装依赖，也不接受绝对路径、父级穿越、符号链接或非空目标；Technical Preview 候选包已可生成真实 tarball，但尚未发布到 registry，clean 用户仍需已发布或已授权的 registry。`dev` 委托 project-local Perry watcher，`build` 严格校验并嵌入 `app.manifest.json`，输出 `dist/<package-name>[.exe]`；两者都拒绝不受支持的 target、测试 fixture 污染和全局 Perry fallback。`doctor` 只使用项目依赖图中的 Perry/Hosts，检查 Node/pnpm、两套 Host runtime/ABI 与 Technical Preview target。

`nexa package` 总是先执行同一条受信 `build`，再输出当前 target 的 unsigned macOS `.app` 或 Windows 分发目录；产物包含精确 manifest、`nexa-build.json` 与可选 `assets/`，不携带 `node_modules`、Cargo `target`、源码或 `.nexa` 开发目录，启动时不依赖这些开发工具链文件。通用实现位于 [`packages/cli/src/package.mjs`](packages/cli/src/package.mjs)；Notes 参考应用继续使用独立的 [`tools/reference-notes-package.mjs`](tools/reference-notes-package.mjs)，不与通用 CLI 共享应用名称、权限或专用 helper。签名、公证、installer、发布以及 G5-09 的双平台 hosted artifact/launch 不属于已完成范围。

当前 native Dialog backend 基于 `rfd::FileDialog`，只能观察 selected path 或 `None` cancel；真实 backend 没有可映射为 `PLATFORM_FAILURE` 的返回分支，该错误只由注入 backend 合同覆盖。Task cancel 或 owner close 会终止 Promise 交付并丢弃迟到结果，但不能主动关闭已经显示的系统 picker。

### Typed Style / Theme

`@nexa/ui` 只接受 typed numeric style，不解析 CSS string 或 selector。Theme 由根 `Window` 局部传递，组件 style 作为最终覆盖：

```tsx
import { Button, Input, Window, createTheme, rgba } from "@nexa/ui";

const theme = createTheme({
  colors: { accent: rgba(15, 118, 110) },
  radii: { control: 6, field: 5 },
});

<Window title="Notes" theme={theme}>
  <Button style={{ borderRadius: 4 }}>保存</Button>
  <Input textStyle={{ fontSize: 15 }} />
</Window>;
```

hover、pressed、focus 与 disabled 由所有交互组件共用的 native interaction resolver 组合，不依赖框架侧 class 或 selector。

## 垂直切片路线

| Slice | 目标                    | 状态                                                           |
| ----: | ----------------------- | -------------------------------------------------------------- |
|     0 | 静态窗口                | 完成                                                           |
|     1 | Rust Counter            | 完成                                                           |
|     2 | Perry Host FFI          | 完成                                                           |
|     3 | Minimal TSX             | 完成                                                           |
|     4 | Todo + Taffy + Scroll   | 完成                                                           |
|     5 | Solid Adapter           | 完成                                                           |
|     6 | Vue 3 Adapter           | 完成                                                           |
|     7 | React Adapter           | 完成                                                           |
|     8 | Svelte compiler backend | 完成（Counter 子集 runtime）                                   |
|     9 | Input（单行）           | 完成（Host focus + IME/键盘 + Todo）                           |
|    10 | ADR §11 复合组件        | 完成（Stack / Spacer / Card + flexGrow/align）                 |
|    11 | Image（本地）           | 完成（set_image + Skia decode/paint + image-demo）             |
|    12 | System Host + Clipboard | 完成（ADR-005、`@nexa/clipboard`）                             |
|     — | ADR-006 P0 契约         | 完成（文档 + `nui-text` / `nui-app-runtime` 骨架 + Semantics） |

## 刻意未做（ADR）

PlatformView / Image 网络 / 多窗口 / 完整 Inspector / 通知托盘 / 移动端，以及 Preview 后的自动签名分发。

架构决策见 [ADR-004](docs/decisions/ADR-004-framework-adapters-native-host-mvp.md)、[ADR-005](docs/decisions/ADR-005-system-host-permissions-plugins.md)、[ADR-006](docs/decisions/ADR-006-application-runtime-composition-p0.md)、[ADR-007](docs/decisions/ADR-007-protocol-handle-error-v1.md)、[ADR-008](docs/decisions/ADR-008-typescript-aot-scriptc-vs-perry.md)、[ADR-009](docs/decisions/ADR-009-text-pipeline-dependency-spike.md)。

## CI 设计

见 [`.github/workflows/README.md`](.github/workflows/README.md)。

## 许可证

MIT OR Apache-2.0
