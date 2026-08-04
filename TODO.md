# Nexa UI Todo

- 状态：Draft，待评审
- 基线：`mvp@f3afbeb`
- 路线图：[`docs/ROADMAP.md`](./docs/ROADMAP.md)
- 详细设计：[`docs/PROJECT-DESIGN.md`](./docs/PROJECT-DESIGN.md)

## 执行规则

- 按依赖顺序领取任务；只有标记为可并行的任务才能跨 Lane 同时推进。
- 每项任务应在一次专注会话完成，通常修改不超过 5 个文件。
- 行为任务先写失败测试，再实现，再重构。
- 每项任务的验收、验证、文档和回滚说明同时完成后才能勾选。
- G0 未全部完成前，不开始新的产品能力；G1 未冻结前，不并行修改协议常量。
- 新增依赖、公开 API、协议 major、CI required check 和发布动作需负责人批准。

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
| G0-12 | [ ] 为所有 TS workspace 声明验证脚本   | Host、React、Svelte、Layout 等不再被聚合命令静默跳过；无 lint 的项目明确继承根 lint            | 脚本矩阵测试；`pnpm typecheck && pnpm test && pnpm lint` | G0-01        | 根 `package.json`、脚本检查器、最多 3 个 package 模板文件                                                    | M    |
| G0-13 | [ ] 引入真实 TS lint                   | 至少覆盖 packages/examples，0 个 lint task 不能返回成功                                        | `pnpm lint` 输出实际检查文件数                           | G0-12        | 根 `package.json`、lint config、ignore 文件                                                                  | S    |
| G0-14 | [ ] 修正 CI path filters 与 fail-open  | 10 个示例、两个 FFI crate、workflow 变更均触发正确 job；changes 失败会阻断                     | filter fixture 或 workflow 单元验证                      | G0-01        | `.github/workflows/ci.yml`、filter 测试/说明                                                                 | M    |
| G0-15 | [ ] 新增 FFI Rust 门禁                 | `nui-host`、`system-host` 执行 fmt/check/clippy/test/native validate                           | 手动/PR 运行新 workflow                                  | G0-02、G0-14 | 新 FFI workflow、`ci.yml`、两个 Cargo 配置                                                                   | M    |
| G0-16 | [ ] 完整化 TypeScript workflow         | required job 运行 format、lint、typecheck、unit、build，而非只跑前两项                         | PR workflow 绿；故意失败 fixture 能阻断                  | G0-12..G0-14 | `typescript.yml`、根 `package.json`                                                                          | S    |
| G0-17 | [ ] 建立 clean Minimal TSX Perry smoke | 固定工具链从 clean checkout 编译并执行可退出的 Host 场景，覆盖 ABI handshake/handle round-trip | CI smoke 输出版本和成功标记                              | G0-02、G0-15 | 新 smoke 脚本、Counter package、Host manifest、workflow                                                      | M    |
| G0-18 | [ ] 建立框架 Counter 编译矩阵          | Solid/Vue/React/Svelte clean AOT build；失败不伪装成 parity 完成                               | `pnpm test:perry` 或 matrix workflow                     | G0-17        | workflow、matrix 脚本、parity 状态生成器                                                                     | M    |
| G0-19 | [ ] 启用 branch protection             | `main` 要求 PR、review 和 `CI / result`；禁止直接绕过                                          | GitHub ruleset API/设置复核                              | G0-14..G0-18 | GitHub repository settings                                                                                   | XS   |
| G0-20 | [ ] 建立基线证据页                     | 记录准确命令、runner、版本、通过/失败，不再以 Slice 提交替代证据                               | docs check + CI 链接有效                                 | G0-16..G0-19 | `docs/BASELINE.md`、`docs/README.md`                                                                         | S    |

微检查点：G0-01..02 验证工具链安装；G0-03..05 和 G0-06..08 分别运行局部/全量 Prettier；G0-09..11 运行完整 Rust 门禁；G0-12..13 验证每个 TS 项目实际被检查；G0-14..16 验证 CI 路由和 fail-closed；G0-17..18 验证 clean Perry matrix；G0-19..20 复核 required checks 与证据页。

