# G0 可信基线证据

- 状态：PASS
- 采集时间：2026-08-04 12:50 CST（UTC+08:00）
- 规划输入：`mvp@f3afbeb`
- 质量门禁提交：`35912970ce3bfffa891b1eff1008ebe041bb33c1`
- 原生 smoke 提交：`35912970ce3bfffa891b1eff1008ebe041bb33c1`
- Pull Request：[baicie/nexa-ui#5](https://github.com/baicie/nexa-ui/pull/5)

本页记录 G0 退出条件的可重复证据。提交 SHA、Actions run 和 job 链接均不可变；后续里程碑不得用新的提交数量代替这些验证结果。

## 固定工具链

| 工具        | 版本                                                     | 证据                                   |
| ----------- | -------------------------------------------------------- | -------------------------------------- |
| Node.js     | `22.23.1`                                                | [TypeScript / quality][typescript-job] |
| pnpm        | `10.34.3`                                                | [TypeScript / quality][typescript-job] |
| Rust        | `1.88.0`                                                 | [Rust jobs][quality-run]               |
| Perry CLI   | `0.5.1220`                                               | [FFI / nui-host][nui-host-job]         |
| `perry-ffi` | `0.5.1220` at `06137858dc8c6f80975238377138f2f948d6ef88` | [FFI / nui-host][nui-host-job]         |

Rust、Perry 和两个独立 FFI crate 的固定策略见[工具链与版本策略](./TOOLCHAIN.md)。

## Clean checkout 与 runner

所有 hosted job 从 `actions/checkout@v4` 的 clean checkout 开始。TypeScript、FFI 与 Perry job 随后执行 `pnpm install --frozen-lockfile`；需要在 Ubuntu 上链接 Skia 的 TypeScript、Rust test/build 与 `nui-host` FFI job 先执行：

```bash
sudo apt-get update
sudo apt-get install --yes --no-install-recommends libfontconfig1-dev libfreetype6-dev
```

Perry Windows job 先初始化 MSVC，再从以下固定地址下载并校验 Skia archive，SHA-256 不匹配或 `skia.lib`/`skia-bindings.lib` 缺失时会在 AOT 前失败：

```text
https://github.com/rust-skia/skia-binaries/releases/download/0.99.0/skia-binaries-a25a0fdb7d90429aa2d1-x86_64-pc-windows-msvc-jpegd-jpege-pdf.tar.gz
SHA-256 406865946e42aa7a3872f364981f031f615bf8f2e80fdccfc15f0d01bc144580
```

| 范围           | Workflow runner label      | 本次证据中的 image                   |
| -------------- | -------------------------- | ------------------------------------ |
| Quality/FFI    | `ubuntu-latest`            | 由 [quality run][quality-run] 固定   |
| Perry AOT      | `macos-15`、`windows-2022` | 由 [quality run][quality-run] 固定   |
| Native macOS   | `macos-latest`             | `macos-26-arm64@20260728.0273.1`     |
| Native Windows | `windows-latest`           | `windows-2025-vs2026@20260728.188.1` |

runner label 会随 GitHub 更新；上表的 resolved image 与 Actions run 一起构成本次不可变证据。

## 自动门禁

### TypeScript workspace

`ubuntu-latest` 按顺序执行以下命令，结果 PASS：[TypeScript / quality][typescript-job]。

```bash
pnpm workspace:validate
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

### Rust workspace

`ubuntu-latest` 独立执行以下命令，结果 PASS：[fmt][rust-fmt-job]、[clippy][rust-clippy-job]、[test][rust-test-job]、[build][rust-build-job]。

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --workspace
cargo run -p rust-counter -- --smoke
```

### 独立 FFI crate

矩阵分别将 `FFI_MANIFEST` 设为 `packages/nui-host/Cargo.toml` 和 `packages/system-host/Cargo.toml`，在 `ubuntu-latest` 执行以下 Cargo 命令：

```bash
cargo fmt --manifest-path "$FFI_MANIFEST" -- --check
cargo check --manifest-path "$FFI_MANIFEST" --all-targets --locked
cargo clippy --manifest-path "$FFI_MANIFEST" --all-targets --locked -- -D warnings
cargo test --manifest-path "$FFI_MANIFEST" --all-targets --locked
```

随后每个 matrix job 在对应 package 目录执行一次 Perry manifest 校验；从仓库根目录复现的准确命令为：

```bash
(cd packages/nui-host && pnpm exec perry native validate)
(cd packages/system-host && pnpm exec perry native validate)
```

两个 crate 均为 PASS：[FFI / nui-host][nui-host-job]、[FFI / system-host][system-host-job]。`nui-host` 还执行 `pnpm --filter @nexa/example-counter smoke`，Minimal TSX runtime marker 为 PASS。

### 跨平台矩阵

四个框架分别执行以下 clean AOT 命令，每条在 macOS 和 Windows 各执行一次：

```bash
pnpm test:perry solid
pnpm test:perry vue
pnpm test:perry react
pnpm test:perry svelte
```

| 范围                | Runner                           | 命令                                                                                      | 结果      | 证据                                                     |
| ------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------- |
| Framework AOT       | `macos-15`、`windows-2022`       | 上述四条命令；每个 job 设置 `PERRY_NO_CACHE=1`                                            | PASS，8/8 | [Perry matrix][quality-run]                              |
| Native offscreen    | `macos-latest`、`windows-latest` | `cargo build -p rust-counter --release`；`cargo run -p rust-counter --release -- --smoke` | PASS，2/2 | [macOS][native-macos-job]、[Windows][native-windows-job] |
| Required aggregator | `ubuntu-latest`                  | `CI / result` fail-closed 汇总                                                            | PASS      | [CI / result][result-job]                                |

质量门禁 run [30878535145][quality-run] 和原生 run [30878586130][native-run] 均在提交 `35912970...` 上整体为 `success`。仓库变量 `NATIVE_SMOKE_ENABLED=true`，相关平台改动会进入 macOS/Windows smoke。

## Branch Protection

2026-08-04 12:44 CST 通过 GitHub Branch Protection API 回读 `main`：

```bash
gh api repos/baicie/nexa-ui/branches/main/protection
```

- required status check 为 `CI / result`，`strict=true`；
- 合并必须至少 1 个批准，且新提交会撤销旧批准；
- 必须解决所有 review conversation；
- 管理员同样受保护；
- force-push 和 branch deletion 均禁用。

这组设置位于仓库外部。若需回滚，应由仓库管理员通过同一 API 或 Settings > Branches 明确修改并记录原因；不得通过临时直推绕过。

## 已知边界

- 8 路 Perry AOT 证明四个框架能从 clean checkout 编译并链接，不等同于四套运行时交互 parity。
- Svelte 示例仍是 Host driver 子集，不代表完整 Svelte runtime 兼容。
- Native smoke 使用 offscreen 绘制，不覆盖真实窗口、输入、IME 或 Surface suspend/resume。
- Perry 编译 React/Vue 时仍报告浏览器全局标识符兼容 warning；构建成功，但需由后续 conformance 合同约束行为。
- `nui-host` 为 Perry 预构建 stdlib 对可选 HTTP extension 的引用提供了 14 个临时 no-op `js_*` stub；它们未在 Nexa manifest 声明、对用户代码不可达且当前校验通过，G1 协议生成与 manifest 收敛时必须明确其归属并移除临时 stub。
- GitHub Actions 报告部分 `@v4` Action 仍以已弃用的 Node 20 runtime 打包；runner 当前强制使用 Node 24，后续应升级到提供新 runtime 的 Action major。
- 多数 TS source package 还没有独立单元测试；workspace matrix 会显式显示这些 skip，G1 conformance 不得继续沿用该缺口。

[quality-run]: https://github.com/baicie/nexa-ui/actions/runs/30878535145
[native-run]: https://github.com/baicie/nexa-ui/actions/runs/30878586130
[typescript-job]: https://github.com/baicie/nexa-ui/actions/runs/30878535145/job/91894800951
[nui-host-job]: https://github.com/baicie/nexa-ui/actions/runs/30878535145/job/91894800998
[system-host-job]: https://github.com/baicie/nexa-ui/actions/runs/30878535145/job/91894800992
[rust-fmt-job]: https://github.com/baicie/nexa-ui/actions/runs/30878535145/job/91894800989
[rust-clippy-job]: https://github.com/baicie/nexa-ui/actions/runs/30878535145/job/91894801086
[rust-test-job]: https://github.com/baicie/nexa-ui/actions/runs/30878535145/job/91894800991
[rust-build-job]: https://github.com/baicie/nexa-ui/actions/runs/30878535145/job/91894801006
[result-job]: https://github.com/baicie/nexa-ui/actions/runs/30878535145/job/91895551548
[native-macos-job]: https://github.com/baicie/nexa-ui/actions/runs/30878586130/job/91894923553
[native-windows-job]: https://github.com/baicie/nexa-ui/actions/runs/30878586130/job/91894923466
