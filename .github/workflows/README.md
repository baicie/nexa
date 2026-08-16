# GitHub Workflows

CI 对齐 ADR-004 的垂直切片策略：**主线串行、路径过滤、平台按 MVP 范围扩展**。

## 工作流一览

| Workflow                      | 触发                          | 作用                                                                                       |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| `ci.yml`                      | PR / push → `main`            | 编排入口：按变更路径调度并 fail-closed 汇总 required gates                                 |
| `docs.yml`                    | `workflow_call` / 手动        | Markdown 链接、文档合同、ADR 与既有 G0 证据检查                                            |
| `ffi.yml`                     | `workflow_call` / 手动        | `nui-host` / `system-host` 独立 FFI 构建、测试与 ABI 合同                                  |
| `rust.yml`                    | `workflow_call` / 手动        | Rust fmt / clippy / test / build                                                           |
| `typescript.yml`              | `workflow_call` / 手动        | Ubuntu workspace 全门禁 + Windows CLI 合同                                                 |
| `perry-frameworks.yml`        | `workflow_call` / 手动        | Solid/Notes/Vue/React/Svelte 在 macOS/Windows 的 Perry AOT matrix                          |
| `native-smoke.yml`            | `workflow_call` / tag / 手动  | 双平台原生 Demo、输入与真实辅助技术 client smoke；受调用时可产出 MVP platform proof        |
| `reference-notes-package.yml` | `workflow_call` / tag / 手动  | 双平台 CLI/Notes runtime、picker、unsigned package/signing input 与 fresh launch           |
| `security.yml`                | `workflow_call` / 手动        | Action SHA、npm/Cargo audit/deny、许可证与 secret scan                                     |
| `performance.yml`             | `workflow_call` / 定时 / 手动 | 性能合同与双平台 hosted capture；`require_active` 可要求已评审 baseline                    |
| `mvp-evidence.yml`            | 手动                          | 在干净 release tag 汇总 N-01..N-09，并以双平台 proof 晋级 N-10/N-11                        |
| `signing.yml`                 | `workflow_call` / 手动        | 校验 reviewed executor 与 fail-closed policy；平台签名 job 和 credential activation 仍关闭 |
| `release-rehearsal.yml`       | `workflow_call` / tag / 手动  | unsigned 候选、fresh verify/launch、篡改检测、隔离回滚与晋级决策演练                       |
| `registry-evidence.yml`       | 手动                          | 在 exact tag 从公开 npm train 做 clean-user 验证；只取证，绝不 publish                     |
| `release-evidence.yml`        | 手动                          | 下载并语义验证指定外部 run 的 MVP/rehearsal/signing/registry proof，组装 readiness bundle  |
| `release.yml`                 | 手动                          | 校验 readiness；只有受保护且获批的 `request-publication` 路径才允许进入发布 job            |

## 设计原则

1. **路径过滤**：只跑与变更相关的门禁；纯文档 PR 不编译 Skia。
2. **切片门禁**：`rust.yml` 在 Linux 上编译/测试（含 Skia CPU）；双平台输入 harness 与原生离屏验收走 `native-smoke`。
3. **平台范围**：MVP 只验收 **macOS + Windows**（ADR §6.1）；Linux 作可选，不阻塞合并。
4. **不并行五条产品线**：Adapter / DevTools / 移动端不进 required checks。
5. **失败即阻断**：`CI / result` 对所有匹配路径的 Rust、TypeScript、FFI、Perry、native、package、docs 与 security job 做 fail-closed 汇总。
6. **无凭据签名预检**：每个 CI revision 都以 `operation: validate` 调用 `signing.yml`，不传 secrets；`CI / result` 对任何非成功结果 fail closed。
7. **性能标签**：`performance-capture` 只采集报告且不阻断合并；`performance-required` 还要求 active baseline，并由 `CI / result` 等待和 fail-closed 汇总。
8. **候选演练标签**：`release-rehearsal-required` 先让当前 CI revision 运行一次 active performance workflow，再把该 job result 传入无凭据 `candidate` rehearsal；rehearsal 只接受 `success`，不会对同一 revision 重复启动另一组 hosted 性能采样。手动与 tag rehearsal 没有 caller result，仍在内部执行 active capture。该路径不会签名、公证、发布或推广版本。

## 发布证据与外部门禁