### G0 Checkpoint

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿
- [ ] `cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` 全绿
- [ ] 两个独立 FFI crate 与 Perry clean smoke 全绿
- [ ] macOS/Windows Rust smoke 全绿
- [ ] `main` required checks 与 branch protection 生效

## G1：Host Contract v1

| ID    | Todo                                 | Acceptance                                                                        | Verify                                       | Dependencies | Files                                                            | Size |
| ----- | ------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------- | ------------ | ---------------------------------------------------------------- | ---- |
| G1-01 | [ ] 编写 Protocol/Handle/Error ADR   | 明确版本兼容、feature bits、handle 表示、错误码和废弃规则                         | ADR review checklist                         | G0           | 新 ADR、decisions index                                          | S    |
| G1-02 | [ ] 建立 UI protocol manifest        | Node/Property/Event/Command/Error 有唯一数值源和 schema 校验                      | schema parse test                            | G1-01        | `protocol/nui-host.json`、schema、fixture                        | M    |
| G1-03 | [ ] 建立 System protocol manifest    | Command/Permission/Task/Resource/Error 与 UI ID 空间分离                          | schema parse test                            | G1-01        | `protocol/system-host.json`、schema、fixture                     | M    |
| G1-04 | [ ] 实现协议生成器                   | 生成 Rust/TS/Perry 片段，重复运行稳定，手改生成物会使 CI 失败                     | generator snapshot + `git diff --exit-code`  | G1-02、G1-03 | 生成脚本、两类模板、根脚本、测试                                 | M    |
| G1-05 | [ ] 接入生成的 Rust 协议定义         | Core/Bridge 不再手写重复 enum 数值                                                | `cargo test -p nui-core -p nui-perry-bridge` | G1-04        | generated Rust、`nui-core/lib.rs`、style/tree/event 入口         | M    |
| G1-06 | [ ] 接入生成的 TS/manifest 定义      | `packages/ui/src/host.ts` 重复定义删除；manifest functions 与生成结果一致         | `pnpm typecheck` + drift test                | G1-04        | generated TS、Host exports、UI host、package manifest            | M    |
| G1-07 | [ ] 实现 Protocol/ABI handshake      | 启动返回双方版本与 feature intersection；major 不兼容结构化失败                   | Rust/TS contract + Perry smoke               | G1-05、G1-06 | Bridge handshake、FFI export、TS wrapper、manifest、test         | M    |
| G1-08 | [ ] 验证无损 handle transport        | 最大 slot/generation fixture round-trip；不再发生 safe-integer 错误               | Perry native round-trip test                 | G1-01、G1-07 | handle codec Rust/TS、manifest、fixture                          | M    |
| G1-09 | [ ] 增加 tree mutation 校验          | stale handle、非法 parent、环、跨 owner 操作返回明确错误且不改变树                | `cargo test -p nui-core mutation`            | G1-05        | mutation module、tree module、error module、tests                | M    |
| G1-10 | [ ] 补齐 clear property              | null/removed prop 恢复默认或 unset；Min/Max/Opacity/FontWeight 不再公开后静默忽略 | Host contract tests                          | G1-06、G1-09 | Host props、Bridge command、Style、tests                         | M    |
| G1-11 | [ ] 补齐 listener replace/remove     | listener 更新不叠加；remove 后 callback root 释放                                 | TS mock + Rust callback registry tests       | G1-06、G1-09 | Host props/tree、FFI TS/Rust、tests                              | M    |
| G1-12 | [ ] 修复 subtree dispose locality    | 删除节点停止 descendant effect，清理所有 descendant callback/input/image 状态     | leak/regression tests                        | G1-11        | UI mount owner、signal scope、Host remove、Bridge cleanup、tests | M    |
| G1-13 | [ ] 统一 Minimal TSX Host kit        | Minimal TSX 不再复制 Adapter 的 defaults/props/tree 语义                          | mutation trace 与旧场景等价                  | G1-10..G1-12 | UI materialize、Host kit exports、mount tests                    | M    |
| G1-14 | [ ] 建立 Adapter conformance harness | create/insert/move/reorder/clear/listener/dispose 场景可复用于所有 Adapter        | `pnpm test:contracts`                        | G1-13        | Mock Host、scenario fixtures、runner、root test config           | M    |
| G1-15 | [ ] 接入 Solid/Vue conformance       | 两个 Adapter 生成预期 mutation trace                                              | filtered contract tests                      | G1-14        | Solid/Vue adapter 入口、两份测试、fixture                        | M    |
| G1-16 | [ ] 接入 React/Svelte conformance    | React lifecycle 与真实 Svelte compile fixture 通过；不以手写 Svelte driver 代替   | filtered contract + compile fixture          | G1-14        | React/Svelte 入口、两份测试、fixture                             | M    |

