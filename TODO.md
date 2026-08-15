# Nexa UI Todo

- 状态：Desktop Notes MVP 与无凭据 hosted 门禁已闭环（PR run `31902303937` 的 41/41 jobs 通过，覆盖 Windows UIA、双平台真实 picker/clean-runner、安全门禁、active 性能预算与 G6-05 unsigned input；clean-tag schema-v5 晋级、registry clean-user、真实签名/公证和最终发布仍待外部条件）
- 规划输入：`mvp@f3afbeb`
- 最新证据：[`docs/BASELINE.md`](./docs/BASELINE.md)
- 路线图：[`docs/ROADMAP.md`](./docs/ROADMAP.md)
- 详细设计：[`docs/PROJECT-DESIGN.md`](./docs/PROJECT-DESIGN.md)
- MVP 规格：[`docs/MVP.md`](./docs/MVP.md)
- 参考应用：[`docs/REFERENCE-APP.md`](./docs/REFERENCE-APP.md)

## 执行规则

- 按依赖顺序领取任务；只有标记为可并行的任务才能跨 Lane 同时推进。
- 每项任务应在一次专注会话完成，通常修改不超过 5 个文件。
- 行为任务先写失败测试，再实现，再重构。
- 每项任务的验收、验证、文档和回滚说明同时完成后才能勾选。
- G0 未全部完成前，不开始新的产品能力；G1 未冻结前，不并行修改协议常量。
- 新增依赖、公开 API、协议 major、CI required check 和发布动作需负责人批准。

## Desktop Notes MVP 关键路径

| 阶段           | 依赖任务               | 产品结果                                            | 并行规则             |
| -------------- | ---------------------- | --------------------------------------------------- | -------------------- |
| M0 G2 退出门禁 | G2B-09、G2C-08、G2C-09 | 文本与 Surface/metrics 基础可信                     | 完成后才进入 G3 主链 |
| M1 编辑核心    | G3A-01..05、G3A-07     | normalized event、focus、selection、键盘与 hit-test | 合同顺序执行         |
| M2 IME/多行    | G3A-06、G3A-08..11     | 中文 IME 与 TextArea E2E                            | 依赖 M1              |
| M3 A11y/Task   | G3B-01..05、G4-01..04  | AccessKit 与 task/cancel/error/permission 合同      | G3B 与 G4 可并行     |
| M4 Files/Notes | G4-05..08、G5-01..04   | open/edit/save/cancel/close 应用闭环                | 依赖 M2/M3           |
| M5 交付        | MVP-01..02             | unsigned macOS/Windows 产物与最终矩阵               | 依赖 M4              |

完整 CLI onboarding、基础主题、Tier-1 Adapter Notes parity 和 G6 发布治理不阻塞 Desktop Notes MVP；它们继续属于 Technical Preview。

## G0：可信基线

| ID    | Todo                                   | Acceptance                                                                                     | Verify                                                   | Dependencies | Files                                                                                                        | Size |
| ----- | -------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ | ---- |
| G0-01 | [x] 修复 pnpm setup 双版本冲突         | Actions 只从 `packageManager` 读取一个准确版本                                                 | 重新运行 TypeScript workflow                             | 无           | `.github/workflows/typescript.yml`                                                                           | XS   |
| G0-02 | [x] 固定 Rust 与 Perry 工具链策略      | stable/MSRV/Perry CLI/Perry FFI 版本可追溯，两个 FFI crate 使用同一 Perry commit               | clean `cargo check --locked`；记录 `perry --version`     | G0-01        | `rust-toolchain.toml`、`packages/nui-host/Cargo.toml`、`packages/system-host/Cargo.toml`、两份 lock 策略文件 | M    |
| G0-03 | [x] 格式化 `nui-host` TS 核心          | 只产生格式变化，5 个 Host 文件通过 Prettier                                                    | `pnpm exec prettier --check` 指定文件                    | 无           | `ffi.ts`、`index.ts`、`node.ts`、`props.ts`、`tree.ts`                                                       | S    |
| G0-04 | [x] 格式化 Adapter TS                  | 只产生格式变化，Adapter 核心通过 Prettier                                                      | `pnpm exec prettier --check` 指定文件                    | 无           | Solid 3 文件、Vue 2 文件                                                                                     | S    |
| G0-05 | [x] 格式化 UI/System TS                | 只产生格式变化，UI/System 核心通过 Prettier                                                    | `pnpm exec prettier --check` 指定文件                    | 无           | UI mount 2 文件、Clipboard 1 文件、Svelte runtime 1 文件、System package 1 文件                              | S    |
| G0-06 | [x] 格式化示例第一组                   | Counter/Todo/Layout/Solid/Vue 相关文件通过 Prettier                                            | `pnpm exec prettier --check` 指定文件                    | 无           | 5 个示例文件                                                                                                 | S    |
| G0-07 | [x] 格式化示例第二组与 README          | Image/Clipboard/React/Svelte/parity 文件通过 Prettier                                          | `pnpm exec prettier --check` 指定文件                    | 无           | 5 个示例文件                                                                                                 | S    |
| G0-08 | [x] 清理剩余 Markdown/JSON 格式        | 根 README 与剩余 package JSON 通过 Prettier                                                    | `pnpm format:check`                                      | G0-03..G0-07 | 最多 5 个剩余文件/批                                                                                         | S    |
| G0-09 | [x] 修复 Rust format 第一组            | Core、Layout 文件无 rustfmt diff                                                               | `cargo fmt --all -- --check` 的目标 diff 消失            | 无           | `nui-core/src/tree/mod.rs`、`nui-layout-taffy/src/lib.rs`                                                    | XS   |
| G0-10 | [x] 修复 Rust format 第二组            | Bridge/Platform/Render 文件无 rustfmt diff                                                     | `cargo fmt --all -- --check`                             | G0-09        | Bridge 3 文件、Platform 1 文件、Render 1 文件                                                                | S    |
| G0-11 | [x] 处理 `Slot` Clippy 失败            | 选择有基准依据的 enum/arena 表示，禁止仅为过门禁盲目 allow                                     | `cargo clippy --workspace --all-targets -- -D warnings`  | G0-09        | `crates/nui-core/src/tree/mod.rs`、对应测试/benchmark 文件                                                   | S    |
| G0-12 | [x] 为所有 TS workspace 声明验证脚本   | Host、React、Svelte、Layout 等不再被聚合命令静默跳过；无 lint 的项目明确继承根 lint            | 脚本矩阵测试；`pnpm typecheck && pnpm test && pnpm lint` | G0-01        | 根 `package.json`、脚本检查器、最多 3 个 package 模板文件                                                    | M    |
| G0-13 | [x] 引入真实 TS lint                   | 至少覆盖 packages/examples，0 个 lint task 不能返回成功                                        | `pnpm lint` 输出实际检查文件数                           | G0-12        | 根 `package.json`、lint config、ignore 文件                                                                  | S    |
| G0-14 | [x] 修正 CI path filters 与 fail-open  | 10 个示例、两个 FFI crate、workflow 变更均触发正确 job；changes 失败会阻断                     | filter fixture 或 workflow 单元验证                      | G0-01        | `.github/workflows/ci.yml`、filter 测试/说明                                                                 | M    |
| G0-15 | [x] 新增 FFI Rust 门禁                 | `nui-host`、`system-host` 执行 fmt/check/clippy/test/native validate                           | 手动/PR 运行新 workflow                                  | G0-02、G0-14 | 新 FFI workflow、`ci.yml`、两个 Cargo 配置                                                                   | M    |
| G0-16 | [x] 完整化 TypeScript workflow         | required job 运行 format、lint、typecheck、unit、build，而非只跑前两项                         | PR workflow 绿；故意失败 fixture 能阻断                  | G0-12..G0-14 | `typescript.yml`、根 `package.json`                                                                          | S    |
| G0-17 | [x] 建立 clean Minimal TSX Perry smoke | 固定工具链从 clean checkout 编译并执行可退出的 Host 场景，覆盖 Perry ABI绑定/handle round-trip | CI smoke 输出版本和成功标记                              | G0-02、G0-15 | 新 smoke 脚本、Counter package、Host manifest、workflow                                                      | M    |
| G0-18 | [x] 建立框架 Counter 编译矩阵          | Solid/Vue/React/Svelte clean AOT build；失败不伪装成 parity 完成                               | [macOS/Windows matrix 8/8][g0-18-run]                    | G0-17        | workflow、matrix 脚本、parity 状态生成器                                                                     | M    |
| G0-19 | [x] 启用 branch protection             | `main` 要求 PR、review 和 `CI / result`；禁止直接绕过                                          | [GitHub API 回读][g0-baseline]                           | G0-14..G0-18 | GitHub repository settings                                                                                   | XS   |
| G0-20 | [x] 建立基线证据页                     | 记录准确命令、runner、版本、通过/失败，不再以 Slice 提交替代证据                               | docs check + CI 链接有效                                 | G0-16..G0-19 | `docs/BASELINE.md`、`docs/README.md`                                                                         | S    |

[g0-18-run]: https://github.com/baicie/nexa-ui/actions/runs/30878535145
[g0-baseline]: ./docs/BASELINE.md

微检查点：G0-01..02 验证工具链安装；G0-03..05 和 G0-06..08 分别运行局部/全量 Prettier；G0-09..11 运行完整 Rust 门禁；G0-12..13 验证每个 TS 项目实际被检查；G0-14..16 验证 CI 路由和 fail-closed；G0-17..18 验证 clean Perry matrix；G0-19..20 复核 required checks 与证据页。

### G0 Checkpoint

- [x] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿
- [x] `cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` 全绿
- [x] 两个独立 FFI crate 与 Perry clean smoke 全绿
- [x] macOS/Windows Rust smoke 全绿
- [x] `main` required checks 与 branch protection 生效

## G1：Host Contract v1

| ID    | Todo                                 | Acceptance                                                                                | Verify                                         | Dependencies | Files                                                            | Size |
| ----- | ------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------ | ---------------------------------------------------------------- | ---- |
| G1-01 | [x] 编写 Protocol/Handle/Error ADR   | 明确版本兼容、feature bits、handle 表示、错误码和废弃规则                                 | ADR review checklist                           | G0           | 新 ADR、decisions index                                          | S    |
| G1-02 | [x] 建立 UI protocol manifest        | common 只定义一次；Node/Property/Event/Command/Error 含可生成类型、feature 与生命周期合同 | schema + semantic guard tests                  | G1-01        | common/UI manifest、schema、fixture                              | M    |
| G1-03 | [x] 建立 System protocol manifest    | Command/Permission/Task/Resource/Error 与 UI ID 空间分离，Task/Resource 关联 Handle kind  | schema + cross-manifest drift tests            | G1-01        | common/System manifest、schema、fixture                          | M    |
| G1-04 | [x] 实现协议生成器                   | 生成 Rust/TS/Perry 片段，重复运行稳定，手改生成物会使 CI 失败                             | generator snapshot + `protocol:check`          | G1-02、G1-03 | 生成脚本、两类模板、根脚本、测试                                 | M    |
| G1-05 | [x] 接入生成的 Rust 协议定义         | Core/Bridge 不再手写重复 enum 数值                                                        | `cargo test -p nui-core -p nui-perry-bridge`   | G1-04        | generated Rust、`nui-core/lib.rs`、style/tree/event 入口         | M    |
| G1-06 | [x] 接入生成的 TS/manifest 定义      | `packages/ui/src/host.ts` 重复定义删除；manifest functions 与生成结果一致                 | `pnpm typecheck` + drift test                  | G1-04        | generated TS、Host exports、UI host、package manifest            | M    |
| G1-07 | [x] 实现 Protocol/ABI handshake      | 启动返回双方版本与 feature intersection；major 不兼容结构化失败                           | Rust/TS contract + Perry smoke                 | G1-05、G1-06 | Bridge handshake、FFI export、TS wrapper、manifest、test         | M    |
| G1-08 | [x] 验证无损 handle transport        | 最大 slot/generation round-trip；TS 拒绝错误 shape/范围；native 不读取 HandleRef jsvalue  | Perry native round-trip + codec negative tests | G1-01、G1-07 | handle codec Rust/TS、manifest、fixture                          | M    |
| G1-09 | [x] 增加 tree mutation 校验          | stale/非法 parent/环/跨 owner 原子失败；generation 溢出永久退休，不回绕复用               | `cargo test -p nui-core mutation`              | G1-05        | mutation module、tree module、error module、tests                | M    |
| G1-10 | [x] 补齐 clear property              | null/removed prop 恢复默认或 unset；Min/Max/Opacity/FontWeight 不再公开后静默忽略         | Host contract tests                            | G1-06、G1-09 | Host props、Bridge command、Style、tests                         | M    |
| G1-11 | [x] 补齐 listener replace/remove     | listener 更新不叠加；remove 后 root 释放；私有 raw ptr 前由 wrapper 验证 closure          | TS negative + Rust callback registry tests     | G1-06、G1-09 | Host props/tree、FFI TS/Rust、tests                              | M    |
| G1-12 | [x] 修复 subtree dispose locality    | 删除节点停止 descendant effect，清理所有 descendant callback/input/image 状态             | leak/regression tests                          | G1-11        | UI mount owner、signal scope、Host remove、Bridge cleanup、tests | M    |
| G1-13 | [x] 统一 Minimal TSX Host kit        | Minimal TSX 不再复制 Adapter 的 defaults/props/tree 语义                                  | mutation trace 与旧场景等价                    | G1-10..G1-12 | UI materialize、Host kit exports、mount tests                    | M    |
| G1-14 | [x] 建立 Adapter conformance harness | create/insert/move/reorder/clear/listener/dispose 场景可复用于所有 Adapter                | `pnpm test:contracts`                          | G1-13        | Mock Host、scenario fixtures、runner、root test config           | M    |
| G1-15 | [x] 接入 Solid/Vue conformance       | 两个 Adapter 生成预期 mutation trace                                                      | filtered contract tests                        | G1-14        | Solid/Vue adapter 入口、两份测试、fixture                        | M    |
| G1-16 | [x] 接入 React/Svelte conformance    | React lifecycle 与真实 Svelte compile fixture 通过；不以手写 Svelte driver 代替           | filtered contract + compile fixture            | G1-14        | React/Svelte 入口、两份测试、fixture                             | M    |