`mvp-evidence.yml` 使用 schema v5，并固定按 TypeScript、Rust、FFI、Perry frameworks、Docs、native accessibility、clean package launch 七个 gate 及各自唯一 producer workflow 晋级；缺失、额外、重排、failure、cancelled、skipped 或伪造 producer 均 fail closed。`macos-15` 的 `darwin/arm64` 与 `windows-2022` 的 `win32/x64` 必须分别提交 native accessibility 与 clean-package hosted proof。每份 proof 绑定 parent/producer workflow、实际 job、runner/platform/arch、artifact byte size/SHA-256；晋级记录还绑定 proof 文件自身的 SHA-256。配置 reusable workflow 或本地合同通过都不能替代这些 hosted 结果。

`registry-evidence.yml` 不携带发布权限，也不会创建 registry 状态。它只允许在精确 `v0.1.0` tag 和 `technical-preview-registry-evidence` Environment 中，对已经公开的九包 train 做 clean consumer 安装、metadata/integrity 与 lockfile 取证。

`reference-notes-package.yml` 是唯一的 canonical unsigned signing-input producer；`signing_input` job 上传包含双平台 archive 与 G6-05 descriptor/evidence 的 `unsigned-signing-input`。`signing.yml` 通过显式 `unsigned_run_id` 校验该 producer run 的 workflow/revision，再下载并复核同名 artifact。它已编码临时凭据导入、平台签名、公证/时间戳、custody export、双平台 merge 与 publisher verification，但两个受保护平台 job 都保留 literal `if: ${{ false }}`；同时 `release/signing-policy.json` 中 execution 与 credential activation 仍为 `disabled`，owner 未分配，staging evidence 为 `pending`。因此当前 run 不会请求签名 Environment、激活真实凭据或签名 bytes。

`release-evidence.yml` 只接受显式外部 run ID，先下载再语义验证 MVP、rehearsal、signed custody 与 registry proof，并把 producer run、revision、tag 和 proof digest 写入不可变 readiness bundle。它不签名、不发布。`release.yml` 的 checked-in readiness policy 同样保持 `disabled` 且所有外部门禁为 `pending`；`request-publication` 还需要受保护 `technical-preview-release` Environment、精确 readiness/signing run 和发布授权。final 路径会从 signed custody 准备精确七个公开 GitHub Release 资产，使用 GitHub provenance attestation，创建或核对 draft prerelease，并 fresh-download 已有资产后只补传摘要一致的缺项；禁止 `--clobber`。只有 npm 九包 `technical-preview` channel 二次观测完全收敛后才公开 draft，并上传绑定 Release ID/URL、release/signing run、七资产摘要与 npm integrity 的 publication record。bootstrap 路径不创建 GitHub Release。当前仓库没有 hosted signing、registry、GitHub Release 或最终 publish 成功记录。

## `--smoke` 行为

`cargo run -p rust-counter -- --smoke` 不创建窗口，用 Skia 离屏绘制一帧后 exit 0。  
`native-smoke.yml`（macOS + Windows）对匹配的 platform/runtime 变更由 `ci.yml` 强制调度，不提供绕过开关。

同一 matrix 还运行两组 deterministic Rust 场景：`g3a11_` 重放 CJK/Emoji composition、候选框、跨行 selection 与内存剪贴板编辑；`g3b05_` 使用共享 scenario，分层验证 AccessKit converter 的 role/name/action 映射和 Bridge Dispatcher 的 Focus、SetValue、Invoke。场景不读取真实剪贴板，也不使用屏幕坐标。

同一份 `examples/semantic-e2e/scenario.json` 还驱动 `semantic-accessibility-smoke`：macOS 通过真实 NSAccessibility 对象，Windows 通过 UI Automation COM client，按 role/name 查找 Title、Body、Save，执行 Focus、SetValue、Invoke，并要求请求穿过生产 AccessKit Adapter 与 Dispatcher 后产生 `Saved: Meeting notes`。PR run `31902303937` 的 macOS/Windows native jobs `95054897228` / `95054897192` 已在真实 hosted runner 通过这条平台 client 路径。

