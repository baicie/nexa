# ADR-005：跨平台系统 API、权限模型与插件架构

- 状态：Proposed（Slice 12 剪贴板垂直切片已落地）
- 日期：2026-08-04
- 依赖：ADR-004 框架适配器与 NUI Host
- 项目：Nexa UI / NUI
- 决策优先级：核心

## 1. 问题

Nexa UI 不仅需要绘制跨平台界面，还必须让 TypeScript 应用访问：

- 窗口与应用生命周期；
- 文件与目录；
- 文件选择器；
- 剪贴板；
- 通知；
- 系统托盘和菜单；
- 网络；
- 进程和命令执行；
- 全局快捷键；
- 相机、麦克风、定位、蓝牙；
- Android/iOS 权限与生命周期；
- 第三方原生 SDK。

这些能力不能放进：

- UI Renderer；
- React/Vue/Solid Adapter；
- TSX Runtime；
- Perry 编译器。

否则框架、渲染、平台代码会高度耦合。

## 2. 决策

Nexa UI 由三个相互独立的核心协议组成：

```text
┌──────────────────────────────────────┐
│ TypeScript / TSX Application         │
├──────────────────────────────────────┤
│ Framework Adapter                    │
│ Minimal TSX / Solid / Vue / React    │
├──────────────────┬───────────────────┤
│ NUI Host         │ Nexa System Host  │
│ UI 节点操作       │ 系统能力调用       │
├──────────────────┼───────────────────┤
│ NUI Runtime      │ System Runtime    │
│ Tree/Layout/Event│ Command/Permission│
├──────────────────┴───────────────────┤
│ Platform Runtime                     │
│ Window/Event Loop/Lifecycle/Threads  │
├──────────────────────────────────────┤
│ macOS / Windows / Linux / iOS/Android│
└──────────────────────────────────────┘
```

职责划分：

```text
NUI Host
负责：
- 创建和销毁 UI 节点
- 设置属性
- 节点树操作
- UI 事件监听
- 布局和重绘提交

System Host
负责：
- 调用操作系统能力
- 权限验证
- 异步任务
- 原生资源管理
- 系统事件订阅
- 插件注册

Platform Runtime
负责：
- 主线程和事件循环
- 应用生命周期
- 窗口生命周期
- UI 与后台任务调度
- 平台初始化与退出
```

Perry 当前负责把 TypeScript 编译为原生目标程序，因此 `packages/system-host`（Perry nativeLibrary）可作为 TypeScript 与 Rust System Host 的第一代边界。Perry 本身只被视为编译和 FFI 基础，而不是平台 API 的抽象层。

`nui-system-core` 不依赖 `perry-ffi` / Skia / Adapter，与 `nui-perry-bridge` 对称。

## 3. TypeScript API 设计

系统能力不通过万能 `invoke()` 暴露，而是提供类型化模块：

```text
@nexa/app
@nexa/window
@nexa/dialog
@nexa/fs
@nexa/path
@nexa/clipboard
@nexa/notification
@nexa/menu
@nexa/tray
@nexa/shortcut
@nexa/process
@nexa/http
@nexa/device
@nexa/camera
@nexa/location
@nexa/bluetooth
@nexa/plugin
```

应用侧示例：

```ts
import { openFile } from "@nexa/dialog";
import { readTextFile } from "@nexa/fs";
import { writeText } from "@nexa/clipboard";
import { currentWindow } from "@nexa/window";

const selected = await openFile({
  title: "选择文本文件",
  filters: [{ name: "Text", extensions: ["txt", "md", "json"] }],
});

if (selected) {
  const content = await readTextFile(selected);
  await currentWindow.setTitle(selected.name);
  await writeText(content);
}
```

不建议公开万能字符串调用作为主 API；`invoke` 仅保留在内部协议与调试工具中。

## 4. System Host Protocol

### 4.1 Command

一次请求对应一次结果（TS 表面为 `Promise`；首版桌面实现可同步完成并立即 settle）。

适用于：读文件、文件选择器、剪贴板、系统信息、通知、创建窗口。

### 4.2 Resource

拥有生命周期的原生对象使用 generation handle（64-bit），禁止 TS 持有 Rust 指针。

适用于：文件流、TCP/WebSocket、子进程、相机 Session、多窗口对象。

### 4.3 Event Stream

系统主动推送：窗口尺寸、前后台、文件变化、网络状态、剪贴板变化等。

## 5. 异步与线程模型

系统 API 不应阻塞 UI 线程（长期目标）。

```text
UI Thread          Worker Runtime
Framework/NUI      Filesystem / Network / Process
Layout / Paint     Plugin background tasks
System 回调分发
```

后台线程不得直接修改 NUI Node Tree、Framework State、Window、Skia Surface。

**Slice 12 现状：** 剪贴板读写在调用线程同步完成（桌面 macOS/Windows/Linux via `arboard`）。真正的 Worker + 事件循环投递留给后续切片。

## 6. 跨平台实现层

```text
crates/
├── nui-system-core/          # 命令 ID、权限、剪贴板等纯逻辑
packages/
├── system-host/              # Perry nativeLibrary FFI
├── clipboard/                # @nexa/clipboard 类型化 API
└── system/                   # 聚合 re-export（过渡）
```

平台专用 crate（windows/macos/linux/android/ios）按需引入，不阻塞桌面 Command 首版。

## 7. 权限模型（首版简化）

```text
PermissionId → Capability
ClipboardRead / ClipboardWrite   # Slice 12：默认允许（桌面）
FsRead / FsWrite                 # 后续：声明式 + 运行时确认
Camera / Microphone / Location   # 后续：OS 权限桥接
```

首版：桌面剪贴板默认授权；敏感能力必须在 `permissions` 清单中声明后才可调用。拒绝时返回结构化错误，不 panic。

## 8. 插件架构（暂缓实现）

第三方原生 SDK 通过：

```text
Plugin Manifest → 静态/动态链接 → System Host 注册表 → 类型化 TS 包
```

插件不得直接触达 NUI Host。完整插件加载器不在 Slice 12。

## 9. 垂直切片

| Slice | 目标 | 状态 |
|------:|------|------|
| 12 | System Host 骨架 + `@nexa/clipboard` 读写 | 完成 |
| 13 | `@nexa/fs` 本地文本读写 + 权限声明 | 计划 |
| 14 | `@nexa/dialog` 文件选择器 | 计划 |
| 15 | 异步 Executor + UI 线程投递 | 计划 |
| — | 通知 / 托盘 / 快捷键 / 移动端权限 | 暂缓 |

## 10. 后果

- UI 与系统能力边界清晰，可独立演进与测试。
- 每个能力有独立 npm 包，避免巨石 `@nexa/system`。
- Perry 仅作 FFI 边界；业务语义在 `nui-system-core`。
- 首版同步剪贴板降低集成成本，但必须在文档中标明异步迁移路径。

## 11. 刻意不做（本阶段）

- 万能 `system.invoke` 公开 API；
- 相机 / 蓝牙 / 定位；
- Android/iOS 权限完整桥接；
- 动态插件热加载；
- WebView；
- 与 NUI Host 混用同一 FFI 表（System 使用独立 nativeLibrary）。