微检查点：G1-01..03 评审并校验两个 schema；G1-04..06 运行生成物 drift 和编译；G1-07..08 跑 handshake/handle Perry round-trip；G1-09..11 跑 mutation/clear/listener 合同；G1-12..14 跑 dispose/统一 Host/conformance harness；G1-15..16 跑全部 Adapter 合同。

### G1 Checkpoint

- [x] 协议生成物零漂移，handshake 与 handle round-trip 通过
- [x] 所有设置均可撤销，所有 listener/effect 均可释放
- [x] 非法 mutation 原子失败，Tree 不变量测试通过
- [x] Minimal/Solid/Vue/React/Svelte conformance 状态有自动证据

## G2A：Application Runtime

| ID     | Todo                                    | Acceptance                                                        | Verify                                                                      | Dependencies   | Files                                                      | Size |
| ------ | --------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------- | ---- |
| G2A-01 | [x] 定义 `MutationBatch` 与 receipt     | batch 有 sequence/owner/commands；validate 与 apply 分离          | Core unit/property tests                                                    | G1             | mutation types、error、tests                               | M    |
| G2A-02 | [x] 让 Host FFI 入队 mutation           | create/set/insert/remove 不再直接改变 active Tree                 | Bridge tests 断言 commit 前不可见                                           | G2A-01         | Bridge host、FFI exports、TS wrapper、tests                | M    |
| G2A-03 | [x] 实现原子 `commit()`                 | 任一命令失败整批拒绝；成功返回 dirty/sequence 并只请求一次 redraw | batch rollback tests + Perry smoke                                          | G2A-02         | runtime commit、Bridge host、FFI export、tests             | M    |
| G2A-04 | [x] 实现 Dispatcher 与 wakeup           | platform/system/framework 队列可并发投递，UI tick 有序 drain      | dispatcher concurrency tests                                                | G2A-03         | dispatcher、winit wakeup、runtime lib、tests               | M    |
| G2A-05 | [x] 实现十阶段 Scheduler                | 阶段顺序固定；Layout/Paint mutation 与嵌套 frame 被拒绝           | scheduler state tests                                                       | G2A-04         | scheduler、frame clock、error、tests                       | M    |
| G2A-06 | [x] 迁移 Native callback 到队列         | winit/Bridge 只 enqueue，Perry closure 在 Framework 阶段调用      | event order integration test                                                | G2A-04、G2A-05 | platform event、Bridge window、FFI callback、tests         | M    |
| G2A-07 | [x] 实现 owner-scoped callback registry | callback 有 generation/owner/state；close/remove 可幂等失效       | registry owner/stale/late-event tests；FFI callback tests                   | G2A-06         | callback registry、owner lifecycle、Bridge adapter、tests  | M    |
| G2A-08 | [x] 实现 app/window lifecycle 与 reset  | mount-close-remount 不继承 root/focus/callback；close 顺序可测    | lifecycle integration + Host FFI reset + Perry/framework AOT smoke          | G2A-07         | lifecycle、Bridge session、platform close、TS entry、tests | M    |
| G2A-09 | [x] 实现 ErrorSupervisor                | Protocol/Operation/Frame/Fatal 分类进入可观察 sink，不只 stderr   | `cargo test -p nui-app-runtime error_supervisor`; Bridge/Host routing tests | G2A-05、G2A-08 | error supervisor、errors、platform adapter、tests          | M    |
| G2A-10 | [x] 去除 React `flushSync` 事件补丁     | React 依赖统一 tick 仍正确更新，timer/microtask 行为可测          | React conformance + Perry Counter                                           | G2A-06         | React adapter、scheduler bridge、React tests               | M    |

微检查点：G2A-01..03 验证 batch 原子性；G2A-04..06 验证 tick/event 顺序；G2A-07..08 跑 callback/lifecycle 泄漏测试；G2A-09..10 跑错误路由和 React Perry 回归。

G2A-09 evidence（2026-08-05）：

- `cargo test -p nui-app-runtime error_supervisor`
- `cargo test -p nui-platform-winit platform_failure_stages_have_stable_routing_metadata`
- `cargo test -p nui-perry-bridge structured_error_tests`
- `cargo test -p nui-perry-bridge`
- `cargo test --manifest-path packages/nui-host/Cargo.toml --lib`
- `cargo clippy -p nui-platform-winit --all-targets -- -D warnings`
- `cargo clippy -p nui-perry-bridge --all-targets -- -D warnings`
- `cargo clippy --manifest-path packages/nui-host/Cargo.toml --all-targets -- -D warnings`

实现证据：`ErrorSupervisor` 保留四级有界历史和首个 Fatal latch；FFI export 统一由 panic guard 保护；平台故障使用 typed `PlatformFailure`；renderer failure 跳过当前 frame present；listener 未知 generation 返回 `STALE_HANDLE`。

G2A-10 evidence（2026-08-05）：

- `node --test tools/adapter-contracts.test.mjs`（12/12，包括 React event/microtask ordering 与 bridge source contract）
- `pnpm --filter @nexa/adapter-react typecheck`
- `node tools/perry-frameworks.mjs react`（Perry 0.5.1220 clean AOT/link，macOS arm64，生成非空 `examples/react-counter/react-counter`）
- `git diff --check`

实现证据：React Host event 不再包装 `flushSync`；使用 concurrent root、`DiscreteEventPriority` 与 `supportsMicrotasks`，调度桥使用 Promise continuation 以避免 Perry 未导出的 `queueMicrotask` symbol。根首次 render/unmount 的 `flushSync` 仅用于显式 root API 边界。

## G2B：Text Foundation

| ID     | Todo                                | Acceptance                                                       | Verify                                    | Dependencies   | Files                                                     | Size |
| ------ | ----------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- | -------------- | --------------------------------------------------------- | ---- |
| G2B-01 | [x] 做文本依赖 spike 并写 ADR       | 候选方案以包体、平台字体、BiDi、Emoji、Skia 集成比较；负责人批准 | spike report + fixture output             | G1             | 新 ADR、spike crate/fixture、decisions index              | M    |
| G2B-02 | [x] 实现 `TextIndexMap`             | UTF-16/UTF-8/scalar/grapheme 显式互转，组合字符/Emoji round-trip | property/fuzz tests                       | G2B-01         | text index module、selection types、tests                 | M    |
| G2B-03 | [x] 实现 FontDatabase 与 fallback   | 按 family/style/script 解析，缺字能选择 fallback，缓存可失效     | font fixture tests                        | G2B-01         | font database、fallback、Cargo deps、tests                | M    |
| G2B-04 | [x] 实现 script/BiDi/shaping        | 输出 glyph、advance、cluster 与方向；不丢 ZWJ/修饰符             | acceptance shaping tests                  | G2B-02、G2B-03 | bidi、shaping、types、tests                               | M    |
| G2B-05 | [x] 实现 line breaking 与 paragraph | 给定宽度输出 lines/baselines/cluster hit map                     | paragraph fixture tests                   | G2B-04         | line breaking、paragraph、types、tests                    | M    |
| G2B-06 | [x] 接入 Taffy 文本测量             | measure callback 使用 paragraph snapshot/cache，不用字符数估算   | layout integration tests                  | G2B-05         | layout adapter、paragraph cache、core text content、tests | M    |
| G2B-07 | [x] 增加 GlyphRun Display command   | paragraph 可生成 backend-neutral glyph commands                  | display list snapshot                     | G2B-05         | core display list、text paint bridge、tests               | M    |
| G2B-08 | [x] Skia 执行 GlyphRun              | production TextNode 不调用 `draw_str`；scale/DPI 正确            | renderer golden tests                     | G2B-07         | Skia renderer、glyph resource adapter、tests              | M    |
| G2B-09 | [x] 建立多语言 golden/fuzz 集       | ADR 样例、窄换行、缺字、RTL 混排、Emoji 在 CI 可重复             | `cargo test -p nui-text` + visual fixture | G2B-06、G2B-08 | fixtures 最多 3 个、test runner、golden manifest          | M    |

微检查点：G2B-01..03 完成依赖评审、索引和字体 fixture；G2B-04..06 验证 shaping/paragraph/layout 一致；G2B-07..09 验证 GlyphRun 和完整多语言验收集。

G2B-04 evidence（2026-08-05）：

- `cargo test -p nui-text`（26/26：script、BiDi、Latin ligature、CJK、Arabic joining/mark、Emoji modifier/VS/ZWJ、混排 fallback、TTC/invalid source、empty/range/size/missing glyph 错误）
- `cargo clippy -p nui-text --all-targets -- -D warnings`
- `RUSTDOCFLAGS="-D warnings" cargo doc -p nui-text --no-deps`
- `cargo fmt --all -- --check`
- `git diff --check`

实现证据：`FontSource { Arc<[u8]>, face_index }` 由 FontDatabase 与 rustybuzz 共享；fallback 不拆 extended grapheme；glyph cluster 保留原文绝对 UTF-8 offset；advance/offset 转为有限 logical pixels，数值溢出返回结构化 `ShapeError`。Paragraph、逐行 BiDi reorder 与原文空行/尾随换行语义已由 G2B-05 完成。

G2B-05 evidence（2026-08-05）：

- `cargo test -p nui-text --test line_breaking_contract`（4/4）
- `cargo test -p nui-text --test paragraph_contract`（18/18）
- `cargo test -p nui-text`（48/48；其中 G2B-05 合同 22 个）
- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `RUSTDOCFLAGS="-D warnings" cargo doc -p nui-text --no-deps`
- `cargo fmt --all -- --check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm format:check`
- `git diff --check`

实现证据：`unicode-linebreak =0.1.5` 的 typed UAX #14 opportunity 经 grapheme boundary 过滤；CRLF 与全部 hard separator 保留 source range；贪心选择最后可容纳的安全断点，不可断 grapheme 整体 overflow。每个 non-empty line 独立执行 UAX #9 L1/L2；fallback line metrics 对实际参与字体的 ascent/descent/leading 分别取最大值；snapshot 输出 positioned runs、cluster bounds 与 affinity-aware caret stops。字体省略的 default-ignorable grapheme 合成 zero-advance cluster，极端多行几何溢出返回 `NonFiniteGeometry`。Taffy measure 已由 G2B-06 完成；GlyphRun display command 与 Skia 执行随后由 G2B-07..08 完成。

G2B-06 evidence（2026-08-05）：

- `cargo test -p nui-text`（50/50，包括 2 个 source-backed system-font 合同）
- `cargo test -p nui-layout-taffy`（10/10）
- `cargo test -p nui-perry-bridge`（51/51）
- `cargo test --manifest-path packages/nui-host/Cargo.toml --lib`（9/9）
- `cargo clippy -p nui-text -p nui-layout-taffy -p nui-perry-bridge --all-targets -- -D warnings`
- `cargo clippy --manifest-path packages/nui-host/Cargo.toml --all-targets -- -D warnings`
- `RUSTDOCFLAGS="-D warnings" cargo doc -p nui-text -p nui-layout-taffy -p nui-perry-bridge --no-deps`
- `cargo fmt --all -- --check`
- `git diff --check`

实现证据：`layout_tree_with_cache` 的 Taffy measure callback 消费 revision-aware `ParagraphSnapshot`，映射 `Definite/MinContent/MaxContent`，并把每个节点的 `font_weight` 纳入 `FontRequest` 与 cache identity；默认 cache 最多保留 256 个 snapshot。`nui-text` 以已有 `ttf-parser` 有界发现 macOS/Windows/Linux 系统 TTF/OTF/TTC，Perry `HostSession` 默认安装 source-backed 字体；应用也可通过校验后的 `NuiHost::with_fonts` 注入。FontDatabase 是 process resource，`reset()` 只清 snapshot。Host layout、window paint、pointer 与 wheel 的 typed layout failure 均在释放 Host 锁后进入 `ErrorSupervisor`；失败 paint 丢帧，pointer/wheel 跳过不可靠几何。生产 crate 不再调用字符数近似 `measure_text`；无注入 cache 的 `layout_tree` 仅保留为非生产兼容入口。

G2B-07 evidence（2026-08-05）：

- `cargo test -p nui-core paint::tests`（5/5）
- `cargo test -p nui-layout-taffy display_list_uses_paragraph_glyph_positions_and_font_identity`（1/1）
- `cargo fmt --all -- --check`

实现证据：Core 新增 `DisplayGlyph`、`GlyphRun`、`TextBox` 和 `DisplayList::try_from_arena_with_glyph_runs`；Core 只负责树遍历、scroll/opacity/clip 顺序，`nui-layout-taffy::display_list_with_cache` 用已布局矩形请求同一 `ParagraphCache`，把 `PositionedRun` 的 FontId、glyph ID、logical-pixel x/y 和颜色转换为 immutable commands。生产 Host/window paint 已切换到该路径，legacy `DisplayList::from_arena` 仅保留旧 smoke 兼容。

G2B-08 evidence（2026-08-05）：

- `cargo test -p nui-render-skia`（11/11）
- `cargo test -p nui-perry-bridge injected_paragraph_metrics_drive_layout_and_fonts_survive_reset`（1/1，含 Host source-backed glyph paint）
- `cargo clippy -p nui-core -p nui-layout-taffy -p nui-render-skia -p nui-platform-winit -p nui-perry-bridge --all-targets -- -D warnings`

