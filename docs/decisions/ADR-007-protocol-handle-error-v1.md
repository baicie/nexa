# ADR-007：Protocol、Handle 与 Error Contract v1

- 状态：Accepted（MVP 实现闸门）
- 日期：2026-08-04
- 依赖：ADR-004（NUI Host）、ADR-005（System Host）、ADR-006（Application Runtime）
- 项目：Nexa UI / NUI
- 决策优先级：P0

## 1. 背景与问题

G0 已恢复可重复的工程基线，但当前 Host 边界仍有四类问题：

1. Rust、TypeScript 和 package manifest 重复定义 Node、Property、Event 和错误含义，数值可能漂移；
2. Rust 使用 generation handle，而 ffi.ts 将 packed u64 转成 JS number，超过 2^53 - 1 后不能无损表示；
3. 系统调用仍可能以空字符串、false 或 -1 表示失败，调用方无法区分 stale handle、权限拒绝和平台错误；
4. 没有可执行的版本协商、feature capability 和废弃规则，后续 Runtime、Text、A11y 和 System API 无法安全演进。

本 ADR 定义第一个稳定的 Nexa wire contract。协议 manifest、生成器和实现必须遵守本文；旧的临时 FFI surface 不属于稳定协议。

## 2. 决策摘要

- 稳定协议版本为 major/minor/patch 三元组；major 不同拒绝启动，minor 只允许向后兼容的增量，patch 不改变 wire contract。
- Transport、UI 与 System 使用独立的 feature namespace，UI/System 使用独立 error code domain；未知 optional feature 忽略，未知或缺失的 required feature 结构化失败。
- 逻辑句柄是 HandleRef { slot: u32, generation: u32 }。TS 表面使用固定 shape 对象；FFI 入参展开为两个 u32，创建结果中的 HandleRef 编码为规范 ASCII token，不通过 JS number 传 packed u64。
- Handle 的 kind、owner 和生命周期 state 存在 native registry 中，由 host 根据操作验证；它们不是客户端可伪造的信任字段。
- 所有稳定调用以结构化 NexaResult<T> 返回；错误使用稳定数值 code 和 symbolic name。message 只用于诊断，不是兼容合同。
- 数值 ID 永不复用。删除的命令、属性、事件、feature 和 error code 保留 tombstone；破坏 wire shape 或语义必须提升 major。

## 3. Protocol version 与 handshake

### 3.1 Wire types

协议字段的宽度固定为无符号 32 位，JSON/Perry 表面使用可精确表示的 JS number：

    ProtocolVersion {
      major: u32,
      minor: u32,
      patch: u32,
    }

    AbiVersion {
      major: u32,
      minor: u32,
    }

    FeatureBits {
      low: u32,   // bit index 0..31
      high: u32,  // bit index 32..63
    }

    FeatureSet {
      required: FeatureBits,
      optional: FeatureBits,
    }

    ProtocolHello {
      protocol: ProtocolVersion,
      abi: AbiVersion,
      clientRuntimeVersion: string,
      clientTargetTriple: string,
      transport: FeatureSet,
      ui: FeatureSet,
      system: FeatureSet,
    }

    ProtocolAccepted {
      protocol: ProtocolVersion,
      abi: AbiVersion,
      hostRuntimeVersion: string,
      hostTargetTriple: string,
      transport: FeatureBits,
      ui: FeatureBits,
      system: FeatureBits,
    }

u64 feature mask 不得通过 JS number 传输。feature bit 的唯一身份是稳定的 bit index，而不是字符串排序或数组位置。

### 3.2 Negotiation rules

1. Bootstrap `Handshake` 是 protocol common command，由 UI Host 提供；它的 symbol、参数和返回 ABI 在同一 ABI major 内不可改变。Host 在绑定或调用其他 namespace command 前先完成握手。
2. Host 先验证 protocol.major 和 abi.major。任一不同都返回 PROTOCOL_MISMATCH，不得启动半兼容 session。
3. 相同 protocol major 时，双方采用 min(client.minor, host.minor) 作为共同 protocol minor。更高 minor 只能使用对应 feature bit 标记的可选能力；基础字段必须保持兼容。
4. 相同 ABI major 时只接受 client.abi.minor <= host.abi.minor；accepted ABI minor 等于 client.abi.minor。ABI minor 只能在 dispatch table 末尾追加函数或使用旧 caller 可忽略的 metadata，不能改变既有 symbol 的 C ABI。
5. patch 只用于诊断和 bug-fix 追踪，不参与拒绝条件，也不得改变字段类型、字段含义、枚举数值或错误语义。
6. 对 transport、ui、system 分别计算 eligible = manifest 中 introduced version 不高于共同 protocol version 的 bit；clientSupported = client.required | client.optional；enabled = eligible & hostSupported & clientSupported。
7. missingClientRequired = client.required & ~(eligible & hostSupported)；missingHostRequired = host.required & ~clientSupported。任一非空都返回 UNSUPPORTED_FEATURE。
8. 未知 optional bit 被忽略并从 enabled 中清除。未知 required bit 按不支持处理，返回结构化错误；不能用“忽略未知 bit”绕过必需能力检查。
9. feature 的稳定身份是 namespace + bit；不同 namespace 可以复用同一 bit index。target triple 只提供诊断，真正的平台能力必须通过 feature 协商。
10. Handshake 成功后，session 固定协商结果；运行中不得改变 protocol/ABI major、accepted minor 或 enabled bits。能力变化必须关闭 session 并重新握手。

