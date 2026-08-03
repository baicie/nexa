# ADR-004：框架适配器、统一 Native UI Host 与最快可见 MVP

- 状态：Proposed
- 日期：2026-08-03
- 决策范围：Nexa/Perry Native UI
- 优先级：最高
- 前置决策：TypeScript/TSX AOT 编译、自定义跨平台渲染

## 1. 背景

项目目标是使用 TypeScript/TSX 开发跨平台应用，并满足：

- 不依赖 WebView 或 Chromium；
- TypeScript 通过 Perry AOT 编译为原生机器码；
- UI 由统一的自定义渲染体系绘制；
- 支持 Windows、macOS、Linux，后续支持 Android、iOS；
- 可逐步支持 Solid、Vue、React、Svelte 等前端框架；
- 仅兼容不依赖 DOM、Node 特定能力及动态运行时语义的部分 npm 生态；
- 最终提供文件系统、窗口、剪贴板、通知等系统能力。

Perry 已经提供 TypeScript 到原生可执行文件的编译能力，并覆盖桌面和移动平台，但其当前 UI 主要面向平台原生控件。

项目不采用 WebF 式 DOM/CSS 兼容层，而采用：

> 每个框架提供独立 Renderer Adapter，所有 Adapter 最终调用统一的 Native UI Host。

## 2. 决策

采用四层架构：

```text
Framework Layer
React / Vue 3 / Solid / Svelte / Nexa TSX
                    ↓
Framework Adapter Layer
react-adapter / vue-adapter / solid-adapter / svelte-compiler
                    ↓
NUI Host Protocol
create / insert / remove / setProperty / listen / commit
                    ↓
Native UI Core
Node Tree → Layout → Paint → Display List → Skia
```

框架 Adapter 不直接操作 Skia、Taffy、窗口或平台 API。

Native UI Core 不理解 React Fiber、Vue VNode、Solid Signal 或 Svelte Rune。

双方只通过稳定的 `NUI Host Protocol` 交互。

## 3. 为什么使用框架独立 Adapter

不同框架已经拥有不同的更新模型：

```text
React
Fiber Reconciliation
    ↓
React Adapter
    ↓
NUI Host

Vue
VNode Patch
    ↓
Vue Adapter
    ↓
NUI Host

Solid
Fine-grained Effects
    ↓
Solid Adapter
    ↓
NUI Host

Svelte
Compile-time Updates
    ↓
Svelte Compiler Backend
    ↓
NUI Host
```

如果强行让所有框架先输出一个共同 Virtual DOM，将产生第二次 Diff：

```text
Framework VDOM
    ↓ 第一次 Diff
通用 VDOM
    ↓ 第二次 Diff
Native Tree
```

这会增加：

- 中间对象分配；
- 生命周期映射难度；
- 更新延迟；
- 调试复杂度；
- 框架特性损失。

因此，统一的是 Host 操作和 Native Node，不是框架内部的组件模型。

## 4. 框架支持顺序

| 顺序 | 目标             | 决策                                      |
| ---: | ---------------- | ----------------------------------------- |
|    0 | Nexa Minimal TSX | 第一阶段使用，最小依赖，确保 Perry 能编译 |
|    1 | Solid            | 第一个第三方框架 Adapter                  |
|    2 | Vue 3            | 第二个 Adapter                            |
|    3 | React            | Host API 稳定后接入                       |
|    4 | Svelte           | 采用编译器后端，不做传统 Renderer         |
|    5 | Vue 2            | 非核心目标，单独评估                      |

### 4.1 首先实现 Minimal TSX

第一阶段不直接引入 React、Vue 或 Solid。

原因是第一阶段需要验证的是：

- Perry TSX 编译；
- Perry 与 Rust Native Core 的调用；
- Native Node Tree；
- 布局；
- 绘制；
- 输入事件；
- 状态更新；
- 打包后的原生程序。

如果一开始引入 React，问题可能来自：

- `react-reconciler`；
- Scheduler；
- CommonJS/ESM；
- Perry 对 npm 包的编译兼容；
- React 动态 JavaScript 语义；
- Native Host。

这会使问题难以定位。Perry 自身也曾跟踪 React、`react-reconciler` 和 Ink 的端到端编译问题，说明这仍是独立风险项。