实现证据：Skia 对 `GlyphRun` 通过 `FontPaint { font_id, Arc bytes, face_index }` 解析与 rustybuzz 相同的字体 face，并使用 `draw_glyphs_at`；字号、glyph positions 按 device scale 同步缩放，缺失/损坏 font resource 与非有限几何返回 typed `PaintError`。生产 TextNode 的内容命令不再调用 `draw_str`；`Text`/placeholder 仍仅属于 legacy/focused overlay 兼容路径。

G2B-09 evidence（2026-08-05）：

- `cargo test -p nui-text`（54/54；其中 2 个 multilingual golden/property 测试）
- `cargo clippy -p nui-text --all-targets -- -D warnings`
- `cargo fmt --all -- --check`、`git diff --check`

实现证据：`multilingual-golden.json` 固定 Latin 窄换行、CJK 窄换行、Arabic/Latin BiDi 视觉顺序和 Emoji ZWJ 零宽 overflow 的 1/64 logical-pixel geometry、glyph ID、cluster、run；固定 seed 的 256 个混合 Latin/CJK/Arabic/Emoji/硬换行案例重复布局并检查 source coverage、grapheme boundary、有限几何、visual cluster 顺序与 LTR/RTL/0/窄/无限宽约束。字体来源、许可证、golden 量化和只打印不写盘的更新命令记录在 `crates/nui-text/tests/fixtures/README.md`。

G2C-05 evidence（2026-08-05）：

- `cargo test -p nui-platform-winit surface_lifecycle_preserves_state_across_suspend_and_recreate`（1/1）
- `cargo test -p nui-platform-winit`（4/4）

实现证据：`SurfaceLifecycle` 固定 Absent/Ready/Suspended/Recreating/Failed 状态与幂等转换；winit `resumed` 进入 Recreating 后创建窗口/context/surface，成功转 Ready，`suspended` 释放 window-owned backend resources 并保留 app state，创建/resize/acquire/present 失败转 Failed。

G2C-03/04/06 evidence（2026-08-05）：

- `cargo test -p nui-core`（32/32）、`cargo test -p nui-text`（52/52）、`cargo test -p nui-layout-taffy`（13/13）
- `cargo test -p nui-render-skia`（17/17）、`cargo test -p nui-platform-winit`（7/7）、`cargo test -p nui-perry-bridge`（54/54）
- `cargo clippy -p nui-core -p nui-text -p nui-layout-taffy -p nui-render-skia -p nui-platform-winit -p nui-perry-bridge --all-targets -- -D warnings`
- `cargo fmt --all -- --check`、`git diff --check`

实现证据：Core `ResourceStore<T>` 统一 generation-bearing `ResourceId`，Image、Font 与 Paragraph 的 stale handle、clear/reset high-water mark、slot reuse 和 generation retirement 均有生命周期测试；Tree 只保存 CPU resource identity。图片 path 首次 decode 后共享 `Arc<[u32]>`，Skia cache 用 no-copy `Data` 保活 CPU pixels，同一 Surface generation 复用 Image/Typeface，generation 变化后 image/font upload counter 各自递增。`SurfaceLifecycle` 仅在成功 recreate 后递增 generation 并设置 full-repaint pending；resize/acquire/present loss 释放 surface/context/window，`about_to_wait` 自动重建，Bridge 在 `surface_ready` 切换 cache generation，首个成功 present 恰好清除恢复标记。注入 loss 测试验证 `Ready(g1) -> Failed -> Recreating -> Ready(g2)`、失败不递增、重复 Ready 幂等且业务状态保留。

G2C-07 evidence（2026-08-05）：

- `cargo test -p nui-app-runtime`（23/23）、`cargo test -p nui-layout-taffy`（14/14）
- `cargo test -p nui-platform-winit`（8/8）、`cargo test -p nui-perry-bridge`（70/70）
- `cargo clippy -p nui-app-runtime -p nui-layout-taffy -p nui-platform-winit -p nui-perry-bridge --all-targets -- -D warnings`
- `cargo fmt --all -- --check`、`git diff --check`

实现证据：可注入 `FrameClock` 与有界 `FrameMetricsObserver` 记录 tick/frame/surface generation、真实阶段耗时、工作量和 Presented/Dropped/Coalesced/NoPresentRequested 结果；history 淘汰不影响 lifetime totals，sink panic 被隔离且在 observer/Host 锁外调用。Dispatcher drain、framework callback、commit receipt、layout Arena 节点、display command、paint 与 platform present 均在实际执行点计数；尚未执行的 Semantics 保持零。集成测试覆盖同 tick 两次 framework 更新与三条 mutation 只 present 一次，以及 Layout/Paint/Acquire/Present drop、重复 presented 幂等和 Surface generation 传播。

G2C-08/09 evidence（2026-08-05）：

- `cargo test -p nui-app-runtime`（23/23）、`cargo test -p nui-render-skia`（17/17）、`cargo test -p nui-platform-winit`（8/8）、`cargo test -p nui-perry-bridge`（70/70）
- `cargo clippy -p nui-app-runtime -p nui-render-skia -p nui-platform-winit -p nui-perry-bridge --all-targets -- -D warnings`
- `cargo fmt --all -- --check`、`git diff --check`

实现证据：pending redraw 使用单槽并在新 tick 到达时 coalesce 旧 tick；session identity 由 Arena owner 区分 reset 后重复 tick/frame ID；run 前 mount commit 建立基线；close/Drop 恰好 flush pending/active recorder。Platform suspend hook 和 Bridge `invalidate_surface_resources` 在 suspend、acquire loss、present loss 立即清空 Image/Typeface backend cache，CPU resource 与 upload lifetime counters 保留；只读 cache count 和 re-upload tests 证明恢复后每类资源各上传一次。

## G2C：Display List 与 Surface

| ID     | Todo                                 | Acceptance                                                                          | Verify                             | Dependencies   | Files                                                     | Size |
| ------ | ------------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------- | -------------- | --------------------------------------------------------- | ---- |
| G2C-01 | [x] 定义 DirtyFlags 与 Display List  | Tree 派生不可变 command list，命令不含 Skia 类型                                    | Core snapshot/property tests       | G1             | core dirty、display list、tree、tests                     | M    |
| G2C-02 | [x] 迁移矩形/clip/image 绘制         | Renderer 只消费 Display List，不直接遍历 Arena                                      | render integration tests           | G2C-01         | paint builder、Skia executor、Bridge paint、tests         | M    |
| G2C-03 | [x] 建立 ResourceStore               | Image/Font/Paragraph 用 generation `ResourceId`；Tree 不存 backend 对象             | resource lifecycle tests           | G2C-01         | resource module、NodeContent、Bridge assets、tests        | M    |
| G2C-04 | [x] 消除图片每帧 clone/copy          | decode 一次、共享 CPU pixels、按 Surface generation 上传                            | allocation/counter test            | G2C-02、G2C-03 | Bridge image store、Skia image cache、tests               | M    |
| G2C-05 | [x] 实现 Surface 状态机              | Absent/Ready/Suspended/Recreating/Failed 转换明确，重复 resume 幂等                 | state machine tests                | G2C-02         | platform surface、composition types、tests                | M    |
| G2C-06 | [x] 接入 suspend/resume full repaint | 恢复后重建资源并完整 present，业务状态保留                                          | injected surface-loss integration  | G2C-03..G2C-05 | winit handler、Skia cache、runtime lifecycle、tests       | M    |
| G2C-07 | [x] 增加 frame observability         | 每 tick 记录 mutation/layout/semantic/display 数和阶段耗时                          | deterministic metrics test         | G2A-05、G2C-02 | metrics、scheduler hooks、diagnostic output、tests        | M    |
| G2C-08 | [x] 硬化 metrics session 生命周期    | pending tick 有界；close/drop 收尾；跨 session identity 唯一；pre-run commit 不错归 | metrics lifecycle regression tests | G2C-07         | Runtime metrics、Bridge frame state/window/host、tests    | M    |
| G2C-09 | [x] Suspend 立即释放 backend cache   | suspend 后、resume 前 Image/Typeface cache 为空；CPU state 保留；恢复各重上传一次   | injected suspend/cache integration | G2C-06         | Platform lifecycle hook、Skia cache、Bridge window、tests | M    |

微检查点：G2C-01..02 验证 Tree 到 Skia 的不可变接缝；G2C-03..04 验证资源生命周期和图片分配；G2C-05..07 验证 Surface 恢复与 frame metrics。

### G2 Checkpoint

- [x] Native 事件经 Dispatcher，mutation 仅在 commit 生效
- [x] Paragraph 同时驱动 layout 与 GlyphRun paint
- [x] Renderer 不遍历可变 Tree，Surface 可恢复
- [x] Todo 多次状态更新在单 tick 只 present 一次
- [x] G2B-09 多语言 golden/property 集完成
- [x] G2C-08/09 生命周期审查补强完成

## G3A：Focus、EditableText 与 IME

| ID     | Todo                                    | Acceptance                                                                      | Verify                               | Dependencies           | Files                                                                    | Size |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------ | ---------------------- | ------------------------------------------------------------------------ | ---- |
| G3A-01 | [x] 定义 normalized event schema        | Pointer/Wheel/Keyboard/TextInput/Composition/Focus 字段和 propagation 一致      | protocol round-trip tests            | G1、G2A                | protocol manifest、core event types、generated outputs、tests            | M    |
| G3A-02 | [x] 实现 FocusManager 与 Tab chain      | 单窗口唯一 focus；Tab/Shift+Tab/删除节点/恢复行为明确                           | focus unit + Bridge window tests     | G3A-01                 | focus module、Host shadow/commit hooks、winit key path、tests            | M    |
| G3A-03 | [x] 实现 pointer capture 与三阶段派发   | capture/target/bubble、stop propagation、default action 可测                    | Core dispatch + Bridge pointer tests | G3A-01、G3A-02         | Core event dispatcher、Host pointer lifecycle、winit release path、tests | M    |
| G3A-04 | [x] 实现 `EditableText` value/selection | grapheme 安全插入删除、selection collapse/extend、revision 检查                 | editable text property tests         | G2B-02、G2B-05         | editable text、selection、index map、tests                               | M    |
| G3A-05 | [x] 实现键盘编辑命令                    | Arrow、Backspace、Delete、Home/End、Shift selection 与平台 modifier 正确        | command table tests                  | G3A-01、G3A-04         | keyboard commands、editable text、platform key map、tests                | M    |
| G3A-06 | [x] 接入 IME composition                | Start/Update/Commit/Cancel 更新 preedit/range，避免 KeyboardInput 重复插入      | platform event integration           | G3A-04、G3A-05         | winit IME、composition model、dispatcher bridge、tests                   | M    |
| G3A-07 | [x] 实现 caret/selection hit testing    | point <-> text offset、caret bounds、selection rects 使用 paragraph cluster map | paragraph hit-test tests             | G2B-05、G3A-04         | paragraph hit test、editable layout、paint commands、tests               | M    |
| G3A-08 | [x] 实现 `TextArea` 多行布局与滚动      | Input/TextArea 复用 EditableText；Enter、上下移动、可见行和内部滚动正确         | multiline editor tests               | G3A-04、G3A-05、G3A-07 | TextArea primitive、multiline controller、paragraph viewport、tests      | M    |
| G3A-09 | [x] 接入 TextInputClient FFI            | surrounding text/selection/replace/composition bounds 无损跨边界                | contract + Perry tests               | G3A-06..G3A-08         | protocol、Bridge client、TS interface、FFI manifest、tests               | M    |
| G3A-10 | [x] 完成 Button interaction states      | invoke 在合法 release/Space/Enter；hover/pressed/focus/disabled 状态可观察      | component/event tests                | G3A-02、G3A-03         | Button primitive、default action、style state、tests                     | M    |
| G3A-11 | [x] 建立 CJK/Emoji 输入 E2E             | 单行/多行 preedit、候选 bounds、跨行选择、删除、复制粘贴可复现                  | macOS/Windows scenario               | G3A-09、G3A-10         | E2E scenario、fixture app、platform harness                              | M    |

微检查点：G3A-01..03 验证事件/焦点/派发；G3A-04..06 验证编辑命令和 IME 模型；G3A-07..09 验证命中、多行和 FFI；G3A-10..11 验证控件状态与平台 E2E。

G3A-01 evidence（2026-08-05）：

- `protocol/nui-host.json` 新增稳定 `Pointer`/`Wheel`/`Keyboard`/`TextInput`/`Composition`/`Focus` IDs 4–9，以及共享 `EventContext`、`EventModifiers`、`PropagationState` 类型。
- `timestamp` 使用十进制字符串承载单调时钟值，避免 JS safe-integer 截断；`CompositionEvent.selectionStart/selectionEnd` 固定为 UTF-16 code units。
- `nui-core::event` 公开生成的事件类型；Rust serde 与 TypeScript JSON round-trip 测试覆盖 CJK、Emoji、可空 target、传播状态和超过 `2^53` 的时间戳。
- `cargo test --workspace`、`cargo clippy --workspace --all-targets -- -D warnings`、`pnpm test:protocol`、协议 drift 检查和严格 TypeScript 编译均通过。

G3A-02 evidence（2026-08-05）：

