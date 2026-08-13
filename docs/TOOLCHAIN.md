# Nexa UI 工具链与版本策略

本项目将“开发/CI 工具链”与“库的最低兼容版本”分开管理。工具链升级必须在同一个 Pull Request 中更新版本声明、锁文件和基线证据。

## 固定版本

| 工具      | 固定位置                            | 当前版本                                   | 说明                                                             |
| --------- | ----------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Node.js   | CI `node-version`                   | 22.x                                       | CI 使用 Node 22 LTS；本地至少满足根 `engines`                    |
| pnpm      | 根 `packageManager`                 | 10.34.3                                    | `pnpm/action-setup` 只读取此处，不重复声明版本                   |
| Rust      | `rust-toolchain.toml`               | 1.88.0                                     | 开发与 required CI 使用精确版本，并安装 rustfmt、Clippy          |
| Rust MSRV | 根 `workspace.package.rust-version` | 1.88                                       | 兼容性下限，不用于替代固定的开发工具链                           |
| Perry CLI | 根 `devDependencies`                | 0.5.1220                                   | 通过 `pnpm exec perry` 调用，禁止依赖全局浮动版本                |
| Perry FFI | 两个 FFI `Cargo.toml`               | `06137858dc8c6f80975238377138f2f948d6ef88` | 对应 Perry `v0.5.1220`，两个 nativeLibrary 必须使用同一 revision |

`packages/nui-host/Cargo.lock`、`packages/system-host/Cargo.lock` 与 `tools/windows-static-closure/Cargo.lock` 都必须提交。它们是独立 staticlib crate/组合闭包的可重复依赖快照，不受根 `Cargo.lock` 覆盖；Windows 闭包只启用 Technical Preview 参考应用使用的 Perry `core` 与 Host Promise 所需 `async-runtime` feature，并由 hosted AOT/launch 门禁验证。

仓库 `.npmrc` 固定官方 npm registry。Perry CLI 依赖按平台分包，镜像缺少任一 optional package 都会产生“wrapper 已安装但 CLI 不可执行”的假安装。

## 本地验证

```bash
pnpm install --frozen-lockfile
pnpm exec perry --version
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check --manifest-path packages/nui-host/Cargo.toml --locked
cargo check --manifest-path packages/system-host/Cargo.toml --locked
cargo metadata --manifest-path tools/windows-static-closure/Cargo.toml --locked --no-deps
```

Perry CLI 必须输出 `0.5.1220`。两条独立 Cargo 命令必须从已提交 lock 构建，不能回退到 `main` 或在 CI 中隐式更新依赖。

## 升级流程

1. 选择一个已发布的 Perry CLI 版本，并解析其 Git tag revision。
2. 同时更新根 Perry CLI 版本、两个 `perry-ffi` revision、Windows 闭包 revision 和三份独立 Cargo lock。
3. 更新 Rust 工具链时保留 MSRV 声明；MSRV 变化必须单独说明兼容性影响。
4. 运行上述完整验证以及 Minimal TSX Perry smoke。
5. 在 `docs/BASELINE.md` 记录 runner、版本、结果与 CI 链接后再合并。