因此，第一阶段实现不足 1,000 行的 Minimal TSX Runtime：

```tsx
import { Window, Column, Text, Button, signal, mount } from "@nexa/ui";

const count = signal(0);

function App() {
  return (
    <Window title="Nexa UI">
      <Column
        style={{
          width: 360,
          padding: 24,
          gap: 12,
        }}
      >
        <Text fontSize={28}>Count: {count.value}</Text>

        <Button onClick={() => count.value++}>Increment</Button>
      </Column>
    </Window>
  );
}

mount(App);
```

它不追求 React 兼容，仅提供：

- 函数组件；
- JSX；
- Signal；
- Effect；
- 条件节点；
- 列表节点；
- 组件销毁；
- 事件回调。

### 4.2 Solid 作为第一个框架 Adapter

Solid 官方提供 `solid-js/universal` 的 `createRenderer()`，用途就是创建原生、Canvas、WebGL、终端等非 DOM Renderer。

Solid 同时具备：

- TSX；
- 细粒度响应式；
- 组件通常只执行一次；
- 不依赖 Virtual DOM；
- Host 更新操作数量少；
- Adapter API 比 React 稳定。

因此它最适合验证：

> 一个成熟前端框架能否直接驱动 NUI Host。

### 4.3 Vue 3 作为第二个框架 Adapter

Vue 3 官方 `createRenderer()` 要求实现的接口与 NUI Host 高度相似：

```ts
createElement();
createText();
insert();
remove();
patchProp();
setText();
setElementText();
parentNode();
nextSibling();
```

Vue 官方明确说明，该接口用于把 Vue Core 运行在非 DOM 环境。

Vue Adapter 可以非常薄：

```ts
const renderer = createRenderer({
  createElement: host.createNode,
  createText: host.createText,
  insert: host.insert,
  remove: host.remove,
  patchProp: host.setProperty,
  setText: host.setText,
  setElementText: host.setText,
  parentNode: host.parent,
  nextSibling: host.nextSibling,
});
```

风险在于 Vue 3 响应式大量依赖 `Proxy`。Perry 当前文档表示相关兼容能力仍处于持续演进状态，因此必须通过真实兼容测试决定是否可用，不能只依据“能够编译 TypeScript”推断。

### 4.4 React 后置

React Adapter 使用 `react-reconciler`。

但该包被 React 官方明确标记为实验性，并且不遵循 React、React DOM 相同的稳定版本策略。

因此 React Adapter 必须：

- 锁定 React 与 `react-reconciler` 的准确版本；
- 单独维护 HostConfig；
- 建立 React 版本兼容矩阵；
- 不允许 React 内部类型进入 NUI Host；
- 不把 React 作为 Native UI Core 的默认运行时。

### 4.5 Svelte 使用编译器 Adapter

Svelte 本身是编译器，官方编译器可以把组件和 Rune 模块转换为 JavaScript。

Svelte Adapter 不实现运行时 VDOM，而是将：

```svelte
<Text>{count}</Text>
```

编译为：

```ts
const node = host.createNode(NodeType.Text);
host.setText(node, count);

effect(() => {
  host.setText(node, count);
});
```

该能力放在 Native UI Core 稳定之后开发。

## 5. 核心组件

### 5.1 NUI Host Protocol

第一版 Host API：

```ts
export type NodeId = bigint;

export enum NodeType {
  Root,
  View,
  Text,
  Image,
  Scroll,
}

export interface HostOps {
  createNode(type: NodeType): NodeId;
  createText(text: string): NodeId;

  insert(child: NodeId, parent: NodeId, before?: NodeId): void;

  remove(node: NodeId): void;

  setProperty(node: NodeId, property: PropertyId, value: PropertyValue): void;

  setText(node: NodeId, text: string): void;

  addEventListener(node: NodeId, event: EventType, callbackId: number): void;

  removeEventListener(node: NodeId, event: EventType, callbackId: number): void;

  commit(): void;
}
```

### 5.2 NodeId

不允许框架持有 Rust 指针。

使用 64 位 generation handle：

```text
高 32 位：generation
低 32 位：slot index
```

这样可以检测：

- 节点已经销毁；
- Adapter 持有过期引用；
- Slot 被重新使用；
- 错误的跨窗口节点操作。