- `crates/nui-core/src/focus.rs` 新增单窗口 `FocusManager` 与 `FocusRegistration`；正 `tab_index` 按值优先、同值按树顺序，零值按文档顺序，负值不进入 Tab 链但允许显式 focus，禁用和 stale generation 自动排除。
- `reconcile` 保存上一条 focus chain；删除或禁用当前节点时优先选择删除位置后的下一个节点，其次选择前一个节点，链为空时清除焦点。Core 单元测试覆盖排序、循环、显式负 tab index 与三段删除恢复。
- `nui-perry-bridge` 在 active/pending Host 状态中复制 FocusManager；Input 注册、指针命中、立即删除、shadow 删除、commit、reset 均同步焦点镜像。`nui-platform-winit` 归一化 Tab 与 Shift modifier 并调用 Host Tab 路径。
- `cargo test -p nui-core focus::tests` 4/4、`cargo test -p nui-perry-bridge window::tests::tab_and_shift_tab_update_host_focus_mirror` 1/1、`cargo test -p nui-platform-winit` 8/8 通过。

G3A-03 evidence（2026-08-05）：

- `crates/nui-core/src/event/dispatch.rs` 新增 `EventDispatcher`、`PointerCapture`、`event_path` 与 `DispatchResult`；路径固定 root→target，执行 capture→target→bubble→default action。
- `stopPropagation`/`stopImmediatePropagation` 会阻止后续路径，`preventDefault` 才跳过 default action；pointer capture 校验 Arena owner/generation，stale target 自动释放并回退到 hit target。
- `nui-perry-bridge` 按下建立 pointer capture，释放时统一 dispatch；只有释放回原 pressed target 才排入 `HostUiEvent::Click`。`nui-platform-winit` 新增 left-button release hook。
- `cargo test -p nui-core event::dispatch::tests` 5/5、`cargo test -p nui-perry-bridge window::tests::pointer_capture_clicks_only_when_release_returns_to_pressed_target` 1/1、Bridge 72/72、Platform 8/8、目标 Clippy 通过。

G3A-04 evidence（2026-08-06）：

- `TextIndexMap`、`EditableText`、`TextSelection` 已提供 extended-grapheme 安全的替换、前后删除、collapse/extend、UTF-16 边界转换和 revision 检查；组合字符、Emoji ZWJ、surrogate interior 与 stale revision 有确定性单测。
- `editable_text_property` 使用固定 seed `0x4e45584147334134` 执行 512 步选择、caret extend/collapse、Latin/CJK/RTL/combining/ZWJ/Emoji 插入替换、前后删除与 stale revision 拒绝，并以独立 reference model 验证 value、selection、revision、UTF-8/UTF-16/scalar/grapheme 双向边界不变量。

G3A-05 evidence（2026-08-06）：

- winit 的 `text_editing_command` 将原始 modifier snapshot 映射为平台中立意图：macOS Option=word、Command=line/document；Windows Ctrl=word/document；无修饰 Home/End 保持视觉行边界，AltGr/不支持 chord 不会误触发 word edit。`nui-text::KeyModifiers` 已收敛为 `shift + word`，平台原始键不再泄漏到编辑核心。
- paragraph-aware Left/Right 按视觉 caret stop 与 BiDi affinity 移动并跨 soft-wrap；mixed Arabic/LTR 合同证明视觉相邻但逻辑不相邻的移动、Shift extend 和 Bridge 真实键路径。Home/End、word navigation/deletion、Shift selection 的 macOS/Windows 命令矩阵与既有 TextArea Up/Down/preferred-x 合同共同通过。

G3A-06 evidence（2026-08-06）：

- `EditableText::ActiveComposition` 保存精确 UTF-8 preedit byte range、相对 UTF-16 selection 与 cancel snapshot；combining mark/Emoji ZWJ 不要求独立 grapheme boundary。Update、Commit、Cancel 只替换精确 bytes，非法 surrogate selection、revision overflow 与 legacy clear/update 均原子处理。
- winit 保留公开 `ime_preedit` cursor 的 UTF-8 byte 语义，并校验后显式转换为 UTF-16。`Idle -> Active -> ClearedPendingCommit` 路由将标准 `Preedit("") -> Commit` 识别为提交而非伪 Cancel；空 Commit 仍终止 composition，活动 preedit 期间普通文本、编辑命令和 repeat 全部抑制。
- Start/Update/Commit/Cancel 进入 Core `EventDispatcher` 后按 FIFO 排入 Runtime，Commit 保证早于对应 Change；Tab、pointer 与 focus loss 会向旧 target 发送恰好一次 Cancel。Perry 稳定 listener ABI 接受 EventId 8，Rust 生成的 camelCase JSON 被 Host prop 解码为 `Ui.CompositionEvent`。
- MVP 上下文目前固定单窗口 `windowId = 1`，timestamp 为单调十进制字符串，modifier snapshot 暂为全 false；异步 Host callback 尚不能同步影响 default action，因此本项不宣称完整可取消传播语义。
- 验证：Text `86/86`、Platform `22/22`、Bridge `108/108`、Perry Host Rust `12/12`、Host props `8/8`；四组严格 Clippy、Rustfmt 与目标 Prettier 全部通过。

G3A-07 evidence（2026-08-06）：

- `ParagraphSnapshot` 已提供 point -> `TextHit`、affinity-aware caret bounds 和 cluster-based selection rect；Bridge pointer hit-test、caret paint、composition bounds 共用 paragraph geometry 与祖先 Scroll offset，软换行边界优先匹配 caret affinity。
- `selection_rects` 现在按视觉 cluster 顺序分段，遇到未选 cluster 即结束当前 rect，不再用整行 `min..max` 覆盖 mixed-BiDi gap。真实 Arabic/LTR fixture 验证不连续视觉岛，并穷举全部 grapheme selection range，逐 cluster 断言“选中当且仅当被 rect 覆盖”；所有 caret stop 的 point -> hit -> bounds round-trip 保持合法 grapheme boundary 与几何位置。
- 定向验证：`nui-text` 80/80、Platform 19/19、Bridge 105/105，三 crate 严格 Clippy、Rustfmt 与 diff-check 通过。

G3A-08/09 evidence（2026-08-06）：

- `TextArea` 以 `Scroll + Text` 复合组件复用 `EditableText`；Enter、多行视觉 Up/Down/Home/End、preferred-x、caret 自动滚动、controlled value/placeholder/change/clear 合同已接入。`tools/textarea-contract.test.mjs` 已进入根 `pnpm test`，覆盖软换行、CJK、mixed RTL、Emoji ZWJ、CRLF 和短行 preferred-x。
- G3A-09 已完成：Bridge 以 paragraph caret geometry 和祖先 Scroll offset 生成逻辑坐标候选框；平台以 `Disabled` / `Enabled(None)` / `Enabled(Some(area))` 三态同步 winit IME，布局暂不可用时保持 composition。Host 三个 TextInputClient v1 extern 和 Perry AOT smoke 验证真实 Input/TextArea、UTF-16 surrogate-pair replace (`A😀B -> A中B`)。

G3A-10 evidence（2026-08-06）：

- `InteractionModel` 和 Bridge 已覆盖 Hovered/Pressed/Focused/Disabled：winit `CursorMoved`/`CursorLeft` 转发 hover，pointer press 建立 focus/capture，移出后取消 pressed、移回后重新 armed，合法 release 才排入 Click；disabled Button 不建立/保留 capture，也不响应 release/Space/Enter。
- focused Button 的首次 Enter/Space 与 repeated key 共享平台队列，repeat bit 被保留且 repeated Enter/Space 不重复排入 Click；keydown/keyup 分别设置和清除 keyboard pressed，focus loss 只清 keyboard source，不会破坏 pointer capture。focused Input 的 text、方向键和删除仍允许系统 repeat。
- 最后一个 immediate/queued Click listener 移除后分别在立即路径和 commit 边界清理 clickable、InteractionModel、FocusManager registration 与 focused 状态；Change/Submit listener 不会误删 hit target。
- Core 新增稳定、可组合的 public `InteractionStateToken`，同时保留 hovered/pressed/focused/disabled；style resolver 以 pressed 优先于 hover、focus outline 独立叠加、disabled 最终覆盖并降低有效 opacity。Display List 新增 `StrokeRect`，Layout cache、Skia 和 Bridge paint 共用 state-aware 路径；first-party Button 默认样式、Core 组合状态、Renderer/Bridge 像素和 pointer/keyboard 生命周期均有自动断言。
- 验证：Core `53/53`、Layout `15/15`、Renderer `20/20`、Platform `17/17`、Bridge `104/104` 与五 crate 严格 Clippy 通过。

G3A-11 evidence（2026-08-06）：

- `examples/input-e2e/scenario.json` 是 Minimal TSX fixture、Node 合同与 Rust `HostWindowApp` harness 的同一份数据源；场景覆盖 macOS Meta 与 Windows Control、Input/TextArea CJK/Emoji/combining preedit、UTF-16 range、候选框、TextArea 自动滚动以及 Commit/Cancel/Change FIFO。native smoke matrix 在 macOS/Windows runner 执行固定 `g3a11_` harness，相关路径变更会稳定触发 native gate。
- winit 将大小写 C/X/V 归一化为 Copy/Cut/Paste，并按平台主修饰键生成 typed command；普通无修饰字符仍进入文本。Bridge 通过可注入 `ClipboardBackend` 连接 focused editor：Copy 不改值，Cut 仅在写入成功后删除，Paste 仅在读取成功后替换，活动 composition 时拒绝命令，失败进入 `ErrorSupervisor` 且 value/selection/events 保持原子；测试只使用内存 clipboard。
- 单行 Input 在普通文本、paste、IME preedit/commit 与 TextInputClient replace 边界统一删除 CR/LF，并同步重映射相对 UTF-16 selection；TextArea 对同一输入原样保留 CR/LF，surrogate interior 仍被原子拒绝。
- 验证：Text `87/87`、Platform `24/24`、System `3/3`、Bridge `113/113`、Perry Host Rust `12/12`、Node scenario/CI contracts `17/17`、fixture typecheck 与 Perry AOT/link 通过；四个目标 crate 和独立 Host 严格 Clippy、workspace/Host Rustfmt、目标 Prettier 与 diff-check 全部通过。Perry 链接仍输出已知 duplicate-symbol warning，但成功生成 `24.3 MB` 可执行文件。

## G3B：Semantics 与 AccessKit

| ID     | Todo                                         | Acceptance                                                                                          | Verify                            | Dependencies   | Files                                                                           | Size |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------- | -------------- | ------------------------------------------------------------------------------- | ---- |
| G3B-01 | [x] 增加 Semantics Host command              | Set/Clear 可版本化，组件默认语义可被显式覆盖                                                        | contract tests                    | G1             | protocol、generated outputs、Host props、Bridge command、tests                  | M    |
| G3B-02 | [x] 实现 Semantic Tree 派生/diff             | role/name/value/state/bounds/actions 形成独立 snapshot；更新只发 diff                               | semantic snapshot tests           | G2C-01、G3B-01 | semantic tree、deriver、diff、tests                                             | M    |
| G3B-03 | [x] 实现 Button/Text/Input/TextArea 默认语义 | label/value/disabled/focus/action 与视觉状态一致                                                    | component semantic tests          | G3A-10、G3B-02 | UI primitives、Host defaults、semantic tests                                    | M    |
| G3B-04 | [x] 接入 AccessKit desktop bridge            | 初始树、增量更新、focus 与 Invoke/SetValue action 走 Dispatcher                                     | AccessKit integration tests       | G2A-04、G3B-02 | AccessKit adapter、platform composition、dispatcher action、Cargo config、tests | M    |
| G3B-05 | [x] 建立语义驱动 E2E                         | 真实 NSAccessibility/UI Automation client 用 role/name 定位和操作 Notes，经 Adapter/Dispatcher 落地 | macOS/Windows native client smoke | G3B-03、G3B-04 | E2E harness、scenario、platform client、reference fixture                       | M    |

微检查点：G3B-01..02 验证 Host 到 Semantic Tree；G3B-03..05 验证组件默认语义、AccessKit 与平台 E2E。

G3B-01 evidence（2026-08-06）：协议保留 `SetSemantics=14` / ABI 27，并仅追加 `ClearSemantics=19` / ABI 32；`SemanticRole`、`SemanticAction` 使用字符串 enum，`Semantics` 的 role/label/value/description/disabled/checked/actions 七字段与 typed list 由同一 manifest 生成 Rust、TypeScript 和 Perry 合同。Core 与 Bridge 的 Set/Clear 复用 shadow validation/atomic commit，提交前不可见，成功只置 `SEMANTICS` dirty；malformed JSON、未知 role/action/字段和 stale handle 返回结构化错误并使整批回滚。Host `semantics` prop 支持显式 Set、null 与 prop 删除 Clear，握手广告的 `ui.semantics` 现已有可调用符号。验证：Protocol `30/30`、Core `56/56`、Bridge `115/115`、Perry Host Rust `14/14`、Node workspace `94/94`、22-project typecheck、三目标与独立 Host 严格 Clippy、Rustfmt、目标 Prettier、protocol drift、diff-check 以及 Solid Perry AOT/link 全部通过；Perry 仍有已知 duplicate-symbol warning，构建成功并生成约 `24.6 MB` 可执行文件。

G3B-02 evidence（2026-08-06）：新增 Core `SemanticTreeSnapshot` / `SemanticTreeDiff`，按 visual preorder 派生显式 semantics；非语义祖先折叠到最近语义祖先，Scroll 子树应用绝对布局与滚动偏移并裁剪可见 bounds，focused/disabled/checked/action 状态进入独立节点。actions 在 snapshot 中按协议顺序去重；diff 的 Add 先父后子、Remove 先子后父、Update 只包含实际变化节点。Bridge 暴露 committed `semantic_snapshot` / `semantic_diff`，pending shadow mutation 不可见；Window 在 Layout 后运行 Semantics 帧阶段并记录 `semantic_attempts/semantic_diffs`，首帧 full-add、增量 label update 均有回归测试。验证：Core `60/60`、Bridge `117/117`、目标 Clippy、Rustfmt 与 diff-check 通过。

