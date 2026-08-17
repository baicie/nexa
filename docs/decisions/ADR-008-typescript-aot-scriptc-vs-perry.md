# ADR-008：TypeScript AOT 与 Native FFI 后端选择（ScriptC vs Perry）

- 状态：**Accepted（Technical Preview）**
- 日期：2026-08-04
- 依赖：ADR-004（NUI Host）、ADR-005（System Host）、ADR-006（Application Runtime）、ADR-007（Protocol v1）
- 项目：Nexa UI / NUI
- 决策范围：应用侧 TypeScript AOT 编译器、Native FFI 与发布工具链

## 1. 决策摘要

Technical Preview 阶段继续以 **按 [`TOOLCHAIN.md`](../TOOLCHAIN.md) 精确锁定的 Perry（当前为 0.5.1220）作为唯一受支持的 TypeScript AOT / Native FFI 后端**。不迁移到 ScriptC，也不同时承诺两个生产后端。

ScriptC 0.0.x 保留为候选后端，但只能在隔离、非 required 的验证通道中评估。它只有通过本文定义的替代门禁后，才可由新的 ADR 提升为受支持后端或默认后端。

同时作出三项约束：

1. Nexa Protocol、UI/System Runtime 和公共 TypeScript API 的语义不得由 Perry 私有类型定义；Perry ABI 只存在于 transport adapter 与 FFI package 中。
2. 当前不为尚未通过最小垂直切片的第二后端创建通用 `CompilerBackend`、双 manifest 或双 CI 矩阵。
3. 未来若引入 ScriptC，必须新增 ScriptC transport/FFI 实现并保持 Protocol v1 语义，不得在原位把 Perry ABI 描述改名为“通用 ABI”。

该决定选择的是当前可证明的交付路径，不是永久绑定 Perry。

## 2. 背景

Nexa UI 的目标是让 TypeScript/TSX 应用经 AOT 编译后驱动 Rust Native UI Core、Skia 和平台能力，不依赖 WebView 或 Chromium。

当前仓库已经围绕 Perry 建立了可执行证据：

- Perry CLI 固定为 `0.5.1220`，两个 FFI crate 固定到同一 `perry-ffi` revision `06137858dc8c6f80975238377138f2f948d6ef88`；
- Minimal TSX、Solid、Vue、React、Svelte 已接入 NUI Host；
- macOS/Windows 的四框架 clean AOT 矩阵为 8/8 PASS；
- Protocol v1 的 string `NexaResult`、双 `u32` HandleRef、closure callback 与 GC root scanner 都已有 Perry ABI 设计和实现；
- Rust Core 与 `nui-perry-bridge` 刻意不依赖 `perry-ffi`，因此核心运行时并未与 Perry 内部对象模型绑定。

ScriptC 是新的 TypeScript-to-native 编译器。它的静态分析、真实 TypeScript checker、fail-closed coverage、较小运行时和显式 C ABI manifest 对 Nexa 有吸引力，因此需要决定是立即切换、正式支持双后端，还是继续 Perry 并保留复议路径。

## 3. 评估快照

本 ADR 只对以下固定快照负责。未来版本能力变化必须重新验证，不能把本文结论外推为永久事实。

| 项目 | 固定快照 | 证据日期 |
|------|----------|----------|
| Nexa UI | `mvp@8f438dcb96661a014899467cf7a3adc79b0c9f1e` | 2026-08-04 |
| G0 可信基线 | `35912970ce3bfffa891b1eff1008ebe041bb33c1` | 2026-08-04 |
| Perry CLI | `0.5.1220` | 2026-07-04 发布 |
| `perry-ffi` | `06137858dc8c6f80975238377138f2f948d6ef88` | 与 Perry `0.5.1220` 对齐 |
| ScriptC | `0.0.22` / `adae252881b75191b8f6dd362e2b47992fa08680` | 2026-08-03 发布 |

ScriptC 仓库于 2026-07-22 公开，当前仍为 `0.0.x`。Perry 同样未到 1.0，因此本决策不把任一项目视为稳定平台；判断依据是 Nexa 所需能力与仓库内可复现证据。

## 4. 决策驱动因素

按优先级排序：

1. **Protocol 与事件模型正确性**：必须保持 ADR-006 Scheduler 和 ADR-007 Handle/Error contract，不接受 silent fallback。
2. **已证明的 TSX 与框架兼容性**：Nexa 不是单纯的 TypeScript CLI 工具；Minimal TSX 与框架 Adapter 是产品表面。
3. **跨平台可发布性**：Technical Preview 需要 macOS/Windows，路线图还包含 Linux 与移动端。
4. **可重复工具链**：编译器、FFI crate、native archive、打包和 CI 必须能锁定并从 clean checkout 重建。
5. **迁移成本与故障隔离**：当前 G1 正在稳定 Protocol v1，不能同时替换编译器、FFI 和事件模型。
6. **性能与产物质量**：包体、启动、RSS 和构建时间重要，但必须用 Nexa workload 同机测量，不能用两个项目各自的 vendor benchmark 直接比较。