微检查点：G1-01..03 评审并校验两个 schema；G1-04..06 运行生成物 drift 和编译；G1-07..08 跑 handshake/handle Perry round-trip；G1-09..11 跑 mutation/clear/listener 合同；G1-12..14 跑 dispose/统一 Host/conformance harness；G1-15..16 跑全部 Adapter 合同。

### G1 Checkpoint

- [ ] 协议生成物零漂移，handshake 与 handle round-trip 通过
- [ ] 所有设置均可撤销，所有 listener/effect 均可释放
- [ ] 非法 mutation 原子失败，Tree 不变量测试通过
- [ ] Minimal/Solid/Vue/React/Svelte conformance 状态有自动证据

## G2A：Application Runtime

| ID     | Todo                                    | Acceptance                                                        | Verify                             | Dependencies   | Files                                                    | Size |
| ------ | --------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- | -------------- | -------------------------------------------------------- | ---- |
| G2A-01 | [ ] 定义 `MutationBatch` 与 receipt     | batch 有 sequence/owner/commands；validate 与 apply 分离          | Core unit/property tests           | G1             | mutation types、error、tests                             | M    |
| G2A-02 | [ ] 让 Host FFI 入队 mutation           | create/set/insert/remove 不再直接改变 active Tree                 | Bridge tests 断言 commit 前不可见  | G2A-01         | Bridge host、FFI exports、TS wrapper、tests              | M    |
| G2A-03 | [ ] 实现原子 `commit()`                 | 任一命令失败整批拒绝；成功返回 dirty/sequence 并只请求一次 redraw | batch rollback tests + Perry smoke | G2A-02         | runtime commit、Bridge host、FFI export、tests           | M    |
| G2A-04 | [ ] 实现 Dispatcher 与 wakeup           | platform/system/framework 队列可并发投递，UI tick 有序 drain      | dispatcher concurrency tests       | G2A-03         | dispatcher、winit wakeup、runtime lib、tests             | M    |
| G2A-05 | [ ] 实现十阶段 Scheduler                | 阶段顺序固定；Layout/Paint mutation 与嵌套 frame 被拒绝           | scheduler state tests              | G2A-04         | scheduler、frame clock、error、tests                     | M    |
| G2A-06 | [ ] 迁移 Native callback 到队列         | winit/Bridge 只 enqueue，Perry closure 在 Framework 阶段调用      | event order integration test       | G2A-04、G2A-05 | platform event、Bridge window、FFI callback、tests       | M    |
| G2A-07 | [ ] 实现 owner-scoped callback registry | callback 有 generation/owner/state；close/remove 可幂等失效       | registry leak/stale tests          | G2A-06         | registry、task handle shared type、Bridge adapter、tests | M    |
| G2A-08 | [ ] 实现 app/window lifecycle 与 reset  | mount-close-remount 不继承 root/focus/callback；close 顺序可测    | lifecycle integration test         | G2A-07         | lifecycle、Bridge session、platform close、tests         | M    |
| G2A-09 | [ ] 实现 ErrorSupervisor                | Protocol/Operation/Frame/Fatal 分类进入可观察 sink，不只 stderr   | error routing tests                | G2A-05、G2A-08 | error supervisor、errors、platform adapter、tests        | M    |
| G2A-10 | [ ] 去除 React `flushSync` 事件补丁     | React 依赖统一 tick 仍正确更新，timer/microtask 行为可测          | React conformance + Perry Counter  | G2A-06         | React adapter、scheduler bridge、React tests             | M    |

