# Reference App: Notes

- 产品阶段：Desktop Notes MVP
- 主路径：Minimal TSX
- 平台：macOS、Windows
- 状态：G5-01..09 中的 Notes 直接产品路径已完成；run `31902303937` 在 macOS/Windows 通过 UIA/NSAccessibility、FS/Clipboard、真实 picker 与 fresh clean-runner 交付。MVP-02 的 clean-tag N-10/N-11 proof promotion 仍待执行

## 1. 用户问题

Notes 不是独立产品方向，而是 Nexa UI 的 north-star 验收应用。它用最小业务复杂度同时触发文本、输入、语义、系统 API、生命周期和打包边界，避免继续用 Counter 掩盖真实桌面应用缺口。

目标用户需要能够：创建一份文本、使用本地输入法编辑、从磁盘打开、保存、处理取消/错误，并在辅助技术和窗口恢复场景下继续工作。

## 2. 核心用户旅程

### Journey A：新建与编辑

1. 启动后显示空白、未命名文档。
2. 用户在标题中输入短文本，在正文中输入多行文本。
3. 中文 IME preedit 可见；commit/cancel 不产生重复字符。
4. Arrow、Home/End、Backspace/Delete、Shift selection 对 Emoji/grapheme 安全。
5. 状态栏显示 `未保存`。

### Journey B：打开文件

1. 用户调用打开命令。
2. Dialog cancel 保持当前文档，不显示错误。
3. 选择 UTF-8 文本后异步读取；成功替换正文并以文件名派生标题。
4. 权限拒绝、not found、invalid UTF-8 与平台失败显示可区分状态，当前内容不被部分覆盖。

### Journey C：保存文件

1. 已有路径时原子保存；无路径时先打开 Save dialog。
2. 保存期间按钮进入 busy/disabled，重复 invoke 不创建并发写任务。
3. cancel 保持 `未保存`；成功更新 saved revision 与状态栏。
4. 失败保留编辑内容并展示结构化错误摘要。

### Journey D：恢复与关闭

1. Suspend 释放 backend resource；Resume 后标题、正文、selection 与 dirty state 保留并完整重绘。
2. Close 时取消 dialog/read/write Task，迟到 completion 不再改变应用状态；已经显示的 native picker 不能被当前 `rfd` backend 主动关闭。
3. pending callback/resource/metrics 被收尾，不留下 GC root 或 backend cache。

实际 Window 现接收版本化 `Ready/Suspended/Resumed/CloseRequested`。重复 Ready/Suspended/Resumed 被去重；surface loss 会发出 Suspended，重建成功后发出 Resumed；CloseRequested 在 owner terminal fence 和 session close 前回调 controller，并在 Host mutex 外只执行一次。

### Journey E：辅助技术

1. 屏幕阅读器可读取文档标题、正文编辑器、打开按钮、保存按钮和状态。
2. Tab/Shift+Tab 按稳定顺序移动焦点。
3. Invoke 保存与 SetValue/Focus action 经 Dispatcher 返回组件，不同步重入框架。

共享 deterministic harness 与 native semantic reference fixture 已验证 role/name 和 Dispatcher 合同；实际 Notes TSX 树显式提供 `Button/打开`、`Button/保存`、`TextInput/标题`、`TextInput/正文`、`Text/当前状态` 五个稳定节点，并经语义路径执行 Focus、SetValue、Invoke。busy/状态变化只更新 value/disabled，不改变 role/name。run `31902303937` 的 macOS/Windows native jobs `95054897228` / `95054897192` 均完成真实平台 accessibility client smoke，关闭 G3B-05、G5-03 与 Journey E。

## 3. 信息架构

```text
Window
├── Toolbar
│   ├── Open button
│   ├── Save button
│   └── Document title input
├── Body text area
└── Status line
```

界面保持工作型、紧凑和可扫描。MVP 不增加欢迎页、模板页、侧栏、最近文件卡片或装饰性 hero。

`Window` 在 Host 中物化为 `NodeType.Root`，Root 每次布局都以当前 logical viewport 为尺寸并随 resize 更新。Notes 内容列使用 `flexGrow`，标题和正文使用 stretch width，已移除此前 `720x560`、`672x420` 等窗口级固定矩形。

## 4. 应用状态

```text
DocumentState
  path: string | null
  title: string
  body: string
  revision: u64
  savedRevision: u64

OperationState
  Idle
  Opening(taskId)
  Saving(taskId)
  Failed(operation, error)

WindowState
  Active
  Suspended
  Closing
  Closed
```

派生状态：

- `isDirty = revision != savedRevision`
- `canSave = WindowState.Active && OperationState.Idle`
- `displayName = path.fileName ?? "未命名"`

状态约束：