## 5. 能力对照

| 维度 | Perry 0.5.1220 | ScriptC 0.0.22 | 对 Nexa 的影响 |
|------|----------------|----------------|----------------|
| Minimal TSX | 仓库内可直接 AOT，已有运行 smoke | 能解析 `.tsx` 路径，但 0.0.22 不采用项目的 `jsx`/`jsxImportSource` 选项，CLI 也没有 JSX override，直接 `coverage` 报 `SC0001` | ScriptC 尚未通过最小入口 |
| 框架 | Solid/Vue/React/Svelte 在 macOS/Windows clean AOT 8/8 | 静态层明确不支持一般 `Proxy`；npm JS 通常需要 `--dynamic` 或实验性 `--npm-static` | Vue/React 等没有等价证据 |
| Outbound FFI return | 支持 string、promise、jsvalue、handle 等 | executable FFI return 仅支持 `f64/bool/u8/u32/i32/void`；string/bytes 仅可作为借用入参 | 不能承载 ADR-007 的 string `NexaResult` |
| Native -> TS 事件 | `JsClosure`、GC root scanner、event pump 已提供 | executable FFI 明确不支持 callback | 不能直接实现当前输入/窗口事件链 |
| Library embedding | Nexa 当前不需要反转宿主关系 | `build --lib` 可导出 string/bytes 等 C ABI，并有 contract sidecar；但 outbound FFI 当前不支持 library mode | 单独使用 library mode 仍无法让 TS 调用 Rust Host |
| Handle/Error contract | 双 `u32`、string token、handshake 已有实现路径 | 标量 `u32` 入参可表达 HandleRef，但没有 string result 与 callback 生命周期 | 只能复用部分 wire 字段，不能复用完整 transport |
| 桌面目标 | macOS/Linux/Windows 有平台 CLI 包，Nexa 已验证 macOS/Windows | macOS arm64 为 primary；Linux/Windows 通过 Zig cross-compile，native input 必须按目标预构建 | 可评估，但尚无 Nexa native archive 链接证据 |
| 移动目标 | Perry 支持 iOS/Android 等目标 | 当前官方平台页未列 iOS/Android | 与 Nexa 长期路线不对齐 |
| npm / 动态语义 | 当前四框架路径已针对 Perry 收敛 | 静态模式 fail-closed；`--dynamic` 嵌入 quickjs-ng，且 cross-compiled dynamic binary 尚不支持 | 动态模式不是当前 AOT 路径的等价替换 |
| 诊断与类型检查 | SWC 前端，仓库依赖真实矩阵发现兼容问题 | 使用 TypeScript checker，提供逐语句 coverage 与明确 blocker code | ScriptC 在可诊断性上有明显优势 |
| 性能/包体 | Nexa 有 build/run 基线，无统一预算 | 官方展示更小 hello binary 和低启动/RSS | 值得测量，但不足以推翻协议硬阻塞 |
| License | MIT | Apache-2.0 | 两者均可与 Nexa 的 MIT OR Apache-2.0 策略共存 |

### 5.1 本地最小验证

在当前仓库执行：

```bash
npx --yes scriptc@0.0.22 coverage examples/counter/main.tsx
```

结果为 4 个 `SC0001`，首个错误是：

```text
Cannot use JSX unless the '--jsx' flag is provided.
```

ScriptC 0.0.22 只采用一组固定的 typecheck compiler options，其中不包含 `jsx` 或 `jsxImportSource`，CLI 也未提供 JSX override。无论从仓库根目录还是示例目录执行，当前 Nexa `tsconfig.json` 都不能让它直接分析该入口。

这不证明 ScriptC 永远不能支持 TSX。预先用其他工具转换 JSX 可能形成替代构建链，但该链必须单独证明 source map、模块解析、增量构建和四框架行为，不能在 ADR 中假定成立。

### 5.2 当前最硬的阻塞不是 TypeScript 语法

Nexa Protocol v1 的成功结果通过 Perry string ABI 返回版本化 JSON。事件当前从 Rust 经受控 closure 回到 TS，ADR-006 要求后续改为 queue 并只在 Framework 阶段调用 closure。ScriptC executable FFI 目前同时缺少：

- owned string/bytes return；
- native -> TypeScript callback；
- callback root/lifetime contract；
- 与 `build --lib` 同时可用的 outbound FFI。

因此立即迁移至少需要重写 transport 或改变宿主拓扑。ScriptC library mode 可以设想由 Rust 驱动 `init/event/nextCommand` 的轮询模型，但这仍是 ABI 与 Scheduler 重设计。两条路径都会触及 ADR-006/007，而不是单纯替换编译命令。