微检查点：G2A-01..03 验证 batch 原子性；G2A-04..06 验证 tick/event 顺序；G2A-07..08 跑 callback/lifecycle 泄漏测试；G2A-09..10 跑错误路由和 React Perry 回归。

## G2B：Text Foundation

| ID     | Todo                                | Acceptance                                                       | Verify                                    | Dependencies   | Files                                                     | Size |
| ------ | ----------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- | -------------- | --------------------------------------------------------- | ---- |
| G2B-01 | [ ] 做文本依赖 spike 并写 ADR       | 候选方案以包体、平台字体、BiDi、Emoji、Skia 集成比较；负责人批准 | spike report + fixture output             | G1             | 新 ADR、spike crate/fixture、decisions index              | M    |
| G2B-02 | [ ] 实现 `TextIndexMap`             | UTF-16/UTF-8/scalar/grapheme 显式互转，组合字符/Emoji round-trip | property/fuzz tests                       | G2B-01         | text index module、selection types、tests                 | M    |
| G2B-03 | [ ] 实现 FontDatabase 与 fallback   | 按 family/style/script 解析，缺字能选择 fallback，缓存可失效     | font fixture tests                        | G2B-01         | font database、fallback、Cargo deps、tests                | M    |
| G2B-04 | [ ] 实现 script/BiDi/shaping        | 输出 glyph、advance、cluster 与方向；不丢 ZWJ/修饰符             | acceptance shaping tests                  | G2B-02、G2B-03 | bidi、shaping、types、tests                               | M    |
| G2B-05 | [ ] 实现 line breaking 与 paragraph | 给定宽度输出 lines/baselines/cluster hit map                     | paragraph fixture tests                   | G2B-04         | line breaking、paragraph、types、tests                    | M    |
| G2B-06 | [ ] 接入 Taffy 文本测量             | measure callback 使用 paragraph snapshot/cache，不用字符数估算   | layout integration tests                  | G2B-05         | layout adapter、paragraph cache、core text content、tests | M    |
| G2B-07 | [ ] 增加 GlyphRun Display command   | paragraph 可生成 backend-neutral glyph commands                  | display list snapshot                     | G2B-05         | core display list、text paint bridge、tests               | M    |
| G2B-08 | [ ] Skia 执行 GlyphRun              | production TextNode 不调用 `draw_str`；scale/DPI 正确            | renderer golden tests                     | G2B-07         | Skia renderer、glyph resource adapter、tests              | M    |
| G2B-09 | [ ] 建立多语言 golden/fuzz 集       | ADR 样例、窄换行、缺字、RTL 混排、Emoji 在 CI 可重复             | `cargo test -p nui-text` + visual fixture | G2B-06、G2B-08 | fixtures 最多 3 个、test runner、golden manifest          | M    |

微检查点：G2B-01..03 完成依赖评审、索引和字体 fixture；G2B-04..06 验证 shaping/paragraph/layout 一致；G2B-07..09 验证 GlyphRun 和完整多语言验收集。

## G2C：Display List 与 Surface