G3B-03 evidence（2026-08-06）：Button 继续是 `View + Text` 复合组件，新增 append-only `RegisterButton=20` / ABI 33 与 Core `Node.is_button` intrinsic marker；默认导出只认精确 marker，不再把任意 clickable View 推断成 Button，内部 label Text 被抑制，空 label 回退为 `Button`。Input/TextArea 通过 registry 导出 TextInput，standalone Text 导出 Text；显式 Set/Clear semantics 优先级、disabled/focus/value/label 动态同步均有回归覆盖。验证：Core `63/63`、Bridge `123/123`、Protocol/Host/Perry targeted tests、Node workspace `95/95`、21-project typecheck、目标 Clippy、Rustfmt、Prettier、protocol drift、diff-check 与 Minimal Perry AOT/link 通过；AOT 生成 24.5 MB smoke binary 并实际执行成功。Perry namespace enum 的运行时反射已替换为生成 enum 穷举表，避免 AOT 初始化错误。

G3B-04 evidence（2026-08-06）：引入 `accesskit=0.24.1` / `accesskit_winit=0.33.2`（仅 `rwh_06`），以 stable synthetic Window root、generation-bearing NodeId、role/name/value/description/state/bounds/actions/focus 转换完整树；增量更新在子节点移除时补发父 children，reset/resume 重新发送 full tree。winit adapter 在隐藏窗口创建后初始化，先处理 AccessKit event，再处理普通 WindowEvent；surface suspend/recreate 会一起释放 adapter/tree/window resources。ActionRequest 只接受 Click/Focus/SetValue，经独立 `Dispatcher<AccessibilityActionRequest>` 在 PlatformEvents tick 消费，Invoke/Focus/SetValue 分别进入现有 Click/focus/Change 路径，stale/disabled/unsupported action no-op。验证：Platform `36/36`、Bridge `125/125`（含 G3B-04 action `2/2`）、Platform/Bridge strict Clippy、locked Host `15/15`、workspace Node `95/95`、Rustfmt/diff-check 通过；AccessKit converter 覆盖完整树、字段更新、父 children、root fallback、viewport/scale 和 action normalization。

G3B-05 deterministic harness evidence（2026-08-06）：Minimal TSX `examples/semantic-e2e`、Node 合同与 Bridge harness 共用版本化 `scenario.json`，Title、Body、Save 只以 Semantic role/name 定位；Node 合同拒绝 pointer/client/screen coordinate 查询。AccessKit converter harness 验证 role/name/action 映射，Bridge harness 对 scenario 中三个查询经 Dispatcher 完成 Focus、SetValue 与 Invoke，未调用 hit-test。`native-smoke.yml` 的 macOS/Windows matrix 已配置运行相同 `g3b05_` deterministic tests。验证：Platform `37/37`、Bridge `127/127`、workspace Node `96/96`、23-project matrix 与 22-project typecheck。

G3B-05 native client smoke 证据（2026-08-06，2026-08-16 hosted 补充）：新增小型原生 fixture，通过 production `accesskit_winit::Adapter`、winit user event 与 `Dispatcher<AccessibilityActionRequest>` 落地 action；它和 Minimal TSX/Bridge harness 组成分层证据。macOS 本机的进程内 NSAccessibility 对象 client 已连续通过 role/name Focus、SetValue、Invoke、焦点/value/Status 回读；Windows UI Automation COM client 实现相同 control-type/name 工作流、35 秒 watchdog 与焦点回读。PR run `31902303937` 的 macOS/Windows native jobs `95054897228` / `95054897192` 均在真实 hosted runner 成功执行平台 accessibility client，关闭 G3B-05；macOS 当前层仍不覆盖跨进程 `AXUIElement`/TCC 兼容矩阵。

### G3 Checkpoint

- [x] 单行/多行中文 IME preedit/commit/cancel 与 Emoji selection 自动化通过
- [x] 共享 scenario deterministic harness 使用 Semantic Tree role/name 定位 Button/Input/TextArea，不使用像素坐标
- [x] macOS NSAccessibility 对象 client 通过 role/name 读取并经 AccessKit Adapter 执行适用 action
- [x] Windows UI Automation client 在 GitHub Windows runner 通过同一路径（run `31902303937`，job `95054897192`）

## G4：Task、权限、FS 与 Dialog

| ID    | Todo                                         | Acceptance                                                           | Verify                                           | Dependencies  | Files                                                       | Size |
| ----- | -------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------ | ------------- | ----------------------------------------------------------- | ---- |
| G4-01 | [x] 实现 generation TaskRegistry             | create/active/cancel/close/invalidate/late completion 状态完整且幂等 | state/property tests                             | G2A-07        | task registry、handle、lifecycle hooks、tests               | M    |
| G4-02 | [x] 实现 worker executor 与 completion queue | 阻塞操作不在 UI 线程；completion 只通过 Dispatcher settle            | concurrency/order tests                          | G2A-04、G4-01 | executor、dispatcher completion、runtime integration、tests | M    |
| G4-03 | [x] 建立 System `CommandResult/NexaError`    | denied/cancelled/not-found/invalid/platform 可区分并保留 source      | Rust/TS contract tests                           | G1、G4-01     | system protocol、Rust error、TS error、FFI codec、tests     | M    |
| G4-04 | [x] 实现 app manifest 与 permission loader   | 未声明能力一致拒绝；开发/发布 manifest 可验证                        | manifest schema + permission tests               | G1、G4-03     | manifest schema、loader、permission set、tests              | M    |
| G4-05 | [x] 实现 `@nexa/fs` 文本读写                 | UTF-8 read/write、atomic save、cancel、错误映射通过                  | temp-backend integration tests                   | G4-02..G4-04  | system FS core、FFI host、TS package、tests                 | M    |
| G4-06 | [x] 实现 `@nexa/dialog` 打开/保存            | cancel 返回显式空结果；owner close 终止 Task 交付并丢弃迟到结果      | injected backend contract + native backend build | G4-02..G4-04  | dialog core、platform backend、FFI host、TS package、tests  | M    |
| G4-07 | [x] 迁移 Clipboard 到 Task/Error             | 不再把失败压成空字符串/布尔值；测试使用注入 backend                  | clipboard unit/contract tests                    | G4-02、G4-03  | clipboard core、system host、TS package、tests              | M    |
| G4-08 | [x] 完成窗口关闭资源清理                     | 所属 Task/Subscription/Resource 失效，迟到 completion 不进框架       | close-race integration test                      | G4-01、G4-02  | lifecycle、registry、dispatcher、tests                      | M    |

微检查点：G4-01..03 验证 Task/executor/error；G4-04..05 验证 manifest/permission、FS Task/Promise、atomic write 与 wakeup；G4-06..08 验证 Dialog、Clipboard 迁移和 close race。

G4-04 原子计划（ADR-011）：

- [x] G4-04a：定义严格 JSON v1 schema 与 development/release fixtures；schema permission enum 与 active System registry 零漂移。
- [x] G4-04b：实现 64 KiB 有界 development file/release bytes loader；共用 parser，拒绝未知字段、非法 identity/SemVer、协议不兼容、未知/重复权限。
- [x] G4-04c：把 `PermissionSet` 改为 deny-all，并以穷尽 `require_command` 统一执行 manifest 能力检查。
- [x] G4-04d：System Host 增加可信 Rust-only one-shot manifest install；未安装与二次安装均 fail closed，不向 TS 暴露 grant/reload。
- [x] G4-04e：通过 schema、Core、Host、protocol drift、strict Clippy、全仓测试与格式门禁，记录实现证据。

G4-01 evidence（2026-08-06）：`HandleIdentityRegistry` 在 System Runtime domain 内统一分配 Task/NativeResource/后续 Subscription 的 generation identity，并在当前/tombstone 记录 kind、owner、state；Task-facing `TaskRegistry` 是兼容 facade。`Created -> Active -> Closing -> Closed/Invalidated` 的 activate/cancel/close/finish-close、owner terminal fence、stale/wrong-owner/wrong-kind 原子失败、slot generation 复用与 `u32::MAX` 退休均有测试。completion `Accepted/Dropped` 按 invalid-handle、invalid-kind、stale、wrong-owner 和每种非 active state 分桶；累计 identity/owner 硬预算在创建时预留未来 tombstone，并暴露 used/remaining。Runtime 单测 `37/37`，严格 Clippy 通过。G4-02 的 cancellation token/worker queue 与 G4-03 的 System Host Result 映射仍未完成。

G4-02 evidence（2026-08-07）：Application Runtime 使用固定大小 worker pool 与 bounded `sync_channel`，UI 线程以 `try_send` 提交阻塞工作；worker 只持有 move-only work/result、cooperative cancellation token 与 `Dispatcher` producer。completion 只能在 Scheduler `SystemCompletion` phase drain。cancel control event 可在 worker 阻塞时先完成一次 `Cancelled` settle，正反两种 completion/cancel 入队顺序都保证只有一个非 dropped 终态；panic 被隔离且在 cancel 竞态中仍保留诊断 outcome，owner invalidation/runtime drop 会取消 token，迟到结果按 tombstone 丢弃。同队列 sequence 在入队锁内分配，保证并发 producer 的 FIFO diagnostics 单调；queue-full 不阻塞，也不消耗未公开 Task 的 identity/owner lifetime budget。Runtime 单测 `49/49`、Rustfmt 与严格 Clippy 通过；下一切片 G4-03 负责 System Host numeric error mapping 与 Rust/TS FFI result codec。

G4-03 evidence（2026-08-07）：`nui-system-core` 新增 `CommandResult<T> = Result<T, NexaError>` 与基于生成 `system.ErrorCode` 的 typed constructors，覆盖 `INVALID_ARGUMENT/INVALID_KIND/WRONG_OWNER/STALE_HANDLE/INVALID_STATE/NOT_FOUND/PERMISSION_DENIED/CANCELLED/PLATFORM_FAILURE/INTERNAL_FAILURE`；manifest-driven Rust test 校验每个 code/name/severity/retryable 不漂移，并以 `cause`、`platformCode` 和 source context 保留诊断链。独立 `@nexa/system-host` mapper 将 G4-01 `TaskRegistryError` 和 G4-02 `WorkerOutcome` 映射为不同 System code；Rust `nexa_result_json_v1` codec 将 context 编成 primitive JSON、限制 cause 深度、捕获执行/编码 panic 并回退结构化 `INTERNAL_FAILURE`。TS `decodeCommandResult` 做 exact-key、uint32、severity、retryability、context 与递归 cause 校验，`NexaSystemError` 保留完整链。Rust core `9/9`、System Host `6/6`、TS contract `6/6`，严格 Clippy、typecheck、Prettier 与 protocol drift 通过；domain/code 前缀与 workspace test matrix drift 也有回归覆盖。旧 Clipboard sentinel 导出仍标记 legacy，迁移留在 G4-07。

G4-04 evidence（2026-08-07，2026-08-08 集成补充）：ADR-011 的严格 app manifest schema、双加载入口、deny-all PermissionSet、穷尽 command permission mapping 和 Rust-only one-shot Host install 已完成。Notes 构建链现通过 `NEXA_APP_MANIFEST_PATH` 只在 build time 将 manifest bytes 嵌入 System Host；production owner 启动只解析内嵌 release bytes 并安装一次，缺省保持 deny-all，TypeScript/运行时没有 grant/reload/path 入口。详见 `docs/ROADMAP.md` 的 G4-04 evidence 与 `protocol/schema/app-manifest.schema.json`。

G4-05 evidence（2026-08-07，2026-08-08 集成补充）：`@nexa/fs` 的 typed `Task<T>`、UTF-8 read/write、atomic replace、cancel 和结构化错误映射已完成。System Core 文件系统 contract `9/9`、System Host Rust `15/15`、Application Runtime `51/51`、winit `39/39`、Perry Bridge `128/128`、FS/System TS contract `12/12` 通过；strict Clippy、locked install、workspace route checks、双 native-library AOT link 与 `/tmp/nexa-g4-05-native-link-smoke` 实际执行通过。分层测试覆盖 phase gate、owner fence、wakeup hook、cancel/commit race、temporary cleanup、single awaiter 和 single settlement。G5 的受信 build-time manifest 嵌入和真实 Notes native FS Promise smoke 均已落地；Dialog 的 MVP 自动证据由构建期注入 backend 的真实 Perry/native Task/Promise 旅程补齐，不把它表述为交互式 OS picker 自动化。

G4-05 原子计划（ADR-012）：

- [x] G4-05a：扩展 System protocol、schema、generated outputs、Fs permission、`INVALID_DATA` 和共享 contract fixtures。
- [x] G4-05b：实现可注入 FS backend；UTF-8 read、同目录临时文件、flush/sync、atomic replace、typed error mapping。
- [x] G4-05c：实现 Task awaiter/result registry；start FFI 返回 Task handle，`AwaitTask` 以 Perry Promise 返回 `nexa_result_json_v1`。
- [x] G4-05d：接入 winit EventLoopProxy wakeup 和 HostWindowApp `SystemCompletion` hook；验证 idle-window completion。
- [x] G4-05e：新增 `@nexa/fs` typed API、cancel/close 语义和 contract tests；通过 Rust/TS/format/locked gates。

G4-06 原子计划（ADR-013）：

- [x] G4-06a：扩展 Dialog commands、permissions、Task kinds、ABI functions 与 generated artifacts。
- [x] G4-06b：实现严格 filters JSON parser 与 `DialogRequest`/`DialogBackend` 可注入 Core 合同。
- [x] G4-06c：把 open/save 接入 worker Task、SystemCompletion、AwaitTask、owner fence 和结构化错误。
- [x] G4-06d：接入 `rfd::FileDialog` native backend，并提供 `@nexa/dialog` typed `openFile`/`saveFile` API。
- [x] G4-06e：通过 protocol、TS、Rust、strict Clippy、locked install 与 dialog cancellation/late completion 回归。

