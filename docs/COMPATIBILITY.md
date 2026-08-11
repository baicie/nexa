# Compatibility And Known Limitations

本页描述当前 Desktop Technical Preview 的实际兼容边界，不代表稳定版承诺。

## 工具链

| Component           | Version/Range |
| ------------------- | ------------- |
| `@nexa/cli`         | `0.1.0`       |
| Node                | `>=22`        |
| pnpm                | `10.34.3`     |
| Perry               | `0.5.1220`    |
| TypeScript          | `5.9.2`       |
| Protocol            | `1.0.0`       |
| `@nexa/ui`          | `0.1.0`       |
| Native Host runtime | `0.1.0`       |
| Perry Host ABI      | `0.5`         |

这些值由 `packages/cli/src/constants.mjs` 提供，并由 CLI 合同绑定根 package、Protocol 与两套 Host manifest。`nexa doctor` 是项目内的运行时检查入口。

## 平台

| Target          | Build/package   | 当前证据与状态                                             |
| --------------- | --------------- | ---------------------------------------------------------- |
| `darwin/arm64`  | 支持            | 本地 AOT、package、launch 已通过；hosted 最终门禁未闭合    |
| `darwin/x64`    | 支持            | CLI target 已实现；当前 `macos-15` matrix 不证明 x64       |
| `win32/x64`     | 支持            | CLI target/workflow 已实现；hosted runtime 门禁未闭合      |
| Linux           | 非 Preview gate | 部分 Rust/字体代码可编译，不提供 Technical Preview package |
| iOS/Android/Web | 不支持          | 不在当前范围                                               |

不支持从一个 target 交叉打包另一个 target。

## UI 与框架

| Surface     | 等级               | 说明                                                                       |
| ----------- | ------------------ | -------------------------------------------------------------------------- |
| Minimal TSX | 参考路径           | Notes MVP、教程、CLI 模板与主验收路径                                      |
| Solid       | 唯一 Tier-1 public | Solid Notes 核心切片、语义 E2E、生命周期释放和公开 dist/JSX exports 已覆盖 |
| Vue 3       | Private candidate  | Custom renderer 与 Counter 已覆盖，不是公开或 Tier-1 承诺                  |
| React       | Private candidate  | 锁定 reconciler 的 Counter/AOT 路径，不是公开或 Tier-1 承诺                |
| Svelte      | Private subset     | Counter 子集 runtime，不是完整 Svelte surface或公开包                      |

完整 CSS、DOM、WebView、浏览器 API、路由、动画系统和网络 Image 不属于当前 surface。样式是 typed numeric Host properties。

## System API 限制

- Manifest 默认 deny-all；FS、Dialog、Clipboard 必须分别声明权限。
- FS 只处理 UTF-8 text；binary IO、目录 API 和 watcher 尚未公开。
- Clipboard 当前只提供 text read/write。
- Dialog native backend 基于同步 `rfd::FileDialog`。它只能观察 selected path 或 `None` cancel，没有真实 `PLATFORM_FAILURE` 返回分支。
- Dialog worker 不消费 cancellation token。Task cancel 或 owner close 会终止 Promise 交付并丢弃迟到 completion，但不能主动关闭已经显示的系统 picker。

## A11y 与输入

- Minimal TSX 已有共享 Semantic Tree、AccessKit backend、Focus/SetValue/Invoke 和 macOS 本机 NSAccessibility client 证据。
- Windows UI Automation client 已实现并通过目标编译/Clippy，但尚无绑定当前 commit 的 Windows hosted runtime 成功记录。
- Input/TextArea 覆盖 UTF-16 selection、CJK/Emoji/combining composition、候选 bounds、多行选择和 clipboard shortcut 合同；最终双平台 Notes journey 仍依赖 hosted gate。

## 分发限制

- 只生成 unsigned macOS `.app` 与 Windows distribution directory。
- 当前产品命令不交付 signed artifact、installer/MSIX、auto-update、archive 产品命令或 registry publish。G6-06 reviewed signing executor 已在本地实现并由 SHA-256 policy 绑定，但 execution/credential activation 仍 disabled，owner/protected Environment/真实凭据和双平台 hosted staging 证据尚未完成。
- 9 个 Technical Preview npm 候选包的 manifest 已可发布，本地真实 tarball consumer 已完成九包安装、typecheck、Node ESM import、doctor、Perry AOT、Host 链接、package 和 evidence verify；`@nexa/adapter-solid` 的 manifest/exports 与 Solid Notes E2E 也单独通过。尚未执行 registry publish，外部 clean-user install 仍无法完成。
- Workflow 已配置双平台 build/upload 与 fresh download/launch，但配置不等于 hosted success。G5-09/MVP-01 仍需绑定当前 commit 的双平台成功证据。

## 当前未关闭门禁

1. Windows UI Automation client 在 hosted graphical session 中真实成功。
2. macOS/Windows 无 fixture picker 的 save/open/cancel 与 Promise journey 成功，并记录 probe digest。
3. 双平台 artifact 在 fresh hosted job 中下载、复核并启动成功。
4. 精确 Node 22 的最终 TypeScript/Rust/FFI/Perry/docs/native/package required checks 全绿。
5. 绑定同一 revision 的 hosted npm registry audit、三份 Cargo lock audit/deny、license policy 与 gitleaks 成功记录。
6. macOS/Windows hosted raw performance report 经评审后激活 baseline，六项预算全部通过。
7. 授权或公开 registry 的 external clean install/create-to-package，并验证九包 metadata、integrity 与 lockfile。
8. 签名 owner、protected Environments 与凭据激活完成，并取得双平台 hosted signed staging、fresh verify 和 launch 证据。
9. clean tag rehearsal 汇总全部外部 evidence、fresh verify/launch/rollback；随后才可执行 registry channel promotion、七资产 GitHub prerelease 和 publication record。

本地 deterministic backend、静态 workflow 合同、AOT 成功、pending readiness
或 Accessibility 未授权时的 fail-closed 结果都不能替代上述 hosted、registry、
credential 或 publication 证据。

`pnpm release:preflight` 会一次列出当前 source/tag、八个 release gate、签名
owner/credential 和双平台性能 baseline 状态。它是只读诊断；当前返回阻断退出码
`1` 是准确状态，不是 Technical Preview 已发布的证据。