### 5.3 PropertyId

不在 Native 边界传递任意字符串属性：

```ts
export enum PropertyId {
  Width,
  Height,
  MinWidth,
  MinHeight,
  Padding,
  Gap,
  FlexDirection,
  AlignItems,
  JustifyContent,
  BackgroundColor,
  BorderRadius,
  Opacity,
  FontSize,
  FontWeight,
  TextColor,
}
```

框架 Adapter 负责把：

```ts
style={{ padding: 16 }}
```

映射为：

```ts
host.setProperty(node, PropertyId.Padding, PropertyValue.number(16));
```

这能避免：

- 高频字符串比较；
- 属性名称拼写进入 Native Core；
- 任意动态属性污染；
- 不同框架属性语义不一致。

## 6. Native UI Core

Native UI Core 使用 Rust 实现：

```text
nui-core
├── arena
├── node-tree
├── mutation
├── style
├── layout
├── event
├── paint
├── display-list
└── scheduler
```

### 6.1 窗口与输入

使用 `winit`：

- 创建窗口；
- 鼠标、触摸和键盘输入；
- DPI 与窗口尺寸变化；
- 应用事件循环。

Winit 当前覆盖 Windows、macOS、Linux/X11/Wayland、iOS、Android 和 Web。

MVP 只启用：

```text
macOS
Windows
```

Linux、Android、iOS 不进入第一阶段验收。

### 6.2 布局

使用 Taffy。

Taffy 当前实现 CSS 风格的 Flexbox、Grid 和 Block 布局。

MVP 只开放 Flexbox 子集：

- row；
- column；
- width/height；
- min/max；
- padding；
- margin；
- gap；
- flex-grow；
- align-items；
- justify-content。

暂不支持：

- CSS 字符串；
- Cascade；
- Selector；
- Grid；
- 百分比复杂嵌套；
- 浏览器盒模型兼容。

### 6.3 绘制

使用 Skia，通过 `rust-skia` 接入。

`rust-skia` 提供桌面和移动端绑定，并覆盖 Vulkan、Metal、OpenGL 和 Direct3D 等 GPU 后端。

MVP 绘制能力：

- 矩形；
- 圆角矩形；
- 背景色；
- 边框；
- UTF-8 文本；
- 图片；
- 裁剪；
- 透明度。

暂不自行实现：

- GPU 光栅化；
- Path Tessellation；
- Shader 编译器；
- 字体 Rasterizer；
- 图片解码器。

这里的“自定义渲染引擎”指项目掌握：

```text
Node Tree
Layout Tree
Paint Tree
Display List
Layer/Clip
Dirty Region
Frame Scheduling
```

底层图形算法由 Skia 执行。

## 7. 帧处理流程

MVP 使用单 UI 线程：

```text
Perry/Framework 修改状态
        ↓
Framework Adapter 产生 Host Mutation
        ↓
Native Node Tree 更新
        ↓
标记 LayoutDirty / PaintDirty
        ↓
Taffy 计算布局
        ↓
生成 Display List
        ↓
Skia 绘制
        ↓
Present
```

第一阶段禁止：

- 独立 Render Thread；
- Worker；
- 异步布局；
- 多线程 Tree Mutation；
- 跨线程组件状态。

先证明正确性，再优化并行。

## 8. FFI 与传输策略

### 8.1 MVP：直接 Native Call

第一阶段使用 Perry Native Library 调用 Rust：

```text
Perry TS
    ↓
Native Function
    ↓
Rust NUI Core
```

示例：

```ts
declare function nuiCreateNode(type: number): bigint;
declare function nuiInsert(child: bigint, parent: bigint, before: bigint): void;
declare function nuiSetNumber(
  node: bigint,
  property: number,
  value: number,
): void;
```

这条路径最容易调试。

### 8.2 后续：Mutation Command Buffer

当单次更新出现大量 FFI 调用后，引入批处理：

```text
Adapter
  ↓
Mutation Buffer
  ↓ 一次提交
Rust Native Core
```

命令格式：

```text
CreateNode
InsertNode
RemoveNode
SetNumber
SetColor
SetString
AddListener
RemoveListener
Commit
```

第一阶段只定义协议，不提前实现复杂二进制序列化。