`reference-notes-package.yml` 的 `package` matrix 在 macOS/Windows clean runner 上先执行通用 CLI 从 `new` 到真实 Perry AOT/link 的 create-to-package smoke，再运行真实 FS Promise、真实 Clipboard read/write/read Promise、构建期 fixture 驱动的 Dialog Task/Promise smoke，以及无 fixture 的真实 OS picker probe，最后重新执行正式 Notes 构建与打包。Clipboard runner 要求精确 round-trip/restore proof；real-picker probe 必须依序完成 save/open/cancel，并核对 stage、marker、版本化 controller proof 与真实磁盘 bytes；driver、超时、面板关闭等待或 cleanup 任一失败都阻断 artifact 上传。package job 会生成 canonical native runtime proof，绑定 revision/ref/run/target 以及 FS 与 picker Perry binary 的 size/SHA-256，并把 N-05/N-06 native FS 与 N-04/G5-04P real-picker 旅程写入固定语义；launch job 下载该 proof，clean-package hosted proof 再以内嵌 payload 和外层 size/SHA-256 绑定它。它将通用与 Notes distribution 分别封装并上传；独立 `signing_input` job 还把两个平台 archive 收敛为规范命名的 `unsigned-signing-input` custody bundle，生成并重新验证 G6-05 descriptor、`SHA256SUMS`、CycloneDX 1.6 SBOM 与 provenance。依赖它的 fresh `launch` matrix 只下载、解包、重新验证并直接启动两类 executable，不 checkout 仓库、不 setup/install 工具链，也不重新 build/package。通用实现是 `packages/cli/src/package.mjs`；Notes 的应用名称、权限与产物仍由独立的 `tools/reference-notes-package.mjs` 处理。CLI、picker probe 与 Notes 正式 build 都会大小写不敏感地清除测试 fixture/bypass 环境变量并拒绝带 fixture canary 的二进制；unsigned signing input、本机 Clipboard AOT、deterministic Dialog smoke 与 workflow 配置都不作为真实 hosted 签名或平台成功证据。

PR run `31902303937` 已完成双平台 package 与 fresh launch：package jobs `95054897243` / `95054897272` 在真实图形会话通过 picker save/open/cancel，launch jobs `95059000291` / `95059000304` 从下载制品直接启动，因此 G5-09/MVP-01 与对应 hosted picker 门禁已关闭。该 run 的 PR source head 是 `e56bb9e2c531e9cd3d97837465eca92d5e2c31dd`，package/report/artifact 执行绑定 Actions merge revision `991b28142783833c14be659125c4564d14219cc5`。`collect_mvp_proof=false` 使 native/clean-package proof 上传被跳过，所以该结果不是 N-10/N-11 schema-v5 promotion。workflow 只生成并验证 unsigned artifact，不执行签名、公证或发布。

## 路径 → Job 映射

```text
crates/** | examples/rust-counter/** | Cargo.* | rust-toolchain.toml
  → rust.yml

packages/** | examples/counter/** | pnpm-workspace.yaml | package.json | tsconfig*.json
  → typescript.yml

docs/** | *.md | .github/workflows/README.md
  → docs.yml（且可跳过重型原生构建）

examples/rust-counter/** + Slice 0 可绘制后
  → native-smoke.yml（macos-15, windows-2022）

examples/reference-notes/** | packages/cli/** | CLI/package smoke tools + UI/System/Protocol runtime
  → reference-notes-package.yml（macos-15, windows-2022）

供应链与治理配置（含隐藏文件）
  → security.yml（Action SHA、依赖/许可证、Cargo advisory 与 secret scan）
```

## Required status checks（建议分支保护）

当对应 job 被路径过滤跳过时，使用 `ci.yml` 中的 `result` job 汇总，避免 required check 因 skip 而卡死：

```text
CI / result
```

每个 PR/push 都会通过 reusable workflow 执行 credential-free signing preflight。该调用只运行静态 policy、reviewed executor binding、签名合同与 Action SHA 检查；平台签名 executor 继续由 literal `false` 跳过，调用方不传递任何 secrets。预检被取消、跳过或失败时，`CI / result` 一律失败。

当 PR 带 `performance-required` 标签时，同一个 required check 还会等待并聚合双平台 performance workflow；`performance-capture` 标签只请求采集，不把采集失败升级为 required gate 失败。`release-rehearsal-required` 也会要求该 workflow 使用 active baseline，因为其结果同时作为 candidate rehearsal 的唯一 performance producer。

当 PR 带 `release-rehearsal-required` 标签时，`CI / result` 还会等待 credential-free candidate rehearsal，并要求 reusable workflow 成功。caller performance 非 `success`、缺少 active baseline 或 rehearsal 内部意外重复运行 performance 都 fail closed。未带该标签时 rehearsal 跳过且不影响 required check；PR candidate 结果不替代 clean-tag staging 或签名、registry、发布证据。

## 当前仍未激活或不作为本地完成

- Android / iOS matrix
- macOS Developer ID 签名/公证与 Windows Authenticode 的凭据激活
- npm train、应用 artifact 与最终 Technical Preview 的公开发布
- clean-tag schema-v5 MVP evidence 与 registry clean-user 成功记录
- clean-tag 的完整 hosted staging rehearsal
- 与变更路径无关的每个示例都开真实窗口
- GPU backend（gl/metal/vulkan）——Slice 0 使用 Skia CPU + softbuffer