| ID     | Todo                                 | Acceptance                                                              | Verify                            | Dependencies   | Files                                               | Size |
| ------ | ------------------------------------ | ----------------------------------------------------------------------- | --------------------------------- | -------------- | --------------------------------------------------- | ---- |
| G2C-01 | [ ] 定义 DirtyFlags 与 Display List  | Tree 派生不可变 command list，命令不含 Skia 类型                        | Core snapshot/property tests      | G1             | core dirty、display list、tree、tests               | M    |
| G2C-02 | [ ] 迁移矩形/clip/image 绘制         | Renderer 只消费 Display List，不直接遍历 Arena                          | render integration tests          | G2C-01         | paint builder、Skia executor、Bridge paint、tests   | M    |
| G2C-03 | [ ] 建立 ResourceStore               | Image/Font/Paragraph 用 generation `ResourceId`；Tree 不存 backend 对象 | resource lifecycle tests          | G2C-01         | resource module、NodeContent、Bridge assets、tests  | M    |
| G2C-04 | [ ] 消除图片每帧 clone/copy          | decode 一次、共享 CPU pixels、按 Surface generation 上传                | allocation/counter test           | G2C-02、G2C-03 | Bridge image store、Skia image cache、tests         | M    |
| G2C-05 | [ ] 实现 Surface 状态机              | Absent/Ready/Suspended/Recreating/Failed 转换明确，重复 resume 幂等     | state machine tests               | G2C-02         | platform surface、composition types、tests          | M    |
| G2C-06 | [ ] 接入 suspend/resume full repaint | 恢复后重建资源并完整 present，业务状态保留                              | injected surface-loss integration | G2C-03..G2C-05 | winit handler、Skia cache、runtime lifecycle、tests | M    |
| G2C-07 | [ ] 增加 frame observability         | 每 tick 记录 mutation/layout/semantic/display 数和阶段耗时              | deterministic metrics test        | G2A-05、G2C-02 | metrics、scheduler hooks、diagnostic output、tests  | M    |

微检查点：G2C-01..02 验证 Tree 到 Skia 的不可变接缝；G2C-03..04 验证资源生命周期和图片分配；G2C-05..07 验证 Surface 恢复与 frame metrics。

### G2 Checkpoint

- [ ] Native 事件经 Dispatcher，mutation 仅在 commit 生效
- [ ] Paragraph 同时驱动 layout 与 GlyphRun paint
- [ ] Renderer 不遍历可变 Tree，Surface 可恢复
- [ ] Todo 多次状态更新在单 tick 只 present 一次

## G3A：Focus、EditableText 与 IME

| ID     | Todo                                    | Acceptance                                                                      | Verify                       | Dependencies           | Files                                                               | Size |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------- | ---------------------- | ------------------------------------------------------------------- | ---- |
| G3A-01 | [ ] 定义 normalized event schema        | Pointer/Wheel/Keyboard/TextInput/Composition/Focus 字段和 propagation 一致      | protocol round-trip tests    | G1、G2A                | protocol manifest、core event types、generated outputs、tests       | M    |
| G3A-02 | [ ] 实现 FocusManager 与 Tab chain      | 单窗口唯一 focus；Tab/Shift+Tab/删除节点/恢复行为明确                           | focus unit tests             | G3A-01                 | focus module、tree hooks、scheduler integration、tests              | M    |
| G3A-03 | [ ] 实现 pointer capture 与三阶段派发   | capture/target/bubble、stop propagation、default action 可测                    | event dispatch tests         | G3A-01、G3A-02         | dispatcher、hit test、event path、tests                             | M    |
| G3A-04 | [ ] 实现 `EditableText` value/selection | grapheme 安全插入删除、selection collapse/extend、revision 检查                 | editable text property tests | G2B-02、G2B-05         | editable text、selection、index map、tests                          | M    |
| G3A-05 | [ ] 实现键盘编辑命令                    | Arrow、Backspace、Delete、Home/End、Shift selection 与平台 modifier 正确        | command table tests          | G3A-01、G3A-04         | keyboard commands、editable text、platform key map、tests           | M    |
| G3A-06 | [ ] 接入 IME composition                | Start/Update/Commit/Cancel 更新 preedit/range，避免 KeyboardInput 重复插入      | platform event integration   | G3A-04、G3A-05         | winit IME、composition model、dispatcher bridge、tests              | M    |
| G3A-07 | [ ] 实现 caret/selection hit testing    | point <-> text offset、caret bounds、selection rects 使用 paragraph cluster map | paragraph hit-test tests     | G2B-05、G3A-04         | paragraph hit test、editable layout、paint commands、tests          | M    |
| G3A-08 | [ ] 实现 `TextArea` 多行布局与滚动      | Input/TextArea 复用 EditableText；Enter、上下移动、可见行和内部滚动正确         | multiline editor tests       | G3A-04、G3A-05、G3A-07 | TextArea primitive、multiline controller、paragraph viewport、tests | M    |
| G3A-09 | [ ] 接入 TextInputClient FFI            | surrounding text/selection/replace/composition bounds 无损跨边界                | contract + Perry tests       | G3A-06..G3A-08         | protocol、Bridge client、TS interface、FFI manifest、tests          | M    |
| G3A-10 | [ ] 完成 Button interaction states      | invoke 在合法 release/Space/Enter；hover/pressed/focus/disabled 状态可观察      | component/event tests        | G3A-02、G3A-03         | Button primitive、default action、style state、tests                | M    |
| G3A-11 | [ ] 建立 CJK/Emoji 输入 E2E             | 单行/多行 preedit、候选 bounds、跨行选择、删除、复制粘贴可复现                  | macOS/Windows scenario       | G3A-09、G3A-10         | E2E scenario、fixture app、platform harness                         | M    |

