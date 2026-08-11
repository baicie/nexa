# Nexa UI 文档

## 当前规划

- [G0 可信基线证据](./BASELINE.md)：固定工具链、精确门禁命令、跨平台 run 与 branch protection 状态。
- [Desktop Notes MVP](./MVP.md)：当前产品目标、范围、验收矩阵、实施阶段与退出门禁。
- [Notes 参考应用](./REFERENCE-APP.md)：用户旅程、状态模型、语义与 E2E 场景。
- [Quickstart](./QUICKSTART.md)：从 Minimal TSX 项目生成到开发、构建和打包的主路径。
- [Public API Index](./API.md)：UI primitives、Theme、typed System Task 与 Adapter surface。
- [Packaging Guide](./PACKAGING.md)：unsigned 产物布局、assets 预算、原子发布与 CI 证据边界。
- [Release Integrity](./RELEASE-INTEGRITY.md)：artifact digest、CycloneDX SBOM、provenance 与 fresh-consumer 校验合同。
- [Supply Chain](./SUPPLY-CHAIN.md)：Action SHA、依赖图、许可证、advisory 与 secret scan 边界。
- [Signing](./SIGNING.md)：policy-only 签名边界、readiness 前置条件与尚未配置的凭据/executor。
- [Performance](./PERFORMANCE.md)：性能预算 schema、pending baseline 与 hosted capture 边界。
- [Release Rehearsal](./RELEASE-REHEARSAL.md)：unsigned staging 候选、fresh verify/launch、回滚和禁止发布约束。
- [Compatibility And Known Limitations](./COMPATIBILITY.md)：工具链、平台、框架支持等级与未关闭门禁。
- [项目详细设计](./PROJECT-DESIGN.md)：目标、现状、目标架构、核心合同、测试与成功标准。
- [路线图](./ROADMAP.md)：G0–G6 里程碑、依赖、退出条件、并行方式与风险。
- [执行 Todo](../TODO.md)：可领取、可验证、带依赖和文件范围的任务清单。
- [工具链与版本策略](./TOOLCHAIN.md)：Rust、pnpm、Perry CLI/FFI 与独立 lock 的固定规则。
- [CLI `new` / `dev` / `build` / `package` / `doctor`](../packages/cli/README.md)：项目生成、manifest-aware 开发/构建、unsigned 当前平台打包、安全边界、诊断项与退出码合同。

项目设计、路线图与 Todo 已进入 **MVP 实施**。候选依赖、公开 API、协议 major 和发布动作仍须通过对应 ADR 或负责人评审。

G5-08 通用 `nexa package` 已由 `packages/cli/src/package.mjs` 交付；Notes 专用 `tools/reference-notes-package.mjs` 保持独立。G5-11 已将 `@nexa/adapter-solid` 选为唯一 Tier-1 外部 Adapter：Solid Notes 核心切片的语义交互、保存和 dispose 由本地 E2E 覆盖，并进入九包公开 release train。G5-09 的 build/upload 与 fresh download/launch 两阶段 workflow 及无 fixture real-picker probe 已配置并有本地合同；本机 macOS 只取得 Accessibility 未授权时的准确 fail-closed/cleanup 证据。G5-09/MVP-01 的 macOS/Windows hosted artifact/launch、Windows UI Automation runtime 与双平台真实 OS picker 成功仍未完成。已配置 workflow 不代表已有 hosted-runner 成功记录，也不代表签名或发布已经交付。

## 架构决策

- [ADR 索引](./decisions/README.md)
- [ADR-004：框架适配器、统一 Native UI Host 与最快可见 MVP](./decisions/ADR-004-framework-adapters-native-host-mvp.md)
- [ADR-005：跨平台系统 API、权限模型与插件架构](./decisions/ADR-005-system-host-permissions-plugins.md)
- [ADR-006：Application Runtime、平台组合层与 P0 契约](./decisions/ADR-006-application-runtime-composition-p0.md)
- [ADR-007：Protocol、Handle 与 Error Contract v1](./decisions/ADR-007-protocol-handle-error-v1.md)
- [ADR-008：TypeScript AOT 与 Native FFI 后端选择（ScriptC vs Perry）](./decisions/ADR-008-typescript-aot-scriptc-vs-perry.md)
- [ADR-009：文本索引与排版依赖分层](./decisions/ADR-009-text-pipeline-dependency-spike.md)
- [ADR-010：Desktop Notes MVP 范围与退出门禁](./decisions/ADR-010-desktop-notes-mvp-scope.md)

ADR 记录已做出的长期决策；详细设计负责把这些决策组合成当前目标架构；路线图和 Todo 负责执行顺序。出现冲突时，应先新增或修订 ADR，再更新设计与计划。