G4-07 原子计划（ADR-014）：

- [x] G4-07a：复用 System Task/Error 合同，新增注入式 Clipboard backend helpers 与平台错误映射。
- [x] G4-07b：实现 Clipboard read/write worker Task、v1 FFI start symbols、owner/cancel/late completion 语义。
- [x] G4-07c：迁移 `@nexa/clipboard` 到 typed `ClipboardTask<T>`，保留旧 sentinel 只作兼容导出。
- [x] G4-07d：补齐内存 backend Rust/TS contract tests，更新 Clipboard demo 使用 `.result`。
- [x] G4-07e：通过 package typecheck/test、System Host Rust、strict Clippy、native-library Cargo check 与文档一致性门禁。
- [x] G4-07f：在 Notes trusted launcher 接入真实 Clipboard read/write/read Promise fixture、严格 proof runner 与双平台 package workflow；本地 runner `7/7` 与 Perry AOT/link 通过，run `31902303937` 的双平台 package jobs 完成 hosted 平台执行。

G4-07 evidence（2026-08-07，2026-08-16 hosted 补充）：Core injected backend `2/2`、System Host Rust `22/22`（20 unit + 2 integration）、Clipboard TS contract `4/4` 通过；`@nexa/clipboard` 不再调用 legacy sentinel，所有失败均通过 `NexaSystemError` 结构化传递。`smoke:clipboard` 使用 Notes 内嵌 manifest，在 `Ready` 后经 native worker、`SystemCompletion` 与 Perry Promise 执行 read/write/read，并在原文本可读时恢复；runner 要求精确 round-trip/restore proof，失败、假 marker 与提前退出均 fail closed。runner 合同 `7/7`、本机 Perry AOT/link 通过，run `31902303937` 的 macOS/Windows package jobs `95054897243` / `95054897272` 完成真实 hosted 平台执行。

G4-08 evidence（2026-08-07）：`TaskRuntime` 新增 shared System ledger 的外部句柄生命周期入口；Application Runtime close-race 测试与 System Host 注入式 awaiter 测试验证同一 owner 的 Task、Subscription、NativeResource 在窗口关闭时统一失效，awaiter 被移除，迟到 worker completion 在 `SystemCompletion` 丢弃。Focused tests 通过；下一切片切换为 G5-01 参考 Notes PRD。

## G5：参考应用与开发者工作流

| ID    | Todo                             | Acceptance                                                                  | Verify                                                                                       | Dependencies       | Files                                                                                  | Size |
| ----- | -------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------- | ---- |
| G5-01 | [x] 确认 North-star 应用 PRD     | 负责人确认 Notes 或替代场景、用户旅程与非目标                               | PRD review                                                                                   | G3/G4 设计接口稳定 | `docs/REFERENCE-APP.md`                                                                | S    |
| G5-02 | [x] 建立参考应用 Shell           | Window/toolbar/editor/status 基础布局响应缩放，使用 Minimal TSX             | typecheck + native smoke                                                                     | G5-01、G2C         | app package、main、state、workspace matrix、layout test                                | M    |
| G5-03 | [x] 接入编辑与 A11y 流程         | 标题/正文编辑、焦点、IME、语义操作完成                                      | semantic/input E2E                                                                           | G3、G5-02          | app editor、toolbar、tests                                                             | M    |
| G5-04 | [x] 接入打开/保存/错误状态       | open/edit/save/cancel/denied/close race 形成完整用户流程                    | app E2E                                                                                      | G4、G5-03          | app state、file commands、error UI、tests                                              | M    |
| G5-05 | [x] 定义基础 Style/Theme API     | typed token、hover/pressed/focus/disabled 在组件间一致；不实现 CSS          | API/visual tests                                                                             | G3A-10             | UI theme、style types、Button/Input、tests                                             | M    |
| G5-06 | [x] 实现 CLI `new` 与 `doctor`   | 新项目可生成；doctor 报告 Node/pnpm/Perry/ABI/target 错配                   | CLI fixture tests                                                                            | G0、G1             | CLI manifest、new command、doctor command、templates、tests                            | M    |
| G5-07 | [x] 实现 CLI `dev/build`         | 命令调用固定 Perry 工具链并输出可诊断构建结果                               | temp-project integration                                                                     | G5-06              | CLI build、process wrapper、diagnostics、tests                                         | M    |
| G5-08 | [x] 实现 CLI `package`           | 复制正确 native library/assets/manifest，产物不依赖开发工具链               | package smoke                                                                                | G5-07              | packager entry、bundle layout、resource copier、tests                                  | M    |
| G5-09 | [x] 生成 macOS/Windows 产物      | `.app` 与 Windows 分发目录在 runner 可启动，版本信息一致                    | platform package matrix                                                                      | G5-08              | macOS packager、Windows packager、workflow、tests                                      | M    |
| G5-10 | [ ] 编写从零教程与 API reference | clean 用户按文档可 create-to-package；命令均真实存在                        | docs smoke/link check                                                                        | G5-06..G5-09       | quickstart、API index、packaging guide、docs index                                     | M    |
| G5-11 | [x] 选择并接入 Tier-1 Adapter    | Solid 在参考应用核心切片通过 conformance/E2E，并作为唯一公开 Tier-1 Adapter | `node --test tools/solid-notes-e2e.test.mjs` + `node --test tools/release-packages.test.mjs` | ADR-004、G1、G3    | Adapter integration、reference-notes Solid entry、release manifest、tests、compat docs | M    |

G5-07 实施切片（按依赖顺序）：

- [x] G5-07A 冻结 conventional project、manifest v1、Perry process、diagnostics 与产物信任合同；验证 `PROJECT-DESIGN.md`/TODO 可追踪。
- [x] G5-07B 用真实 temp project 和 fake project-local Perry bin 建立初始 11-case RED 基线；实现后扩展为 12/12 GREEN。
- [x] G5-07C 实现 manifest validator、受控 process wrapper、`nexa build` 与 artifact verification；验证 build 正反合同。
- [x] G5-07D 接入 Perry `dev` watcher、生成模板 scripts/ignore 与 Windows branch；验证 CLI 定向套件、真实生成项目 build smoke 和全量 JS 门禁。

微检查点：G5-01..02 评审参考应用并通过 layout smoke；G5-03..05 验证输入/A11y/文件/主题核心流程；G5-06..08 验证 new-to-package；G5-09..11 验证平台产物、文档和 Tier-1 Adapter。

G5-01/G5-02 evidence（2026-08-07，2026-08-08 补充）：Notes PRD、用户旅程、信息架构、状态约束与非目标已冻结；Minimal TSX Shell 已加入 workspace，提供 Window/toolbar/title/body/status 和 typed dialog/FS 入口。Window 物化为 `NodeType.Root` 并随 viewport resize，内容列使用 flex，标题/正文以 stretch 清除固定 width；Root resize 回归 1/1、Notes typecheck 与真实 Perry AOT/link 均通过。`reference-notes/**` 和 `packages/dialog/**` 已扩展到 TypeScript/FFI/Perry/native CI 路由。

G5-03/G5-04 evidence（2026-08-08，2026-08-16 hosted 补充）：实际 Notes 组件复用可注入 controller；`tools/notes-app.test.mjs` 15/15 覆盖 dirty、save dialog cancel、open/save/error、foreground exclusion、revision snapshot、suspend/resume、pending read/write close 与 late completion。`tools/reference-notes-e2e.test.mjs` 4/4 在实际 Notes TSX 树中暴露 Open、Save、Title、Body、Status 五个稳定语义节点并执行 Focus/SetValue/Invoke。PR run `31902303937` 的 Windows UIA job `95054897192` 成功；macOS/Windows package jobs `95054897243` / `95054897272` 在真实图形会话完成 picker save/open/cancel，probe SHA-256 分别为 `f7cfab51cbaf4163bc82ae74854b07d5fcd8eb98219050fcb84e18e59c372172` / `e82079f1ee6b6afff7418b94a6299bb72835178f778918b036e80df8659e343a`，关闭 G5-03/G5-04。

G5-03/G5-04 收口切片（按依赖顺序）：

- [x] G5-03L1：为实际 Notes 提供五个稳定语义节点，以 Focus/SetValue/Invoke 驱动真实 Host trace；busy/状态变化不改变 role/name。
- [x] G5-04L1：补齐 Save cancel 保持 dirty、pending read/write CloseRequested、迟到结果失效和 native 非法 UTF-8 状态不变证据。
- [x] G5-04L2：实现无 fixture real-picker probe、macOS/Windows fail-closed driver、stage/proof/marker/disk/timeout/cleanup 合同，并强制接入双平台 package workflow。
- [x] G5-03P：在绑定当前 commit 的 Windows hosted runner 记录 UI Automation runtime 成功证据（run `31902303937`，job `95054897192`）。
- [x] G5-04P：在绑定当前 commit 的 macOS 与 Windows 图形会话记录真实 picker save/open/cancel 成功证据（jobs `95054897243` / `95054897272`，probe digests 见上）。

Dialog 已知限制：当前 `NativeDialogBackend` 只能观察 `rfd` 的 selected path 或 `None`，没有真实 `PLATFORM_FAILURE` 返回分支；Dialog worker 不使用 cancellation token，Task cancel/owner close 只终止结果交付并丢弃迟到 completion，不能主动关闭已显示的系统 picker。

G5-11 evidence（2026-08-10）：ADR-004 的首个第三方框架选择落实为 `@nexa/adapter-solid`。`examples/reference-notes/solid-main.tsx` 是可执行 AOT entry，并导入复用同一 Notes controller 的 `solid-app.tsx`；`tools/solid-notes-e2e.test.mjs` 实际编译并挂载核心组件，验证标题/正文/保存/状态的稳定语义，Focus/SetValue/Invoke，save busy 防重入、save completion、suspend/resume 和 dispose 后 controller subscription 释放。`tools/release-packages.test.mjs` 同时冻结九包 public/private 边界及 Solid 的 publishable `dist`、types、`jsx-runtime` exports。`tools/perry-frameworks.mjs` 现为五入口 matrix，新增 `solid-main.tsx -> reference-notes-solid`。验证命令：

```bash
node --test tools/solid-notes-e2e.test.mjs
node --test tools/release-packages.test.mjs
pnpm test:perry solid-notes
node tools/build-release-packages.mjs --check
```

四项本地合同均通过并关闭 G5-11；它们本身不构成 registry publish、签名或 hosted 平台证据。G5-03/G5-04/G5-09/MVP-01 由后续 run `31902303937` 的直接平台 job 另行关闭。

G5-05 evidence（2026-08-08）：`@nexa/ui` 新增 `createTheme`、`defaultTheme`、`rgba`、typed semantic tokens 与 `Style`/`TextStyle`；Theme 由根 `Window` 局部传递到 Text、Card、Button、Input、TextArea，显式组件 style 最终覆盖 token 派生值，不引入 CSS 字符串、selector 或全局可变主题。Button/Input/TextArea 的 base style 进入真实 Host numeric property，hover/pressed/focus/disabled 继续共用 G3A-10 的 additive native interaction resolver。UI package 8/8、Host trace 2/2、Core/Renderer 既有 interaction visual tests、strict typecheck/format 和真实 Notes Perry AOT/startup 均通过；根测试已纳入 Theme Host trace。System Host build-time manifest/Dialog fixture 同时改用 64 KiB bounded regular-file reader，并在读取前后检查大小，integration test 3/3；Rust CI 路由覆盖 package 内所有 `.rs`。

G5-06 evidence（2026-08-08，2026-08-09 发布边界同步）：新增无第三方运行时依赖的 `@nexa/cli` 与可执行入口 `nexa`。`new` 生成独立 Minimal TSX、standalone tsconfig、deny-all manifest 和非 `workspace:*` 的固定版本依赖；拒绝绝对路径、`..`、符号链接、非空目标、保留名与不安全项目名，所有文件使用 exclusive create。生成 README 明确候选 package 即使可打包，也仍需要已发布或已授权 registry；渲染后的 TSX 在合同中执行完整 typecheck。`doctor` 只沿当前项目 manifest 声明且安装在各 owner `node_modules` 的依赖边解析 Perry/Hosts，拒绝 ancestor/`NODE_PATH`；它以当前 Node 直接执行解析包声明的 Perry bin，并拒绝 PATH fallback、warning/多版本输出。报告覆盖 Node、pnpm、Perry、两套 Host runtime/ABI 与三种 Technical Preview target；Node/UI 等版本均绑定仓库真值源。`--json` 使用稳定 schema v1，错配/缺失返回 1、usage 返回 2。CLI 合同 22/22，Windows required job 运行同一套合同；workspace matrix 27 项目/108 checks、根聚合 198/198、workspace/CI route 28/28、format/lint/typecheck/diff-check 均通过。G5-07 与 G5-08 已随后完成。

G5-07 evidence（2026-08-08，2026-08-16 hosted 补充）：`nexa dev/build` 固定 conventional project 输入、project-local Perry 与 Technical Preview target，严格验证 64 KiB schema-v1 manifest，并从 child 环境删除大小写任意形式的 manifest/fixture/codegen bypass 后只注入受信绝对 manifest path。build 仅接受 `dist/<package-basename>[.exe]` regular binary、精确内嵌 manifest bytes 且无 Dialog fixture canary；Windows 使用 GUI subsystem，operational/usage 分别返回 1/2。temp-project 合同 12/12、CLI 聚合 34/34、根聚合 210/210、workspace matrix 27 项目/108 checks、14 个 workspace build 目标、format/lint/typecheck/diff-check 均通过。真实本地 `nexa new` 到 Perry AOT/link smoke 产出约 25.3 MB binary，并校验完整 manifest bytes；`npm pack ./packages/cli --dry-run` 确认 `.gitignore.tmpl` 进入发布包。后续 run `31902303937` 的 macOS/Windows package 与 fresh-launch jobs 全绿，关闭双平台 hosted create-to-package 产物路径。