微检查点：G3A-01..03 验证事件/焦点/派发；G3A-04..06 验证编辑命令和 IME 模型；G3A-07..09 验证命中、多行和 FFI；G3A-10..11 验证控件状态与平台 E2E。

## G3B：Semantics 与 AccessKit

| ID     | Todo                                | Acceptance                                                            | Verify                            | Dependencies   | Files                                                                           | Size |
| ------ | ----------------------------------- | --------------------------------------------------------------------- | --------------------------------- | -------------- | ------------------------------------------------------------------------------- | ---- |
| G3B-01 | [ ] 增加 Semantics Host command     | Set/Clear 可版本化，组件默认语义可被显式覆盖                          | contract tests                    | G1             | protocol、generated outputs、Host props、Bridge command、tests                  | M    |
| G3B-02 | [ ] 实现 Semantic Tree 派生/diff    | role/name/value/state/bounds/actions 形成独立 snapshot；更新只发 diff | semantic snapshot tests           | G2C-01、G3B-01 | semantic tree、deriver、diff、tests                                             | M    |
| G3B-03 | [ ] 实现 Button/Text/Input 默认语义 | label/value/disabled/focus/action 与视觉状态一致                      | component semantic tests          | G3A-10、G3B-02 | UI primitives、Host defaults、semantic tests                                    | M    |
| G3B-04 | [ ] 接入 AccessKit desktop bridge   | 初始树、增量更新、focus 与 Invoke/SetValue action 走 Dispatcher       | AccessKit integration tests       | G2A-04、G3B-02 | AccessKit adapter、platform composition、dispatcher action、Cargo config、tests | M    |
| G3B-05 | [ ] 建立语义驱动 E2E                | Notes 控件用 role/name 定位和操作，不依赖像素坐标                     | macOS/Windows accessibility smoke | G3B-03、G3B-04 | E2E harness、scenario、reference fixture                                        | M    |

微检查点：G3B-01..02 验证 Host 到 Semantic Tree；G3B-03..05 验证组件默认语义、AccessKit 与平台 E2E。

### G3 Checkpoint

- [ ] 单行/多行中文 IME preedit/commit/cancel 与 Emoji selection 自动化通过
- [ ] Button/Input/Text 对辅助技术可读、可聚焦、可执行 action
- [ ] UI E2E 使用 Semantic Tree 定位

## G4：Task、权限、FS 与 Dialog