### 3.3 Manifest registry

protocol/common.json、protocol/nui-host.json 和 protocol/system-host.json 共同组成唯一协议源。common manifest 唯一定义版本、ABI、bootstrap command、transport feature、Handle kind 和 protocol error；namespace manifest 不复制这些字段。

每个 registry 项至少包含：

    id: stable integer
    name: stable symbolic name
    lifecycle: {
      status: active | reserved | tombstone
      introduced: { major, minor }
      deprecated: { major, minor } | null
      removed: { major, minor } | null
      replacement: qualified name | null
    }

Command 另外声明语义参数/返回和 required feature；Property 声明 value type、nullable 与 clear/default 语义；Event 声明 payload fields；Error 声明默认 retryability、severity 与 context keys；Task/Resource 声明对应 Handle kind。独立的 `ffiFunctions` registry 声明 ABI slot、native symbol、Perry primitive params/return、对应 Command 和 v1/legacy 状态。一个语义 Command 可以映射一个或多个 FFI function，避免把 AddEventListener 等语义命令错误压成单一 legacy symbol。只有这些 metadata 完整且交叉引用可解析时，生成器才允许输出 Rust、TypeScript 与 Perry 片段。

生成的 Rust、TypeScript 和 Perry manifest 是派生物。手改生成物、重复 ID、复用 tombstone ID、同一 namespace 的名称冲突都必须使 drift 校验失败。

## 4. Handle contract

### 4.1 Logical representation

稳定句柄只包含两个 wire 字段：

    export type HandleRef = Readonly<{
      readonly slot: number;       // uint32, 0..2^32-1
      readonly generation: number; // uint32, 1..2^32-1; 0 is invalid
    }> & { readonly __nexaHandleRef: unique symbol };

slot 可以为 0；generation == 0 表示无效句柄。可选句柄使用 null，不能把 { slot: 0, generation: 0 } 当 null。

FFI ABI 约束：

- HandleRef 的私有 wire token 固定为小写 ASCII `h1/<slot-8hex>/<generation-8hex>`。稳定 command 的 Perry manifest returns: "string"，承载版本化 `NexaResult` JSON；HandleRef success value 使用该 token，生成的 TS codec 解析后才构造 public object；
- Rust 字符串返回使用 `alloc_string(...).as_raw()` 并声明为 `*mut StringHeader`，对应 Perry LLVM `ptr` ABI；空串和 null 都不能作为失败 sentinel；
- 接收句柄的 function 将逻辑 HandleRef 展开为 params: ["u32", "u32", ...]；Rust 只接收两个已定宽的整数，不把任意 Perry pointer 当 ObjectHeader 读取；
- 可选 HandleRef 在 TS API 中仍使用 null；FFI 展开为 params: ["u32", "u32", "u32"] 的 presence/slot/generation，presence == 0 时后两项必须为 0，presence == 1 时按正常 HandleRef 验证；
- Perry `u32` boundary guard 必须先验证有限整数与 0..=2^32-1；native 仍验证 presence 只能为 0/1、generation 不能为 0；
- output-only jsvalue 若未来用于其他 payload，其 native C ABI 以 f64 bits 表示；Handle v1 不依赖手写 NaN-box 或 object shape；
- pod 在固定 Perry revision 中是 parameter-only descriptor，不能作为 return descriptor，因此不把 POD return 作为 v1 合同；
- packed u64 只允许留在 Rust 内部（例如 NodeId 的存储），禁止经过 JS number 或 manifest u64 参数/返回；
- 过渡期 legacy bigint/u64 exports 不属于 v1，迁移完成后必须从稳定 Host kit 和 manifest 移除。

