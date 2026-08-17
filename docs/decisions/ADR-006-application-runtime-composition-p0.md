# ADR-006：Application Runtime、平台组合层与 P0 契约预留

- 状态：Accepted（Desktop Notes MVP Application Runtime 合同）
- 日期：2026-08-04
- 依赖：ADR-004（NUI Host）、ADR-005（System Host）
- 项目：Nexa UI / NUI
- 决策优先级：P0（写大量代码前必须定约，首版不必全实现）

## 1. 问题

前两版已覆盖：

- 框架 Adapter；
- UI Host；
- Node / Layout / Paint；
- 自绘渲染；
- System Host；
- 平台 API 雏形；
- 权限与插件方向。

但仍缺少一个关键认识：

> Nexa UI 不只是「UI Runtime + System Runtime」，中间还需要独立的 **Application Runtime**，下面还需要 **Platform Composition / Embedding** 层。

若不事先定约，后续 Demo（复杂文本、IME、无障碍、异步取消、GPU 恢复、Platform View）足以推翻现有接口。

## 2. 决策：五层顶层架构

```text
TypeScript / TSX
        ↓
Framework Adapter / Minimal TSX
        ↓
┌─────────────────────────────────────────┐
│ Application Runtime                     │
│ Scheduler / Task / Lifecycle / Error    │
├───────────────────┬─────────────────────┤
│ NUI Runtime       │ System Runtime      │
│ UI / Input / Text │ FS / Dialog / API   │
├───────────────────┴─────────────────────┤
│ Platform Composition Runtime            │
│ Window / Surface / PlatformView / A11y  │
├─────────────────────────────────────────┤
│ Windows / macOS / Linux / Android / iOS │
└─────────────────────────────────────────┘
```

| 层 | 职责 | 不负责 |
|----|------|--------|
| Application Runtime | Tick 调度、任务/取消、生命周期、错误监督、Promise 续体阶段 | 具体控件绘制、OS API 细节 |
| NUI Runtime | 节点树、布局、自绘、输入归一化、文本段落、语义派生 | 文件系统、插件、GPU 驱动细节 |
| System Runtime | OS 能力 Command/Resource/Subscription、权限 | UI 树突变 |
| Platform Composition | 窗口/Surface、PlatformView 嵌入、A11y 桥、线程约束 | 业务组件模型 |

Perry 仍只是 TS→原生的编译与 FFI 基础，不是上述任一层的语义所有者。

## 3. P0 契约（必须定约，可分切片实现）

### 3.1 文本不是普通绘图节点

完整链路：

```text
Unicode → 语言/脚本/方向 → 字体匹配/fallback → BiDi
       → HarfBuzz shaping → 断词/断行/对齐 → Glyph runs → 布局与绘制
```

还须覆盖：中文断行、连字符、阿拉伯文连写、RTL、Emoji ZWJ、彩色 Emoji、选择、光标命中、组合输入、密码字段。

`rust-skia` textlayout / SkParagraph 只提供基础排版，**不**替代输入框编辑语义。

**契约：** TextNode **不得**长期直接 `draw_str`。引入独立 crate：

```text
nui-text/
├── font-database
├── font-fallback
├── shaping
├── bidi
├── line-breaking
├── paragraph
├── selection
└── editable-text
```

首个文本验收集至少包含：

```text
Hello, Nexa
你好，Nexa UI
مرحباً بالعالم
👨‍👩‍👧‍👦 ❤️ 🧑🏽‍💻
English 中文 mixed text
```

**现状：** Slice 0–11 仍用简单 `draw_str`；`nui-text` 以骨架模块预留，替换路径见切片表。

### 3.2 输入法、焦点与键盘

统一输入模型：

```text
Raw Platform Input → Normalizer → Hit Test → Pointer Capture
  → Gesture Arena → Focus Manager → Event Dispatch
```

事件族：`PointerEvent` / `KeyboardEvent` / `TextInputEvent` / `CompositionEvent` / `FocusEvent` / `DragEvent` / `GestureEvent`。

IME 不得当作普通按键：开始组合 → 预编辑 → 候选框定位 → 提交 / 取消。

必须提前定义：

```ts
interface TextRange { start: number; end: number }
interface TextSelection { anchor: number; focus: number }

interface TextInputClient {
  surroundingText(): TextRange;
  selection(): TextSelection;
  replace(range: TextRange, text: string): void;
  compositionBounds(): { x: number; y: number; width: number; height: number };
}
```

**现状：** 单行 Input（Slice 9）已有 focus + IME Commit 雏形；`TextInputClient` 类型预留在 `@nexa/nui-host`，完整 Composition / 候选框定位后续切片。

### 3.3 Accessibility 不能最后补

自绘对 OS 只是像素。须有独立于 Visual Tree 的 Semantic Tree：

```text
Visual Tree → 派生 → Semantic Tree
  role / label / value / state / bounds / actions / focus
```