## 6. 决策

### 6.1 Perry 是 Technical Preview 的唯一 supported backend

- 默认与 required CI 继续使用固定 Perry CLI/FFI revision。
- Minimal TSX Perry runtime smoke、macOS/Windows 四框架 clean AOT、Host handshake conformance 与 macOS/Windows Rust native smoke 继续作为发布门禁。
- Perry 的已知问题继续通过 Bridge 隔离、版本固定、协议协商和 conformance test 管理；选择 Perry 不等于认可其所有运行时语义为 Nexa 合同。

### 6.2 ScriptC 仅保留隔离评估资格

- 不加入根 `devDependencies`、workspace package、默认构建、required CI 或公开兼容矩阵。
- 允许在临时分支、外部 spike 或非 required workflow 中固定版本验证。
- spike 不得修改 Protocol v1 语义，不得让 ScriptC/Perry 私有对象进入 `nui-core`、`nui-system-core` 或公共 Adapter API。
- 未通过本文门禁前，不发布 `@nexa/*-scriptc` package，也不宣称 ScriptC support。

### 6.3 暂不创建双后端抽象

当前只有一个可工作的后端。此时创建通用编译器接口会把 Perry 的 string/closure/GC 细节误抽象成“通用能力”，并在没有第二实现反馈时冻结错误边界。

第二后端先以垂直切片证明：

```text
Counter.tsx
  -> candidate compiler
  -> candidate transport
  -> existing Protocol semantics
  -> existing Rust Runtime
  -> click / state / commit / close
```

只有该链路成立后，才从两个真实实现提取最小公共接口。

## 7. ScriptC 替代门禁

满足以下全部条件后，才可以提出 superseding ADR。通过单项不能换取另一项失败。

### Gate A：编译与源码体验

- 直接支持 Nexa 的 TSX runtime，或提供已文档化的预编译链；
- Minimal TSX 的 JSX、source map、workspace resolution、tree shaking 与 clean cache 行为可重复；
- static/dynamic 边界可审计，构建不会静默嵌入 JS engine；若要正式采用 `--dynamic`，必须先用独立 ADR 接受其运行时、平台和安全后果。

### Gate B：Protocol 与 Native FFI

- 支持 length-delimited string/bytes result 的明确所有权，或提供不降低 ADR-007 错误合同的等价结果通道；
- 支持 native -> TS event delivery 及 callback/queue 的线程、生命周期和释放合同；
- Protocol 1.x handshake、最大 HandleRef、错误 envelope、close/cancel、late event drop 全部通过；
- FFI ABI 可固定版本并对 macOS/Windows native archive 做 clean link；
- Rust Core 与 Protocol 语义无需感知候选编译器或 runtime 的私有类型。

### Gate C：框架与运行时 parity

- Minimal TSX、Solid、Vue、React、Svelte 全部 clean AOT；
- 至少 Minimal TSX 与 superseding ADR 提交时已由 ADR 或当期发布计划明确选定的 Tier-1 外部框架完成真实 click/state/commit/close 交互测试，而不只是产出 executable；若没有已记录的 Tier-1 选型，Gate C 不通过；
- Scheduler tick、Promise/microtask、事件顺序和异常路由符合 ADR-006；
- 不通过同步 nested frame、不可回收 callback 或 silent dynamic fallback 换取表面成功。

### Gate D：平台、发布与运维

- macOS 与 Windows 同时通过 required native smoke；进入 Linux/mobile 支持阶段时，候选后端还需覆盖当期 required targets；
- CLI、compiler/runtime、FFI manifest 和 native archive 可固定并由 clean checkout 重建；
- `doctor` 能诊断 compiler/ABI/target mismatch；
- cache 禁用路径、产物清理、升级与回滚步骤可执行。

### Gate E：同 workload 比较

在相同 runner、相同 Nexa Counter/Todo workload 上记录：

- cold 与 warm build time；
- executable/app bundle size；
- cold start；
- idle 与交互 RSS；
- event -> commit -> present 延迟；
- clean matrix 成功率和诊断质量。

性能预算由当期发布 ADR/计划确定。Correctness、Protocol 和平台门禁为硬条件，不能因包体或 benchmark 更优而豁免。

## 8. Alternatives considered

### 8.1 立即迁移到 ScriptC

拒绝。当前直接 TSX 验证失败，executable FFI 缺少 Nexa 所需的 string result 与 callback，且没有四框架和跨平台 native archive 证据。迁移会与正在进行的 Protocol v1 收敛叠加，无法隔离故障来源。

### 8.2 正式支持 Perry + ScriptC 双后端

拒绝。框架、平台、FFI、打包与 CI 矩阵会近似翻倍，而 ScriptC 尚未通过单条端到端垂直切片。双后端承诺会早于能力证明。