固定 Perry revision 06137858dc8c6f80975238377138f2f948d6ef88 的证据是：Perry 对 string input 先执行 string/SSO guard 并物化为 `StringHeader*`，string return 使用 LLVM `ptr`；对 u32 input 验证类型、有限整数和 0..=2^32-1。它没有可在 native 边界安全区分任意 object、array 与 closure pointer 的公开 shape introspection API，因此 v1 禁止用 jsvalue 接收 HandleRef。G1-08 必须以最大 slot/generation token 做真实 Perry round-trip，并让 TS codec 拒绝非规范大小写/长度、generation 0、负数、小数、NaN、Infinity 和 2^32。

### 4.2 Native registry 与所有权

Handle identity namespace 以 native Host/runtime domain 为边界：NUI Host 与 System Host 是独立 nativeLibrary，不互相接受 HandleRef。每个 domain 内必须使用一个统一 allocator/registry，禁止按 kind 各自从 `(slot=0, generation=1)` 分配。NUI Host registry 覆盖 Node/Callback；System Runtime registry 覆盖 Task/Subscription/NativeResource。Native registry 为每个活动句柄保存：

    kind: Node | Callback | Task | Subscription | NativeResource
    owner: AppId + WindowId/session id
    generation: u32
    state: Created | Active | Closing | Closed | Invalidated

客户端的 HandleRef 只用于定位当前 Host domain 的 slot/generation；经 TS codec 展开的 tuple 不携带也不信任 kind、owner 或 state，也不能跨 Host domain 使用。每个命令按期望 kind、当前 owner 和允许状态验证后才可修改资源。

generation 从 1 开始，slot 进入可复用状态时递增；generation 溢出时永久退休该 slot，禁止回绕到旧值。Rust 内部 NodeId 可以继续采用 (generation << 32) | slot，codec 必须先拆成两个 u32 再过边界。

### 4.3 Lifecycle 与 stale semantics

    Created -> Active -> Closing -> Closed
                           \-> Invalidated

- Registry 为已关闭或已失效的 (owner, kind, slot, generation) 保留 runtime-scoped tombstone，即使 window reset 或 slot 被新 generation 复用也不删除；只有对应 Host/process runtime 真正销毁时才统一清空。window reset 只是 owner scope 结束，不是 registry/runtime 销毁。
- close/cancel 幂等：命中当前记录或 tombstone 的 Closing、Closed、Invalidated 句柄均返回成功 no-op；
- 非关闭操作命中上述 tombstone 返回 INVALID_STATE；
- slot 存在但 generation 既不匹配活动记录也不匹配 tombstone 时返回 STALE_HANDLE，不得静默忽略、panic 或操作新资源；
- kind 不匹配返回 INVALID_KIND；owner 不匹配返回 WRONG_OWNER；
- 窗口/session 关闭会使其所有 Callback、Task、Subscription 和 NativeResource 进入 Invalidated，迟到事件必须被丢弃并计入诊断指标；
- Registry 必须设置累计 identity 与 owner fence 的硬上限并暴露 used/remaining；创建时预留未来 tombstone 容量。容量耗尽返回结构化错误且原子失败，禁止丢弃旧 tombstone 或让 generation 回绕；
- 任何失败命令必须原子失败：不得部分修改 tree、callback registry 或资源状态。

## 5. Error contract

### 5.1 Result envelope

稳定 Host/System command 使用：

    export type NexaResult<T> =
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: NexaError };

    export type NexaError = {
      readonly domain: "protocol" | "ui" | "system";
      readonly code: number;          // stable uint32
      readonly name: string;          // stable symbolic name
      readonly severity: "ProtocolViolation" | "RecoverableOperation" | "FrameFailure" | "FatalRuntime";
      readonly operation: string;
      readonly retryable: boolean;
      readonly message: string;       // diagnostic only; never parse this
      readonly runtimeVersion: string;
      readonly context?: Readonly<Record<string, string | number | boolean>>;
      readonly platformCode?: string;
      readonly cause?: NexaError;
    };

FFI 不得让 Rust panic 穿过边界。v1 function 通过 Perry string 返回版本化 JSON `NexaResult` envelope，TS wrapper 必须先做完整 shape/range 校验再暴露结果。native failure、错误字符串、false、-1、空串和空指针都必须在边界内转换为 NexaResult；legacy sentinel 只在迁移适配层消化，不能进入新 manifest。

本节取代 PROJECT-DESIGN 6.10 中 `code: string` 的候选类型。稳定身份是 domain + numeric code；name 供可读分支与生成代码使用。cause 表达 source chain，runtimeVersion 记录产生错误的 Host runtime，severity 对齐 ErrorSupervisor 的四级路由。