- 读取成功前不替换当前文档。
- 保存成功前不更新 `savedRevision`。
- 一个 owner 同时最多有一个 open/save foreground Task。
- 关闭后的 completion 只能被 registry 丢弃和记录，不能更新 TS state。

## 5. 组件与语义

| 控件   | 视觉角色 | Semantic role/name  | Action/state               |
| ------ | -------- | ------------------- | -------------------------- |
| Open   | Button   | `Button`, `打开`    | Invoke, disabled/busy      |
| Save   | Button   | `Button`, `保存`    | Invoke, disabled/busy      |
| Title  | Input    | `TextInput`, `标题` | Focus, SetValue, selection |
| Body   | TextArea | `TextInput`, `正文` | Focus, SetValue, selection |
| Status | Text     | `Text`, 当前状态    | none                       |

显式 semantics 会覆盖整个默认 semantic node；设置显式值时必须重新声明所需的 role、value、disabled 和 actions，Clear 后才恢复组件默认语义。

## 6. 文件合同

- MVP 只读写 UTF-8 plain text。
- 标题由文件名派生，不写入正文或额外元数据。
- 保存使用同目录临时文件 + replace/rename 的原子策略；平台不支持时返回 typed platform failure，不静默退化为部分写入。
- 测试只使用临时目录和注入 Dialog backend。
- 未声明 `system.FsRead` / `system.FsWrite` / `system.DialogOpen` / `system.DialogSave` 时，在执行平台操作前拒绝。
- `tools/reference-notes-build.mjs` 只在构建期设置 `NEXA_APP_MANIFEST_PATH`；System Host `build.rs` 将 manifest bytes 嵌入 native library。Notes 运行时不读取或选择 manifest 路径，只验证内嵌 release bytes 并以 `OnceLock` 安装一次。
- `NEXA_DIALOG_TEST_FIXTURE_PATH` 只供 deterministic smoke 构建使用，输入必须是 regular file 且上限为 64 KiB；共享 bounded reader 在读取前后检查大小。正式 build 会从所有 child process 清除该变量，build 与 packager 均拒绝带 fixture canary 的生产二进制。
- 未嵌入 manifest 时保持 deny-all；TypeScript 无 grant、reload 或 path 入口，二次安装不能扩大权限。
- 当前 `NativeDialogBackend` 只能把 `rfd::pick_file/save_file` 的 `Option<PathBuf>` 映射为 selected path 或 `None` cancel，真实 backend 没有 `PLATFORM_FAILURE` 返回分支；该错误只由注入 backend 合同覆盖。
- Dialog worker 不消费 cancellation token。Task cancel 或 owner invalidation 会立即终止结果交付并丢弃迟到 completion，但不能主动关闭已经显示的系统 picker。

## 7. 错误呈现

- Dialog cancel 是正常空结果，不进入 ErrorSupervisor 的错误历史。
- PermissionDenied、NotFound、InvalidData、Cancelled、PlatformFailure 保留独立 code/name；其中 native Dialog 当前只能实际产生 selected/cancel，PlatformFailure 只在注入 backend 合同中可达。
- 状态栏显示面向用户的短消息；完整 operation/code/context 进入诊断 sink。
- 错误不会清空当前文档、selection 或 dirty state。

## 8. E2E 场景矩阵

| ID   | 场景                                                     | 预期                                               |
| ---- | -------------------------------------------------------- | -------------------------------------------------- |
| N-01 | Latin/CJK/Arabic/Emoji 多行输入                          | 文本、caret、selection 无索引错位                  |
| N-02 | 中文 IME update -> commit                                | preedit 可见，commit 恰好一次                      |
| N-03 | 中文 IME update -> cancel                                | 原文恢复，无重复输入                               |
| N-04 | 打开 dialog cancel                                       | 当前文档和状态不变                                 |
| N-05 | 打开 invalid UTF-8                                       | typed error，当前文档不变                          |
| N-06 | 保存成功                                                 | 文件内容一致，dirty 清除                           |
| N-07 | 保存 permission denied                                   | dirty 保留，错误可诊断                             |
| N-08 | 保存中 close                                             | Task cancelled，迟到 completion 无效               |
| N-09 | suspend/resume                                           | 状态保留，新 surface 完整 present                  |
| N-10 | NSAccessibility/UI Automation -> AccessKit -> Dispatcher | 真实 client 无坐标定位并完成 Focus/SetValue/Invoke |
| N-11 | clean package launch                                     | unsigned artifact 不依赖开发工具链                 |

## 9. 非目标

富文本、Markdown 预览、自动保存、历史版本、云同步、协作、最近文件、拖放、打印、菜单栏集成和多窗口均不属于 Notes MVP。

## 10. G5 当前实施证据