| ID    | Todo                                         | Acceptance                                                           | Verify                             | Dependencies  | Files                                                       | Size |
| ----- | -------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------- | ------------- | ----------------------------------------------------------- | ---- |
| G4-01 | [ ] 实现 generation TaskRegistry             | create/active/cancel/close/invalidate/late completion 状态完整且幂等 | state/property tests               | G2A-07        | task registry、handle、lifecycle hooks、tests               | M    |
| G4-02 | [ ] 实现 worker executor 与 completion queue | 阻塞操作不在 UI 线程；completion 只通过 Dispatcher settle            | concurrency/order tests            | G2A-04、G4-01 | executor、dispatcher completion、runtime integration、tests | M    |
| G4-03 | [ ] 建立 System `CommandResult/NexaError`    | denied/cancelled/not-found/invalid/platform 可区分并保留 source      | Rust/TS contract tests             | G1、G4-01     | system protocol、Rust error、TS error、FFI codec、tests     | M    |
| G4-04 | [ ] 实现 app manifest 与 permission loader   | 未声明能力一致拒绝；开发/发布 manifest 可验证                        | manifest schema + permission tests | G1、G4-03     | manifest schema、loader、permission set、tests              | M    |
| G4-05 | [ ] 实现 `@nexa/fs` 文本读写                 | UTF-8 read/write、atomic save、cancel、错误映射通过                  | temp-backend integration tests     | G4-02..G4-04  | system FS core、FFI host、TS package、tests                 | M    |
| G4-06 | [ ] 实现 `@nexa/dialog` 打开/保存            | cancel 返回显式空结果而非错误；owner close 可取消                    | mock + platform integration        | G4-02..G4-04  | dialog core、platform backend、FFI host、TS package、tests  | M    |
| G4-07 | [ ] 迁移 Clipboard 到 Task/Error             | 不再把失败压成空字符串/布尔值；测试使用注入 backend                  | clipboard unit/contract tests      | G4-02、G4-03  | clipboard core、system host、TS package、tests              | M    |
| G4-08 | [ ] 完成窗口关闭资源清理                     | 所属 Task/Subscription/Resource 失效，迟到 completion 不进框架       | close-race integration test        | G4-01、G4-02  | lifecycle、registry、dispatcher、tests                      | M    |

微检查点：G4-01..03 验证 Task/executor/error；G4-04..06 验证 manifest/FS/Dialog；G4-07..08 验证 Clipboard 迁移和 close race。

## G5：参考应用与开发者工作流

| ID    | Todo                             | Acceptance                                                         | Verify                       | Dependencies       | Files                                                       | Size |
| ----- | -------------------------------- | ------------------------------------------------------------------ | ---------------------------- | ------------------ | ----------------------------------------------------------- | ---- |
| G5-01 | [ ] 确认 North-star 应用 PRD     | 负责人确认 Notes 或替代场景、用户旅程与非目标                      | PRD review                   | G3/G4 设计接口稳定 | `docs/REFERENCE-APP.md`                                     | S    |
| G5-02 | [ ] 建立参考应用 Shell           | Window/toolbar/editor/status 基础布局响应缩放，使用 Minimal TSX    | typecheck + native smoke     | G5-01、G2C         | app package、main、manifest、layout test                    | M    |
| G5-03 | [ ] 接入编辑与 A11y 流程         | 标题/正文编辑、焦点、IME、语义操作完成                             | semantic/input E2E           | G3、G5-02          | app editor、toolbar、tests                                  | M    |
| G5-04 | [ ] 接入打开/保存/错误状态       | open/edit/save/cancel/denied/close race 形成完整用户流程           | app E2E                      | G4、G5-03          | app state、file commands、error UI、tests                   | M    |
| G5-05 | [ ] 定义基础 Style/Theme API     | typed token、hover/pressed/focus/disabled 在组件间一致；不实现 CSS | API/visual tests             | G3A-10             | UI theme、style types、Button/Input、tests                  | M    |
| G5-06 | [ ] 实现 CLI `new` 与 `doctor`   | 新项目可生成；doctor 报告 Node/pnpm/Perry/ABI/target 错配          | CLI fixture tests            | G0、G1             | CLI manifest、new command、doctor command、templates、tests | M    |
| G5-07 | [ ] 实现 CLI `dev/build`         | 命令调用固定 Perry 工具链并输出可诊断构建结果                      | temp-project integration     | G5-06              | CLI build、process wrapper、diagnostics、tests              | M    |
| G5-08 | [ ] 实现 CLI `package`           | 复制正确 native library/assets/manifest，产物不依赖开发工具链      | package smoke                | G5-07              | packager entry、bundle layout、resource copier、tests       | M    |
| G5-09 | [ ] 生成 macOS/Windows 产物      | `.app` 与 Windows 分发目录在 runner 可启动，版本信息一致           | platform package matrix      | G5-08              | macOS packager、Windows packager、workflow、tests           | M    |
| G5-10 | [ ] 编写从零教程与 API reference | clean 用户按文档可 create-to-package；命令均真实存在               | docs smoke/link check        | G5-06..G5-09       | quickstart、API index、packaging guide、docs index          | M    |
| G5-11 | [ ] 选择并接入 Tier-1 Adapter    | 一个外部框架在参考应用核心切片通过 conformance/E2E                 | framework-specific app smoke | 负责人决策、G1、G3 | Adapter integration、example entry、tests、compat docs      | M    |