### 5.2 Stable code registry

错误 code 为 domain prefix | local code 的 32 位数值；表中的 code 永不复用：

| Domain | Code | Name | Meaning |
|---|---:|---|---|
| protocol | 0x00010001 | PROTOCOL_MISMATCH | major 或 abi major 不兼容 |
| protocol | 0x00010002 | UNSUPPORTED_FEATURE | required feature 缺失或未知 |
| ui | 0x01000001 | INVALID_ARGUMENT | 参数类型、范围或 shape 错误 |
| ui | 0x01000002 | INVALID_KIND | 句柄 kind 与命令不匹配 |
| ui | 0x01000003 | WRONG_OWNER | 句柄属于其他 app/window/session |
| ui | 0x01000004 | STALE_HANDLE | slot generation 不匹配 |
| ui | 0x01000005 | INVALID_STATE | 当前生命周期状态不允许该操作 |
| ui | 0x01000006 | NOT_FOUND | 节点、属性或资源不存在 |
| ui | 0x01000007 | CANCELLED | 操作已取消或 owner 已关闭 |
| ui | 0x01000008 | PLATFORM_FAILURE | 平台窗口/渲染操作失败 |
| ui | 0x01000009 | INTERNAL_FAILURE | native 内部 invariant 失败 |
| system | 0x02000001 | INVALID_ARGUMENT | 参数类型、范围或 shape 错误 |
| system | 0x02000002 | INVALID_KIND | 资源 kind 与命令不匹配 |
| system | 0x02000003 | WRONG_OWNER | 资源属于其他 app/window/session |
| system | 0x02000004 | STALE_HANDLE | slot generation 不匹配 |
| system | 0x02000005 | INVALID_STATE | 当前生命周期状态不允许该操作 |
| system | 0x02000006 | NOT_FOUND | 文件、窗口、任务或资源不存在 |
| system | 0x02000007 | PERMISSION_DENIED | manifest/OS 权限拒绝 |
| system | 0x02000008 | CANCELLED | task/subscription 被取消或 owner 已关闭 |
| system | 0x02000009 | PLATFORM_FAILURE | OS API、网络或文件系统失败 |
| system | 0x0200000A | INTERNAL_FAILURE | native 内部 invariant 失败 |

同名错误在不同 domain 中仍是不同 code；调用方先按 domain/code 分支，不能只比较 name。后续新增错误只能追加，修正文案或平台诊断应保留原 code/name。

## 6. Deprecation 与兼容规则

- Node/Property/Event/Command/Permission/Task/Resource/Error/Feature 的数值 ID 一经发布永不复用；移除项保留 lifecycle.status: tombstone。
- minor 版本只允许添加可选字段、命令、错误或 feature；新增字段必须有默认解释，旧客户端可忽略。
- 改变字段类型、字段必填性、枚举含义、错误语义、句柄表示或 owner/lifecycle 语义都属于 breaking change，必须提升 major。
- 项目至少在一个 minor 版本中记录完整 deprecated version 并给出 replacement，下一 major 才能记录 removed version；tombstone 仍保留以防编号复用。
- Deprecated API 仍必须返回与原合同一致的结构化错误；不能借弃用期恢复 sentinel 或 silent fallback。
- Protocol major、ABI major 和各 manifest 的 ID namespace 独立递增；升级一个不自动暗示另一个兼容。

## 7. Compatibility matrix

| Client | Host | Result |
|---|---|---|
| protocol 1.x | protocol 1.x | 握手；启用 feature intersection |
| protocol 1.x | protocol 1.(x+1) | 握手；客户端只能使用已协商能力 |
| protocol 1.x | protocol 2.x | PROTOCOL_MISMATCH |
| client abi 0.x | host abi 0.(x+1) | 接受；accepted ABI minor 为 x |
| client abi 0.(x+1) | host abi 0.x | PROTOCOL_MISMATCH；旧 dispatch table 不足 |
| abi 0.x | abi 1.x | PROTOCOL_MISMATCH |
| unknown optional bit | any | 忽略并清除 |
| unknown required bit | any | UNSUPPORTED_FEATURE |
| stale HandleRef | same session | STALE_HANDLE，tree/resource 不变 |
| closed owner | late event | 丢弃；任务/回调进入 Invalidated |

## 8. Implementation and migration

G1 按以下顺序落地：