- `examples/reference-notes` 已加入 pnpm workspace 与显式 workspace-check matrix；`reference-notes/**` 与 `packages/dialog/**` 均路由到对应的 TypeScript、FFI、Perry、native/package 集成门禁，CI 路由与 fail-closed 合同当前 21/21 通过。
- Minimal TSX Shell 已提供 Window、toolbar、title/body editor、status line，以及 typed dialog/FS 入口。Window 使用 viewport-managed `NodeType.Root`，内容采用 flex/stretch；Root resize Rust 回归 1/1 通过。
- `examples/reference-notes/state.ts` 将文档 revision、dirty、foreground operation、suspend/resume 与 close fence 独立为可测试控制器；controller 合同当前 15/15 通过，包含 Save dialog cancel 保持 dirty、pending read/write close 与迟到结果失效。
- `tools/reference-notes-e2e.test.mjs` 4/4 挂载实际 Notes TSX 树，按五个稳定语义节点执行 Focus/SetValue/Invoke；保存期间 Signal 只更新 value/disabled，完成后恢复，并验证幂等生命周期事件转发以及实际 Window 在 pending write 时处理 CloseRequested。typed `PERMISSION_DENIED` 在 dirty 状态下仍显示，原始 `NexaSystemError` 的 code/operation/context 同时进入诊断回调。
- 根 Window 自动承载 `defaultTheme`，也可用 `createTheme` 传入局部 semantic token override；Text/Card/Button/Input/TextArea 将 typed numeric style 写入真实 Host，组件 `style`/`labelStyle`/`textStyle` 可做最终覆盖。Theme Host trace 2/2 与 UI 8/8 通过，不存在 CSS string 或 selector 路径。
- `tools/reference-notes-build.test.mjs` 5/5 证明构建包装器传入受信 manifest、验证完整应用 startup marker、在漏嵌权限时 fail closed，并从所有生产 child process 清除 Dialog fixture 环境变量、拒绝受污染二进制。真实 `pnpm --filter @nexa/example-reference-notes build` 已完成 Perry AOT/link；主二进制实际启动并在观察窗口内保持运行。
- `pnpm --filter @nexa/example-reference-notes smoke:fs` 已用受信内嵌 manifest 启动 Perry 进程，在临时目录写入并读回多语种 UTF-8，经过 native worker、SystemCompletion 和 Promise continuation 后再由 Node runner 复核磁盘 bytes。
- `pnpm --filter @nexa/example-reference-notes smoke:clipboard` 使用同一受信内嵌 manifest，在 `Ready` 后经 native worker、SystemCompletion 与 Perry Promise 执行 read/write/read，并在原文本可读时恢复；runner `7/7` 要求精确 round-trip/restore proof。run `31902303937` 的 macOS/Windows package jobs `95054897243` / `95054897272` 完成真实 hosted runtime 执行。
- `pnpm --filter @nexa/example-reference-notes smoke:dialog` 以构建期注入 backend 启动真实 Perry/native System Host，完成 save 选择与写入、open 选择与读回、第二次 open 的 `null` cancel，并核对三个精确 controller snapshot；runner 正反合同 7/7。它证明 Dialog transport/Promise/controller 链路，不代表真实 OS picker。
- `pnpm --filter @nexa/example-reference-notes smoke:picker` 编译无 fixture 的独立 probe，二进制必须不含 fixture canary；runner 按 save/open/cancel 顺序驱动真实 OS picker，再验证磁盘 bytes 与版本化 controller snapshot。runner/driver 合同 24/24；本机 Accessibility 未授权路径仍准确 fail closed。run `31902303937` 的双平台 package jobs 完成真实 save/open/cancel，probe SHA-256 为 `f7cfab51cbaf4163bc82ae74854b07d5fcd8eb98219050fcb84e18e59c372172` / `e82079f1ee6b6afff7418b94a6299bb72835178f778918b036e80df8659e343a`。
- Notes 专用 `tools/reference-notes-package.mjs` 合同 6/6，通用 `packages/cli/src/package.mjs` package 合同 23/23、CLI 聚合 57/57 与真实 create-to-package smoke 通过；两套 packager 保持独立。run `31902303937` 的 build/archive jobs `95054897243` / `95054897272` 与 fresh download/validate/launch jobs `95059000291` / `95059000304` 在 macOS/Windows 全绿，launch 不 checkout、安装或调用开发工具链。

PR head `e56bb9e2c531e9cd3d97837465eca92d5e2c31dd` 触发 run `31902303937`，package/performance/artifact 执行实际绑定 Actions merge revision `991b28142783833c14be659125c4564d14219cc5`。直接平台 jobs 已关闭 G3B-05、G5-03、G5-04、G5-09 与 MVP-01；但 `collect_mvp_proof=false` 使 native/clean-package proof 上传被跳过，所以 N-10/N-11/MVP-02 仍等待 clean `refs/tags/v*` schema-v5 promotion。