Perry 的外部 Native Library ABI 和版本化机制仍在建设，因此 NUI 必须通过自己的 `nui-perry-bridge` 隔离 Perry 细节，不能让 Perry Runtime 类型扩散到核心渲染模块。

## 9. 仓库结构

```text
nexa-ui/
├── crates/
│   ├── nui-core/
│   │   ├── src/tree/
│   │   ├── src/style/
│   │   ├── src/layout/
│   │   ├── src/event/
│   │   ├── src/paint/
│   │   └── src/scheduler/
│   │
│   ├── nui-platform-winit/
│   ├── nui-render-skia/
│   ├── nui-layout-taffy/
│   ├── nui-perry-bridge/
│   └── nui-devtools-protocol/
│
├── packages/
│   ├── ui/
│   │   ├── jsx-runtime.ts
│   │   ├── signal.ts
│   │   ├── component.ts
│   │   └── primitives.ts
│   │
│   ├── adapter-solid/
│   ├── adapter-vue/
│   ├── adapter-react/
│   ├── compiler-svelte/
│   └── system/
│
├── examples/
│   ├── counter/
│   ├── todo/
│   ├── layout-playground/
│   └── framework-parity/
│
└── tools/
    ├── cli/
    ├── packager/
    └── inspector/
```

## 10. 最快可见路径

### M0：Rust 原生渲染闭环

先完全不接 TSX，完成：

```text
winit window
→ Taffy layout
→ Skia rectangle/text
→ mouse click
→ redraw
```

验收：

- 打开一个原生窗口；
- 显示文字和按钮；
- 点击按钮后数字变化；
- 窗口缩放后重新布局。

这一阶段验证 Native Core，不验证框架。

### M1：Perry FFI 闭环

把节点创建和更新暴露给 Perry：

```ts
const root = host.root();
const column = host.createNode(NodeType.View);
const text = host.createText("Count: 0");

host.insert(column, root);
host.insert(text, column);
host.commit();
```

验收：

- Perry 编译出原生可执行程序；
- 程序启动后显示相同窗口；
- 点击事件能从 Rust 回调到 Perry；
- Perry 更新文本后触发局部重绘。

### M2：Minimal TSX

实现：

```text
jsx()
jsxs()
Fragment
mount()
signal()
effect()
onCleanup()
```

验收代码必须控制在单文件约 30 行：

```tsx
function Counter() {
  const count = signal(0);

  return (
    <Column>
      <Text>Count: {count.value}</Text>
      <Button onClick={() => count.value++}>Add</Button>
    </Column>
  );
}
```

验收：

- TSX 由 Perry AOT 编译；
- 不携带 JS 引擎；
- 点击只更新 Text 节点；
- 不重建整棵 Native Tree。

### M3：Solid Adapter

实现 Solid Universal Renderer 到 NUI Host 的映射。

验收：

- 标准 Solid Counter 可运行；
- `<For>`、`<Show>` 可运行；
- Signal 更新产生局部 Host Mutation；
- 不依赖 DOM Shim。

### M4：Vue 3 Adapter

实现 Vue `createRenderer()`。

验收：

- Composition API；
- `ref`；
- `computed`；
- `v-if`；
- `v-for`；
- 组件生命周期；
- 事件绑定。

若 Perry 无法稳定编译 Vue Runtime，则 Vue Adapter 保留，但不阻塞 Native UI Core 发布。

### M5：React Adapter

锁定具体 React/Reconciler 版本。

验收：

- 函数组件；
- `useState`；
- `useEffect`；
- 条件节点；
- 列表 Key；
- Context；
- Error Boundary。

Suspense、Concurrent Features 和 Server Components 不属于首版。

## 11. 第一版组件范围

### Native Primitive

```text
Root
View
Text
Image
Scroll
```

### Composite Component

```text
Column
Row
Stack
Button
Spacer
Card
```

`Button` 不作为 Native Primitive，而是：

```text
View
├── Background
├── Pointer Handler
└── Text
```

这样可以降低 Native Core API 数量。

暂不实现：

- Input；
- TextArea；
- 富文本；
- WebView；
- 视频；
- Canvas；
- Data Grid；
- Accessibility；
- 路由；
- 动画系统；
- 多窗口；
- 系统托盘；
- Android/iOS。

## 12. 样式策略