微检查点：G5-01..02 评审参考应用并通过 layout smoke；G5-03..05 验证输入/A11y/文件/主题核心流程；G5-06..08 验证 new-to-package；G5-09..11 验证平台产物、文档和 Tier-1 Adapter。

## G6：Technical Preview 发布

| ID    | Todo                              | Acceptance                                                                    | Verify                                   | Dependencies     | Files                                                        | Size |
| ----- | --------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- | ---------------- | ------------------------------------------------------------ | ---- |
| G6-01 | [ ] 定义公开包与构建产物          | 移除目标包 `private`，exports 指向真实 dist/types，未发布包继续 private       | `pnpm pack --dry-run` + consumer fixture | G5               | release package configs、build config、consumer fixture      | M    |
| G6-02 | [ ] 建立版本与 changelog 流程     | Protocol/Perry/framework 兼容矩阵和 SemVer/Changesets 规则明确                | version PR rehearsal                     | G6-01            | changeset config、CHANGELOG、version policy、scripts         | M    |
| G6-03 | [ ] 补齐许可证与治理文件          | MIT/Apache 双许可文件、CONTRIBUTING、SECURITY、CODEOWNERS 存在且 owner 明确   | community health/check links             | 无，可与 G5 并行 | LICENSE 文件 2 个、3 个治理文件                              | S    |
| G6-04 | [ ] 增加供应链门禁                | cargo audit/deny、npm audit registry、license、secret scan、Action SHA policy | 故意失败 fixture 阻断                    | G0               | security workflow、deny config、registry config、policy docs | M    |
| G6-05 | [ ] 生成 checksum/SBOM/provenance | 每个 release artifact 可验证来源与完整性                                      | release dry run                          | G6-01、G6-04     | release workflow、SBOM script、verification docs             | M    |
| G6-06 | [ ] 明确签名/公证流程             | macOS/Windows 凭据 owner、失败处理和无签名开发产物区分清楚                    | staging signed release                   | G5-09            | signing workflow、platform config、runbook                   | M    |
| G6-07 | [ ] 建立性能基线与预算            | cold start、idle memory、bundle、tick/layout/paint 有 runner、基线和回归阈值  | benchmark workflow                       | G2C-07、G5-04    | benchmark app、runner、budget config、workflow               | M    |
| G6-08 | [ ] 发布 rehearsal                | 从 tag 到制品、安装、回滚全流程在 staging 成功                                | release checklist                        | G6-01..G6-07     | release runbook、checklist、workflow fixes                   | M    |
| G6-09 | [ ] 发布 Technical Preview        | 设计 12 条成功标准均有证据，release notes 与限制准确                          | 最终 release gate                        | 全部 G0..G6      | release metadata/docs                                        | S    |

微检查点：G6-01..03 验证消费包、版本和治理；G6-04..06 验证供应链、制品与签名；G6-07..09 验证性能、发布演练和最终证据。

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

## Definition of Done

任一 Todo 只有同时满足以下条件才能勾选：

- [ ] Acceptance 全部成立
- [ ] 指定自动验证通过，并在 PR 中记录命令/CI 链接
- [ ] 新行为有回归测试，错误路径与清理路径被覆盖
- [ ] 公开合同、ADR、Roadmap/Todo 状态同步更新
- [ ] 没有新增未解释的 warning、format、lint 或 skipped project
- [ ] 不相关用户改动未被覆盖或回退
- [ ] 风险、迁移与回滚方式在 PR 中说明