1. 将 common/UI/System protocol manifest、JSON schema 和 ID registry 加入仓库；
2. 从语义 registry 和独立 ffiFunctions registry 生成 Rust/TypeScript/Perry declarations，并在 CI 做重复运行和 drift 校验；
3. 在 TS Host kit 增加 HandleRef shape validation/tuple codec，在 bridge 中增加双 u32 codec 与 NexaResult/NexaError 构造器；新增 `_v1` symbol，不能原地改变 legacy u64 symbol 的 C ABI；
4. 新增 handshake export 和 TS wrapper，先在 Perry smoke 中覆盖 major mismatch、feature intersection 和 required missing；
5. 把 Node/Task/Resource 的创建返回迁移到 string NexaResult + canonical HandleRef token，把操作入参迁移到双 u32 HandleRef tuple；完成最大 slot/generation round-trip 后再删除 asU64；
6. 按 command 逐个把 void、空字符串、false、-1 迁移为 NexaResult，并为 stale、kind、owner、state 建立原子失败测试；
7. 旧 manifest function 在迁移期标记 deprecated，不得与 v1 新 function 共用相同 numeric ID。

迁移期间允许内部 NodeId::raw() 和 Rust u64 存储继续存在；禁止新增任何依赖 JS safe-integer packed handle 的 API。若未来 Perry 提供经过双平台验证的无损 native u64 或 POD return，可作为新 feature spike 评估，但不能悄然改变 v1 wire shape。

G4-03 implementation evidence (2026-08-07): System Core constructors and the independent System Host codec now enforce this result envelope for native command boundaries. Rust/TS contract tests are driven against the checked-in System error registry; the Clipboard sentinel migration was completed in G4-07 while the old symbols remain only as compatibility exports.

## 9. Alternatives considered

| 方案 | 结论 | 原因 |
|---|---|---|
| packed u64 经过 JS number | 拒绝 | 超过 2^53 - 1 后丢失 generation/slot 位 |
| HandleRef 作为 jsvalue 入参和返回 | 拒绝 | 当前 Perry 无公开、安全的 object shape introspection；错误 pointer kind 可能被当作 ObjectHeader，output 还需手工匹配 double/NaN-box ABI |
| HandleRef 作为 POD 参数 | 暂缓 | 固定 revision 支持 parameter-only POD，但不能返回；双向表示不对称且尚无真实 Perry object-to-POD 双平台证据 |
| 每个 HandleRef 展开为两个 u32 入参，string result 中使用 canonical token | 采用 | 单字段均可精确传输，string/u32 都有 Perry boundary guard，native 不依赖 pointer shape 或手写 NaN-box |
| packed u64/BigInt native ABI | 暂缓 | 当前 Perry u64 JS 表面仍依赖 safe integer；未来只能通过新 feature/ABI 评估 |

## 10. Consequences

正面影响：

- Handle 在最大 32+32 位范围内无损，stale/owner/kind 检查有明确落点；
- UI/System 能力可独立协商，生成物可作为单一事实源；
- 错误可被应用、日志和 Inspector 可靠消费，不再依赖脆弱文案；
- 新增字段和 API 的兼容边界清晰，后续 Runtime、Text、A11y 和 System slice 有稳定接缝。

代价与约束：

- 句柄创建需分配并解析短字符串结果，句柄入参比 packed value 多一个 u32 参数；P0 优先正确性，后续可通过批量 command 和 profile 数据优化；
- runtime-scoped closed tombstone 的空间开销与已关闭句柄数线性相关；实现必须在 runtime 销毁时清空，并设置可观测且可执行的 identity/owner 硬预算；
- 所有边界调用都需要构造/解析 Result，旧的 void API 迁移工作量增加；
- ID registry 和生成器成为发布流程的一部分，任何协议改动都必须伴随 schema、fixture 和 drift 证据。

## 11. ADR review checklist

| Check | Result |
|---|---|
| Version major/minor/patch 与拒绝条件明确 | 通过 |
| Transport/UI/System feature namespace 分离，unknown/required 规则明确 | 通过 |
| Handle 的宽度、null、generation、owner、kind、state 与 tombstone 保留明确 | 通过 |
| 固定 Perry revision 的实际 ABI 能力已核验，Handle 只用 guarded string/u32 transport | 通过 |
| 最大 slot/generation round-trip 的实现证据路径已定义 | 通过 |
| Error code/name/domain、sentinel 禁止和 FFI panic 边界明确 | 通过 |
| stale、wrong owner/kind、invalid state 和幂等 close 语义明确 | 通过 |
| ID 永不复用、tombstone、deprecated 与 major removal 规则明确 | 通过 |
| 迁移顺序、兼容矩阵、替代方案和后果已记录 | 通过 |
| ADR-004/005/006 的职责边界无冲突 | 通过 |