不实现 CSS。

使用类型化 Style：

```ts
interface Style {
  width?: number;
  height?: number;

  flexDirection?: "row" | "column";
  flexGrow?: number;

  padding?: number;
  margin?: number;
  gap?: number;

  alignItems?: "start" | "center" | "end" | "stretch";

  justifyContent?: "start" | "center" | "end" | "space-between";

  backgroundColor?: Color;
  color?: Color;
  borderRadius?: number;
  opacity?: number;
}
```

后续可以增加类似 Tailwind 的编译期 Style Macro，但不会增加运行时 Selector Engine。

## 13. 明确不做的事情

本 ADR 拒绝在 MVP 中实施：

### 13.1 不实现 DOM

不提供：

```text
document
HTMLElement
querySelector
CSSOM
MutationObserver
innerHTML
```

### 13.2 不追求 npm 全生态兼容

允许：

- 纯算法；
- 状态机；
- 数据处理；
- Parser；
- Schema；
- 与环境无关的业务逻辑。

不保证：

- 浏览器组件库；
- React DOM 组件；
- Vue DOM 组件；
- Monaco；
- ECharts DOM Renderer；
- Node Native Addon；
- 依赖 `eval` 的包。

### 13.3 不同时支持全部框架

Native Core、Minimal TSX 和 Solid Adapter稳定之前，不开始 React、Svelte 和 Vue 2。

### 13.4 不完全自研 GPU 后端

第一阶段使用 Skia，而不是直接实现 Vulkan、Metal 和 Direct3D 后端。

## 14. 关键风险

### 风险一：Perry npm 兼容性不足

表现：

- Solid/Vue/React 无法完整编译；
- 某些 JavaScript 动态语义不一致；
- 包升级导致编译失败。

措施：

- Minimal TSX 不依赖第三方框架；
- Framework Adapter 是可选包；
- Native Core 与 Perry 解耦；
- 建立 `perry-compat` 测试矩阵；
- 锁定依赖版本。

### 风险二：FFI ABI 变化

措施：

```text
Perry
  ↓
nui-perry-bridge
  ↓
稳定 NUI Core API
```

只修改 Bridge，不修改布局与渲染核心。

### 风险三：过早追求完整 UI

措施：

第一阶段用 Counter、Todo 和 Layout Playground 验证架构。

不以文本编辑器、IDE、Data Grid 作为首个 Demo。

### 风险四：框架语义泄漏

例如为了支持 React，把 Fiber、Lane 或 React Event 放进 Native Core。

措施：

NUI Host 只接受：

```text
Node
Property
Tree Mutation
Event Listener
Commit
```

不接受框架内部概念。

## 15. 成功标准

第一阶段成功必须同时满足：

1. TSX 能通过 Perry 编译成原生桌面程序。
2. 程序不使用 WebView、Chromium、Node.js 或 V8。
3. 所有 UI 都由 NUI Native Core 和 Skia绘制。
4. Counter 状态更新不重建整棵 Native Tree。
5. macOS 和 Windows 使用同一份 TSX 源码。
6. Release 包可以独立运行。
7. Native Core 不依赖 React、Vue、Solid 或 Svelte。
8. 至少一个外部框架 Adapter 能驱动同一套 Native Core。

## 16. 结论

最终采用：

```text
Perry
负责 TypeScript AOT 编译

Minimal TSX
负责最快验证产品形态

Framework Adapter
负责适配不同框架的组件与更新模型

NUI Host Protocol
负责稳定、框架无关的节点操作契约

Rust Native UI Core
负责节点树、布局、事件和调度

Taffy
负责 Flexbox 布局

Skia
负责跨平台图形绘制

Winit
负责窗口和输入
```

最快路径不是：

```text
先支持 React + Vue + Svelte
再开始画 UI
```

而是：

```text
Rust Counter
    ↓
Perry Host Calls
    ↓
Minimal TSX Counter
    ↓
Solid Adapter
    ↓
Vue 3 Adapter
    ↓
React Adapter
```

核心资产不是某个框架 Adapter，而是：

> 稳定的 NUI Host Protocol、Native Node Tree、增量布局、Display List 和跨平台渲染管线。

框架 Adapter 可以增加、升级甚至废弃，但 Native UI Core 不随框架变化。