### 8.3 现在先设计通用 `CompilerBackend`

拒绝。没有第二个可工作的实现，无法区分真正公共语义与 Perry 偶然的 ABI 形状。优先保持现有 Core/Bridge 隔离，在候选后端跑通后再提取接口。

### 8.4 使用 ScriptC `--dynamic` 运行框架/npm 依赖

暂不采用。该模式嵌入 quickjs-ng，改变纯 AOT 的产物、调度和内存假设；跨编译 dynamic binary 当前也不支持。它可以作为单独产品决策评估，不能作为本次 FFI/TSX 缺口的默认兜底。

### 8.5 永久绑定 Perry，不再评估其他编译器

拒绝。Perry 仍为 pre-1.0，并存在框架兼容、同步 callback、ABI 与工具链风险。Core/Protocol 保持语义隔离，并用明确 Gate 保留迁移能力，比永久绑定更符合长期风险管理。

## 9. Consequences

正面影响：

- G1 可以继续稳定 Protocol v1，不同时引入编译器与宿主拓扑变化；
- Technical Preview 继续使用已有 8/8 clean AOT 和 native smoke 证据；
- required CI 与发布矩阵不会在第二后端未证明前翻倍；
- ScriptC 的未来优势仍有客观、可执行的进入路径；
- Core 与公共 API 的后端中立原则被显式保留。

代价与风险：

- 继续承担 Perry 0.5.x 的 ABI、框架 workaround、callback rooting 和版本升级成本；
- 暂时无法利用 ScriptC 的 checker/coverage、潜在包体和启动优势；
- 若未来切换，仍需新增 transport、工具链、CI 和迁移期双跑；
- 本决定依赖持续维护 Perry 基线，不能因为“已选择”而停止升级审计。

## 10. 后续迁移规则

若 ScriptC 或其他后端通过 Gate A-E：

1. 写新 ADR supersede 本 ADR，并说明是否同时 supersede ADR-004 中 Perry AOT/FFI 的部分；
2. 从 semantic protocol manifest 生成独立 backend transport，不原位覆盖 Perry 生成物；
3. 新增候选 Host package 和非 required matrix，先与 Perry 同 workload 对照；
4. parity 达标后再把候选 job 提升为 required；
5. 默认后端切换必须有一版可执行回滚路径和兼容矩阵；
6. 同步更新 `PROJECT-DESIGN.md`、`TOOLCHAIN.md`、`BASELINE.md`、README 与发布文档。

旧 ADR 不删除。若决定变化，由新 ADR 保留本次选择的历史背景。

## 11. 证据来源

仓库内证据：

- [`BASELINE.md`](../BASELINE.md)：Perry 固定版本、8/8 framework AOT、native smoke 与已知边界；
- [`TOOLCHAIN.md`](../TOOLCHAIN.md)：Perry CLI/FFI 锁定与升级规则；
- [ADR-006](./ADR-006-application-runtime-composition-p0.md)：Scheduler 与禁止 native 同步回调的目标合同；
- [ADR-007](./ADR-007-protocol-handle-error-v1.md)：string `NexaResult`、HandleRef 与 ABI 规则。

固定外部证据：

- [ScriptC 0.0.22 README](https://github.com/vercel-labs/scriptc/blob/adae252881b75191b8f6dd362e2b47992fa08680/README.md)
- [ScriptC 0.0.22 Native FFI](https://github.com/vercel-labs/scriptc/blob/adae252881b75191b8f6dd362e2b47992fa08680/docs/src/app/ffi/page.mdx)
- [ScriptC 0.0.22 limitations](https://github.com/vercel-labs/scriptc/blob/adae252881b75191b8f6dd362e2b47992fa08680/docs/src/app/limitations/page.mdx)
- [ScriptC 0.0.22 platforms](https://github.com/vercel-labs/scriptc/blob/adae252881b75191b8f6dd362e2b47992fa08680/docs/src/app/platforms/page.mdx)
- [ScriptC 0.0.22 adopted compiler options](https://github.com/vercel-labs/scriptc/blob/adae252881b75191b8f6dd362e2b47992fa08680/packages/compiler/src/frontend/shared.ts#L223-L255)
- [ScriptC 0.0.22 `Proxy` static-lowering refusal](https://github.com/vercel-labs/scriptc/blob/adae252881b75191b8f6dd362e2b47992fa08680/packages/compiler/src/frontend/lowering/lower-classes.ts#L5453)
- [Perry 0.5.1220 native bindings overview](https://github.com/PerryTS/perry/blob/06137858dc8c6f80975238377138f2f948d6ef88/docs/src/native-libraries/overview.md)
- [Perry 0.5.1220 native binding ABI](https://github.com/PerryTS/perry/blob/06137858dc8c6f80975238377138f2f948d6ef88/docs/src/native-libraries/abi.md)
