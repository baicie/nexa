# GitHub Workflows

CI 对齐 ADR-004 的垂直切片策略：**主线串行、路径过滤、平台按 MVP 范围扩展**。

## 工作流一览

| Workflow           | 触发                         | 作用                                  |
| ------------------ | ---------------------------- | ------------------------------------- |
| `ci.yml`           | PR / push → `main`           | 编排入口：按变更路径调度门禁          |
| `rust.yml`         | `workflow_call` / 手动       | Rust fmt / clippy / test / build      |
| `typescript.yml`   | `workflow_call` / 手动       | pnpm install / typecheck / format     |
| `native-smoke.yml` | `workflow_call` / tag / 手动 | macOS + Windows 原生 Demo（Slice 0+） |
| `docs.yml`         | 仅文档变更                   | Markdown / ADR 轻量检查               |

## 设计原则

1. **路径过滤**：只跑与变更相关的门禁；纯文档 PR 不编译 Skia。
2. **切片门禁**：早期 CI 不要求 GPU / 窗口；`native-smoke` 在 Slice 0 落地后启用。
3. **平台范围**：MVP 只验收 **macOS + Windows**（ADR §6.1）；Linux 作可选，不阻塞合并。
4. **不并行五条产品线**：Adapter / DevTools / 移动端不进 required checks。
5. **失败即阻断**：`rust` + `typescript`（有相关变更时）为 merge required checks。

## 路径 → Job 映射

```text
crates/** | examples/rust-counter/** | Cargo.* | rust-toolchain.toml
  → rust.yml

packages/** | examples/counter/** | pnpm-workspace.yaml | package.json | tsconfig*.json
  → typescript.yml

docs/** | *.md | .github/workflows/README.md
  → docs.yml（且可跳过重型原生构建）

examples/rust-counter/** + Slice 0 可绘制后
  → native-smoke.yml（macos-latest, windows-latest）
```

## Required status checks（建议分支保护）

当对应 job 被路径过滤跳过时，使用 `ci.yml` 中的 `result` job 汇总，避免 required check 因 skip 而卡死：

```text
CI / result
```

## 刻意不做（首阶段）

- Android / iOS matrix
- 全框架 Adapter 矩阵
- Perry AOT 完整发布流水线（等 Slice 2）
- npm publish / 插件市场
- 强制每次 PR 编译 rust-skia（过重；Slice 0 后单独 `native-smoke`）