G5-08 实施切片（按依赖顺序）：

- [x] G5-08A 冻结通用 current-target bundle layout、静态 Host binary、manifest/metadata、assets budget、原子 staging、拒绝覆盖与 G5-09 边界；验证 `PROJECT-DESIGN.md`/TODO 可追踪。
- [x] G5-08B 写独立 temp-project RED tests，覆盖 macOS/Windows layout、metadata/assets、existing destination、symlink/budget、build failure、cleanup 与 usage；初始 8-case RED，G5-08 复审阶段扩展为 19/19 GREEN。
- [x] G5-08C 实现通用 packager、CLI route/help 与生成项目 package script；不导入 Notes 专用 permission/name/helper。
- [x] G5-08D 增加真实 create-to-package Perry smoke、双平台 workflow/CI 路由与文档；通过 CLI 定向套件和全量 JS 门禁。

G5-08 evidence（2026-08-08）：通用实现位于 `packages/cli/src/package.mjs`；`nexa package` 无 skip-build 路径，先执行 G5-07 的受信 build，再为 `darwin/arm64`、`darwin/x64` 或 `win32/x64` 写固定 unsigned layout。binary、manifest、assets 使用 fd 级 regular-file identity 复核；assets 限制 4096 文件、64 MiB/文件、256 MiB 总量。project-root staging 完整写入后排他占位 destination；macOS 完整 `.app` 单次移入，Windows 逐项移入并以 `nexa-build.json` 最后提交，可捕获失败按 reservation identity 回滚；cleanup 双错误不会吞掉原始失败。G5-08 复审阶段 package 合同 19/19、CLI 聚合 53/53，CI path/fail-closed 21/21 与 CLI typecheck 通过；真实 `pnpm --filter @nexa/cli smoke:package` 完成 `nexa new`、Perry AOT/link、约 25.3 MB binary、plist/manifest/metadata/assets/canary/开发路径校验。`npm pack ./packages/cli --dry-run --json` 证明 `src/package.mjs` 与 `.gitignore.tmpl` 进入 tarball。Notes 专用 `tools/reference-notes-package.mjs` 保持独立。

G5-09 实施切片（按依赖顺序）：

- [x] G5-09A 冻结 hosted artifact 证据边界：build/upload 与 fresh download/launch 分 job，tar 只作 CI 运输，launch job 不 checkout/setup/install/build；验证 `PROJECT-DESIGN.md`/TODO 可追踪。
- [x] G5-09B 为真实 create-to-package smoke 增加受控 artifact 导出，默认仍清理；用 temp-directory 合同验证拒绝覆盖、同文件系统移动与失败清理。
- [x] G5-09C 将 `reference-notes-package.yml` 拆为双平台 build/archive/upload 与独立 download/validate/launch matrix；通用 artifact 核对 manifest/metadata/target/version/assets，macOS 再核对 plist，通用与 Notes executable 各存活 5 秒。
- [x] G5-09D 扩展 CI route/workflow fail-closed 合同，证明 launch job 没有 checkout/toolchain/build 步骤；运行定向与全量本地门禁。只有绑定当前 commit 的 macOS/Windows hosted run 全绿后才勾选 G5-09/MVP-01，并记录 run URL/ID、job、OS/arch、artifact/digest。

G5-09 实现与 hosted 证据（2026-08-08，2026-08-16 补充）：create-to-package smoke 支持 CI 专用 `--artifact-output <path>`，package 合同 23/23、CLI 聚合 57/57、CI route/workflow fail-closed 合同 22/22。PR head `e56bb9e2c531e9cd3d97837465eca92d5e2c31dd` 对应的 run `31902303937` 在 Actions merge execution revision `991b28142783833c14be659125c4564d14219cc5` 上完成 macOS/Windows build/archive jobs `95054897243` / `95054897272` 与无 checkout/toolchain/build 的 fresh download/validate/launch jobs `95059000291` / `95059000304`。平台 package artifacts `9251605446` / `9251849187` 的 GitHub digests 分别为 `sha256:483ab8a38b9debfa8b0dcbf3fb9562b1c1d37bc620b47b1c1e5d20d6b562bbaa` / `sha256:865954eae51ce7a8c2b93224bf8f2ac1d1ed05917649f31acac94c57482c2044`。该记录关闭 G5-09 和 MVP-01 的直接双平台产物启动门禁；因 `collect_mvp_proof=false` 而跳过的 clean-package proof 上传不能用于 N-11/schema-v5 晋级。

G5-10 实施切片（按依赖顺序）：

- [x] G5-10A：新增 Quickstart、Public API Index、Packaging Guide、Compatibility/Known Limitations 并接入 docs index；明确 private registry 与 hosted 证据边界。
- [x] G5-10B：新增 Markdown 本地链接、命令、API、版本/target 与 fail-closed 文档合同，接入根测试、Docs workflow 和 CI 路由；定向 docs/route 合同 27/27。
- [ ] G5-10P：在已发布或已授权 registry 上由 external clean 用户按 Quickstart 完成 install、doctor、typecheck、build、package，并记录环境、版本、artifact 与结果。

真实 native FS、Clipboard launcher 与 deterministic Dialog 证据（2026-08-08，2026-08-16 hosted 补充）：`smoke:fs` 用受信内嵌 manifest 编译并启动 Perry 进程，经 Notes controller 保存后在临时目录写入并读回 `Nexa UI UTF-8 smoke: 你好, مرحبا, 😀`；native worker、SystemCompletion 和 Perry Promise continuation 完成后输出 `savedRevision == revision`、`dirty == false` 的状态证明，Node runner 再核对磁盘 bytes。`smoke:clipboard` 要求 native read/write/read 精确 proof 并尽可能恢复原文本；本地 runner 合同 `7/7` 与 Perry AOT/link 通过，run `31902303937` 的双平台 package jobs 又完成真实 hosted runtime 路径。`smoke:dialog` 以构建期注入 backend 穿过真实 Perry/native System Host，完成 save/open/cancel 和精确 controller snapshot；它证明 Task/Promise/应用状态链路，真实 OS picker 则由同一 hosted package jobs 的无 fixture probe 另行验证。

真实 picker probe 证据（2026-08-08，2026-08-16 hosted 补充）：`smoke:picker` 的编译和运行环境均大小写不敏感地删除 `NEXA_DIALOG_TEST_FIXTURE_PATH`，编译后二进制拒绝 deterministic fixture canary；runner 必须依序驱动 save/open/cancel，核对真实磁盘 bytes 和版本化 Notes controller snapshot，并让 driver、stage、proof、marker、timeout、关闭等待或 cleanup 任一失败阻断。runner/driver 合同 24/24；本机无 Accessibility 权限运行仍按预期 fail closed。run `31902303937` 的 macOS/Windows jobs `95054897243` / `95054897272` 在真实图形会话完成 save/open/cancel，probe binary SHA-256 分别为 `f7cfab51cbaf4163bc82ae74854b07d5fcd8eb98219050fcb84e18e59c372172` / `e82079f1ee6b6afff7418b94a6299bb72835178f778918b036e80df8659e343a`。

MVP-01 evidence（2026-08-16）：run `31902303937` 的双平台 package 与 fresh-launch jobs 通过真实 FS/Clipboard/picker、package 完整性和两类 executable 的 5 秒启动检查。该 run 还由 job `95059000309` 组装 artifact `9251864491` `unsigned-signing-input`（GitHub digest `sha256:994c1ff87604f605130ebd5aa38718788157080c5a1176bb9231e51c8ef96abd`）。这些直接 job 证据关闭 MVP-01，但 run 不是 clean `refs/tags/v*` 且 proof 上传被跳过，因此不关闭 MVP-02/N-10/N-11、签名或发布。

## Desktop Notes MVP Gate

| ID     | Todo                               | Acceptance                                                                        | Verify                                        | Dependencies   | Files                                                          | Size |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- | -------------- | -------------------------------------------------------------- | ---- |
| MVP-01 | [x] 生成 Notes unsigned 双平台产物 | macOS `.app` 与 Windows 分发目录不依赖 Node/Rust/仓库源码，可在 clean runner 启动 | package smoke + platform matrix               | G5-04、G5-09   | packager core、bundle layout、resource copier、workflow、tests | M    |
| MVP-02 | [ ] 运行 Notes 最终验收矩阵        | N-01..N-11、所有当前门禁、文档/已知限制一致，证据绑定当前 commit                  | semantic/native E2E + full gates + docs check | MVP-01、G3、G4 | E2E harness、evidence/status doc、docs links                   | M    |

MVP Gate：

- [x] 编辑、IME、A11y、open/save、cancel/close、suspend/resume 形成同一应用旅程
- [x] macOS/Windows unsigned artifact 在 clean runner 启动
- [x] Minimal TSX 主路径可复现；唯一 Tier-1 Solid 的本地 Notes 核心切片已通过且不扩大 MVP hosted gate
- [x] `docs/MVP.md` Definition of Done 全部满足；MVP-02 仍独立等待 clean-tag schema-v5 最终晋级

## G6：Technical Preview 发布

| ID    | Todo                              | Acceptance                                                                    | Verify                                   | Dependencies     | Files                                                        | Size |
| ----- | --------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- | ---------------- | ------------------------------------------------------------ | ---- |
| G6-01 | [x] 定义公开包与构建产物          | 移除目标包 `private`，exports 指向真实 dist/types，未发布包继续 private       | `pnpm pack --dry-run` + consumer fixture | G5               | release package configs、build config、consumer fixture      | M    |
| G6-02 | [x] 建立版本与 changelog 流程     | Protocol/Perry/framework 兼容矩阵和 SemVer/Changesets 规则明确                | version PR rehearsal                     | G6-01            | changeset config、CHANGELOG、version policy、scripts         | M    |
| G6-03 | [x] 补齐许可证与治理文件          | MIT/Apache 双许可文件、CONTRIBUTING、SECURITY、CODEOWNERS 存在且 owner 明确   | community health/check links             | 无，可与 G5 并行 | LICENSE 文件 2 个、3 个治理文件                              | S    |
| G6-04 | [x] 增加供应链门禁                | cargo audit/deny、npm audit registry、license、secret scan、Action SHA policy | 故意失败 fixture 阻断                    | G0               | security workflow、deny config、registry config、policy docs | M    |
| G6-05 | [x] 生成 checksum/SBOM/provenance | 每个 release artifact 可验证来源与完整性                                      | release dry run                          | G6-01、G6-04     | release workflow、SBOM script、verification docs             | M    |
| G6-06 | [ ] 明确签名/公证流程             | macOS/Windows 凭据 owner、失败处理和无签名开发产物区分清楚                    | staging signed release                   | G5-09            | signing workflow、platform config、runbook                   | M    |
| G6-07 | [x] 建立性能基线与预算            | cold start、idle memory、bundle、tick/layout/paint 有 runner、基线和回归阈值  | benchmark workflow                       | G2C-07、G5-04    | benchmark app、runner、budget config、workflow               | M    |
| G6-08 | [ ] 发布 rehearsal                | 从 tag 到制品、安装、回滚全流程在 staging 成功                                | release checklist                        | G6-01..G6-07     | release runbook、checklist、workflow fixes                   | M    |
| G6-09 | [ ] 发布 Technical Preview        | 设计 12 条成功标准均有证据，release notes 与限制准确                          | 最终 release gate                        | 全部 G0..G6      | release metadata/docs                                        | S    |

微检查点：G6-01..03 验证消费包、版本和治理；G6-04..06 验证供应链、制品与签名；G6-07..09 验证性能、发布演练和最终证据。

G6 实施切片与外部证据边界：