例：`<Button>保存</Button>` → `Role=Button, Name=保存, Actions=Invoke`。

首选跨平台桥：**AccessKit**（完整树 + 增量更新）。

NUI Node **第一版起预留**：

```ts
interface Semantics {
  role?: SemanticRole;
  label?: string;
  value?: string;
  description?: string;
  disabled?: boolean;
  checked?: boolean;
  actions?: SemanticAction[];
}
```

首版可只实现 Button/Text 的最小导出，但协议字段必须存在。

### 3.4 FFI 资源所有权与异步取消

五类 Handle：Node / Callback / Task / Subscription / Native Resource。

统一生命周期：`Created → Active → Closing → Closed → Invalidated`。

异步操作必须可取消：

```ts
const task = fs.readTextFile(path);
task.cancel();
const text = await task.result; // 或 CANCELLED
```

不得依赖 TS GC 关闭系统资源。Perry GC + 主线程回调 + 后台 worker 要求 Bridge **显式**管理跨 FFI 引用与 GC root（已有 click closure scanner；Task/Subscription 同模式扩展）。MVP 的 System API 是阻塞 OS 调用，G4-02 先采用固定大小标准线程池与 bounded queue；只有后续出现需要统一 async I/O reactor 的已验证场景时才引入 Tokio 或同类 runtime。

### 3.5 Application Scheduler 与主线程规则

完整 Tick（目标模型）：

```text
Event Loop Tick
├── 1. Platform Events
├── 2. System Completion
├── 3. Framework Microtasks
├── 4. State Effects
├── 5. Host Mutation Commit
├── 6. Layout
├── 7. Semantics
├── 8. Paint
├── 9. Present
└── 10. Deferred Cleanup
```

硬规则：

- 禁止 Layout/Paint 阶段修改组件状态；
- 禁止 Native Core **同步**回调进 TS（经 Scheduler 投递）；
- 禁止事件处理中嵌套提交 Frame；
- 禁止后台线程直接调用 Framework Adapter；
- 允许一个 Tick 内批量合并 Mutation。

引入：

```text
nui-app-runtime/
├── dispatcher
├── scheduler
├── task
├── frame-clock
├── lifecycle
└── error-supervisor
```

### 3.6 GPU Surface 丢失与重建

Window / Surface **不是**永久有效。须支持 Suspended → 释放 Swapchain；Resumed → 重建 Context/Surface → 重上传缓存 → Full Repaint。

区分 **CPU Resource**（字体源、图片源、Display List）与 **GPU Resource**（纹理、Glyph Atlas、RT、Shader）。业务与 Adapter **不得**直接持有 GPU 对象。

### 3.7 Platform View 逃生口

纯自绘不能覆盖全部：地图、视频解码器、厂商 WebView、系统相机预览、部分无障碍专用控件。

须支持在视觉树中嵌入原生子视图：

```text
NUI View
├── Self-drawn children
└── PlatformView (native surface / HWND / NSView / Android View)
      bounds ← layout
      z-order / clip ← composition
```

Composition Runtime 负责：裁剪、变换、焦点移交、命中测试分流（自绘 vs 原生）。没有 Platform View，产品会被迫回退到「整窗 WebView」或推翻 Host 协议。

## 4. 与现有 ADR 的关系

| ADR | 关系 |
|-----|------|
| ADR-004 | NUI Host / Adapter 仍有效；文本绘制路径将被 `nui-text` 替换，不推翻 Host 节点协议 |
| ADR-005 | System Host 仍有效；Task/Subscription 生命周期按本 ADR §3.4 补齐 |
| 本 ADR | 补上 App Runtime + Composition，并把 P0 缺口从「实现细节」提升为「稳定契约」 |

## 5. 垂直切片（契约落地顺序）

| Slice | 目标 | 状态 |
|------:|------|------|
| 13 | Semantics 字段预留 + Button/Text 最小语义 | 本提交骨架 |
| 14 | `nui-text` 段落管线替换 `draw_str`（验收集） | 计划 |
| 15 | `TextInputClient` + Composition 预编辑 | 计划 |
| 16 | App Scheduler Tick（合并 Mutation） | 计划 |
| 17 | AccessKit 桥（桌面 Button） | 计划 |
| 18 | Task cancel + 窗口关闭作废 | 计划 |
| 19 | Surface 重建路径（即便仍 CPU raster） | 计划 |
| 20 | PlatformView 占位（单平台） | 计划 |

## 6. 后果

- 后续 Demo 不会因「临时 draw_str / 无语义 / 无取消」而倒逼推翻 Host 边界。
- 实现可继续垂直切片，但评审以本 ADR 契约为准。
- 短期代码量增加（骨架 crate / 字段），换取接口稳定。

## 7. 刻意不做（本阶段）

- 完整 HarfBuzz/ICU 集成；
- 完整手势竞技场；
- AccessKit 全平台；
- GPU 后端（仍可 CPU raster，但保留重建协议）；
- 真实 PlatformView 产品化。