- [x] G6-04A：实现 Action full-SHA、npm/Cargo license、Cargo audit/deny、npm audit 与 secret scan 的 fail-closed workflow/policy/negative fixtures。
- [x] G6-04P：受信 run `31902303937` 的 10 个 security jobs 完成 registry npm audit、四份 Cargo lock advisory、四份 deny 与 gitleaks，绑定 PR head `e56bb9e2c531e9cd3d97837465eca92d5e2c31dd` / Actions merge revision `991b28142783833c14be659125c4564d14219cc5`。
- [x] G6-06A：冻结 unsigned/signed/quarantine custody、macOS notarization、Windows Authenticode、凭据清理、失败和回滚 policy/runbook；policy disabled 与两个 literal-false job 保证默认 workflow 不激活凭据或签名 bytes。
- [x] G6-06B：实现并以 SHA-256 policy 绑定 reviewed signing executor/credential helper；fake-tool 合同覆盖临时 keychain/current-user certificate store、macOS codesign/notary/stapler/Gatekeeper、Windows Authenticode、exclusive custody 与每条退出路径的 credential cleanup；`reference-notes-package.yml` canonical producer 到 `signing.yml -- unsigned_run_id` 的下载、复核、平台执行、custody export/merge 与 publisher verification 路径已完整编码但保持硬关闭；本地 validation/contracts 通过。
- [ ] G6-06P：分配 macOS/Windows credential owner 与 incident owner，配置 protected Environments，审查并激活凭据，再取得双平台 hosted staging 签名/公证、fresh verify 与 launch 成功证据。
- [x] G6-07A：实现六项性能预算 schema、样本/runner 校验器、artifact bytes 测量和双平台 hosted capture 边界。
- [x] G6-07B1：冻结 native event、进程驱动、RSS、report identity 与 fail-closed 合同；验收为 `PROJECT-DESIGN.md` / `PERFORMANCE.md` 明确普通运行零影响及 local/hosted 证据边界；文件：两份设计文档；规模 S。
- [x] G6-07B2：以 RED→GREEN 合同测试冻结真实 `Presented` raw event、`GITHUB_SHA`/platform/runner/artifact identity、drop/timeout/缺样本/本地证据 fail-closed，以及 artifact 前后不变和 frame identity 一致性；验证：性能 Node 合同 `27/27`、Rust probe `3/3`。
- [x] G6-07B3：实现 opt-in Notes Host native probe；sink 输出完整 `FrameMetrics`，达到目标前驱动无输入 coalesced redraw，达到目标后停止并进入 settle idle，未启用路径不安装 sink/不额外重绘；验证：`cargo test --manifest-path packages/nui-host/Cargo.toml --locked performance` `3/3`，真实 AOT Notes marker/startup smoke 通过。
- [x] G6-07B4：实现跨平台 Node collector；固定 3 warmup + 10 measured、monotonic first-present、5 秒后 RSS、完整 frame durations、artifact bytes/SHA-256、commit binding、identity consistency、硬终止和 fail-closed report；验证：`node --test tools/performance-collector.test.mjs` 与 budget 合同合计 `27/27`，并覆盖 active baseline 绑定、严格 CLI 参数和 collection/termination 双错误传播。
- [x] G6-07B5：将 collector 接入 `macos-15` / `windows-2022` workflow；matrix job 先 `pnpm release:build`、再实际 package/capture/check，并在 check 回归时上传完整 raw report；`require_active` 继续阻断 pending；验证：performance workflow contract tests GREEN。
- [x] G6-07P：run `31895582357` 的双平台 raw reports 已评审并激活 12 个 baseline；run `31902303937` 的 jobs `95054917085` / `95054917056` 在 `performance-required` 模式下重新采集并通过 active-budget 无回归检查。
- [x] G6-08A：实现 candidate/tag source identity、unsigned bundle、fresh verify、5 秒 native launch、篡改检测、隔离 quarantine rollback 与 promotion decision。
- [ ] G6-08P：在 clean tag 的 macOS/Windows hosted staging 中通过 security、active performance、consumer、fresh verify/launch 和 rollback 全链路。
- [x] G6-09A：实现首次 npm train 的 fail-closed 两阶段合同；bootstrap 仅限 `v0.1.0`、七个非 registry gate 与 revision staging tag且不创建 GitHub Release，final 必须包含 registry gate且禁止创建 package version，只能推广摘要匹配的完整 train，并在 npm 二次观测收敛后公开 exact-seven-asset draft prerelease、保存 publication record。
- [ ] G6-09P：在 protected Environments 中执行 bootstrap publication、hosted staging registry clean-user proof、final readiness/channel promotion，并保留绑定 tag/revision/run 的完整证据。

G6-01/02/03 本地证据（2026-08-10）：`release/packages.json` 冻结 9 个公开 npm 候选包（包括唯一 Tier-1 `@nexa/adapter-solid`）与 4 个 private Adapter/System 候选；真实构建产出只含 `dist`，两套 Host 额外携带 Perry 源声明和受约束 native closure。Solid 的 release manifest/exports、Notes 核心 E2E 和 `solid-main.tsx` AOT 已通过；九个真实 npm tarball 已在无 workspace link 的 clean consumer 中完成 typecheck、Node ESM import、doctor、Perry AOT、两个 Host archive 链接、manifest 校验、`.app` package 与 evidence verify。Changesets、独立版本轴、CHANGELOG、双 MIT/Apache grant、CONTRIBUTING、SECURITY 与 CODEOWNERS 均有可执行合同；这些事实不授权 registry publish。

G6-02 deterministic rehearsal 补充（2026-08-11）：`pnpm version:rehearse` 现自行创建并清理隔离 workspace，以 synthetic patch 实际执行 Changesets `version`，证明固定九包 train 从 `0.1.0` 同步生成 `0.1.1`、4 个 private candidate 不变，并逐包核对 9 份 changelog。随后真实 `pnpm pack` 九个临时 package，解包检查 9 条内部 `workspace:*` range 全部固化为 `0.1.1`，再验证 clean-consumer tarball dependency/override 闭包精确覆盖九包。合同先对旧摘要实现 RED，再以真实演练 GREEN `3/3`；源版本文件 hash 与工作树状态保持不变。该演练不构建或发布 `0.1.1`，也不授权 registry mutation。

发布 ESM 回归收口（2026-08-10）：`tools/build-release-packages.mjs` 仅对生成的 `.js/.d.ts` 使用 TypeScript AST 补全相对 `.js` specifier，禁用失真 map，并支持隔离 `--output-root`；release build 合同与 `node tools/build-release-packages.mjs --check` 通过。Solid 的 `jsx-runtime`/`jsx-dev-runtime` 同时生成可发布 dist。九包 consumer 已完成 typecheck、Node 原生 ESM import、doctor、Perry AOT、双 Host archive 链接、`.app` package 与 evidence verify。

G6-04 当前状态（2026-08-16 hosted 补充）：`security.yml` 和 negative fixtures 已实现并由 Action SHA policy 锁定；安全合同会拒绝未固定 Action、非法/过期 license exception 和 synthetic secret。根 workspace 原有的 `winit` 默认 feature 经 `wayland-csd-adwaita -> sctk-adwaita -> ab_glyph -> owned_ttf_parser -> ttf-parser` 引入 `RUSTSEC-2026-0192`；现改为显式保留 `rwh_06`、Wayland、Wayland 动态加载、X11 与无标题文本的 Adwaita CSD，并从根/UI Host lockfile 移除废弃字体解析链。Windows unified static closure 只启用参考应用需要的 Perry `core`、Host Promise 所需 `async-runtime` 与协议校验所需 `regex-engine` feature，独立 lock 已纳入 audit、deny 与 Dependabot。run `31902303937` 的 10 个 security jobs 已完成 npm registry audit、四份 Cargo advisory、四份 deny 与 gitleaks；run metadata 的 source head 为 `e56bb9e2c531e9cd3d97837465eca92d5e2c31dd`，实际 Actions execution revision 为 `991b28142783833c14be659125c4564d14219cc5`，因此关闭 G6-04/G6-04P；这不授权 registry publish。

G6-05 evidence（2026-08-16 hosted 补充）：`tools/release-dependency-graph.mjs` 从结构化 `pnpm list --prod --json --depth Infinity`、两个 Host 与 Windows unified static closure 的 `cargo metadata --locked` 收集生产闭包，并按 `release/packages.json` 的当前 9 个 npm 根与 3 个 Cargo 根校验。当前实际得到 488 个 dependency-graph 组件和 488 个 dependency entries；`SHA256SUMS`、CycloneDX 1.6 SBOM 与 SLSA provenance 绑定同一 artifact、revision、builder 和四份 dependency-source lockfile digest。fresh verifier 不访问 registry，并对额外/缺失/篡改 artifact、未知 edge、material digest drift 与非规范 sidecar fail closed。run `31902303937` 的 job `95059000309` 已从双平台 archive 组装并复核 canonical `unsigned-signing-input` artifact `9251864491`，GitHub digest 为 `sha256:994c1ff87604f605130ebd5aa38718788157080c5a1176bb9231e51c8ef96abd`；这是 hosted unsigned provenance/custody 证据，不是 registry、签名或公证证据。

G6-06/07 当前状态（2026-08-16 hosted 补充）：`tools/signing-executor.mjs` v1.2.0 与 `tools/signing-credentials.mjs` 已由 `release/signing-policy.json` 绑定 entrypoint/closure SHA-256、runner 与平台命令路径；executor 在复制 unsigned bytes 或激活 credential 前强制验证规范 G6-05 descriptor、`SHA256SUMS`、CycloneDX 1.6 SBOM 与 provenance，custody schema v3 再绑定这些输入，publisher 也会独立复核双平台使用同一个完整输入 bundle。`signing.yml` 已按 `unsigned_run_id` 校验 producer run/revision、下载 canonical bundle，并编码 credential activation、签名、custody export/merge、signed manifest 与 publisher verification。两个 platform job 仍有 literal `if: ${{ false }}`，execution/credential activation 为 `disabled`，owner 仍未分配，protected Environment/真实凭据未配置，staging record 仍为 `pending`，所以 G6-06/G6-06P 按设计保持未完成。性能方面，run `31895582357` 的双平台 raw reports 已评审并激活 12 个 baseline，run `31902303937` 又在 `performance-required` 模式通过双平台 active-budget 检查，关闭 G6-07/G6-07P。

G6-08 当前证据（2026-08-16）：release rehearsal policy/runner/workflow 覆盖 fresh integrity verification、5 秒 native launch、隔离篡改 rollback 与 promotion decision，candidate 与 last-known-good 不会被改写。registry clean-consumer producer、MVP schema v5 七门禁/双平台 proof、signed custody v3、readiness bundle 的外部 artifact 下载/语义验证和 protected release consumption 均有 fail-closed 合同。active performance 已完成；仍缺 clean-tag 双平台 hosted staging、registry clean-user、签名 owner/凭据与真实 signed custody，因此 G6-08/G6-09 保持未完成，candidate 演练不会 publish、sign、notarize 或远程触发发布。

G6 外部门禁聚合预检：只读 `pnpm release:preflight` 在普通脏分支也输出稳定 schema v1，而不因 release tag 不匹配提前抛栈。报告绑定当前 HEAD 与要求的 `refs/tags/v0.1.0`，精确列出仍 pending 的 clean-tag evidence、registry、签名 owner/credential/execution 与发布门禁；已激活的 performance baseline 不再作为 pending。合同覆盖 final、bootstrap 只排除 registry、CLI 退出码和三份 policy bytes 前后不变；预检不写 evidence、不启用 execution、不访问 registry。

G6 hosted 状态复核（2026-08-16）：PR run `31902303937` 的 41/41 jobs 已绑定 source head `e56bb9e2c531e9cd3d97837465eca92d5e2c31dd`；Actions 中的 package/performance/artifact 执行则绑定 merge revision `991b28142783833c14be659125c4564d14219cc5`。该 run 关闭 Windows UIA、双平台 clean artifact/picker、hosted supply-chain、active performance 与 unsigned G6-05 input 的直接门禁。它不是 clean tag，且没有 credential activation、registry clean-user、signed staging 或最终 publication，因此这些外部门禁继续保持未完成。

G6-09A 本地证据（2026-08-11）：readiness policy/bundle、registry collector、publisher 与三个 workflow 已形成两阶段闭环。bootstrap external bundle 只复制 MVP/contracts/security/performance/consumer/signing/rehearsal 七个 gate，并把 execution 绑定为 `bootstrap`；publisher 只允许 `0.1.0` 写入 `technical-preview-staging-<revision-prefix>`，且不创建 GitHub Release。hosted registry proof 绑定 phase、tag、revision、九包 metadata/integrity、fresh lockfile、typecheck/import/doctor；final bundle 必须加入该 proof，final publisher 遇到任何缺失 version 或 `--resume` 都失败，只允许完整摘要匹配 train 更新 `technical-preview`。final-only GitHub Release 合同冻结七个公开资产、exact tag/full target SHA/version-bound notes/signing run、provenance attestation、draft reconcile、remote fresh-download、禁止 clobber、npm channel 二次收敛后公开，以及绑定 Release/run/assets/npm integrity 的独立 publication record。本地合同不授权 npm、签名或 GitHub Release 操作，G6-09P 与主项保持未完成。

本轮确定性收口证据保留 Solid Tier-1 `solid-notes-e2e`、release package boundary、release manifest、reviewed signing executor、workspace/release、Perry、Native、CLI、Clipboard 与九包 consumer 合同。run `31902303937` 已补齐 performance、Clipboard/picker、Windows UIA 与双平台 hosted 证据；仍不改变 registry、credential activation、signed staging、clean-tag rehearsal 或最终发布状态。

## Preview 后 Backlog

| ID   | Todo                             | Entry condition                                             |
| ---- | -------------------------------- | ----------------------------------------------------------- |
| L-01 | [ ] PlatformView 单平台产品化    | G6 完成且有真实地图/视频/厂商控件需求                       |
| L-02 | [ ] 多窗口与导航模型             | Lifecycle/owner scope 已稳定且参考应用确有需求              |
| L-03 | [ ] 网络 Image 与 HTTP           | Task/permission/cache/error 已在 FS 场景证明                |
| L-04 | [ ] 通知、菜单、托盘、快捷键     | Desktop app API 与 manifest 已稳定                          |
| L-05 | [ ] 动画与 frame clock API       | Scheduler/Display List 性能预算稳定                         |
| L-06 | [ ] 增量 Taffy/dirty region 优化 | profile 证明全量路径超过预算                                |
| L-07 | [ ] GPU backend                  | Surface/Resource 抽象已由 CPU backend 验证，且性能需求明确  |
| L-08 | [ ] Inspector/DevTools 完整版    | protocol/metrics/error stream 稳定                          |
| L-09 | [ ] Linux Tier-1                 | 有明确维护者与 CI/打包/IME/A11y 预算                        |
| L-10 | [ ] Android/iOS                  | Desktop Preview 稳定，Composition/permission/IME 接口经验证 |

## 完成准则

以下是领取或关闭任一 Todo 时必须逐项满足的通用审计准则，不是另一个全局未完成 checklist；方框状态只由每个任务自己的 Acceptance 和证据决定：

- Acceptance 全部成立。
- 指定自动验证通过，并在 PR 中记录命令/CI 链接。
- 新行为有回归测试，错误路径与清理路径被覆盖。
- 公开合同、ADR、Roadmap/Todo 状态同步更新。
- 没有新增未解释的 warning、format、lint 或 skipped project。
- 不相关用户改动未被覆盖或回退。
- 风险、迁移与回滚方式在 PR 中说明。
