# ADR-010: Desktop Notes MVP 范围与退出门禁

- 状态：Accepted（MVP 实施目标）
- 日期：2026-08-05
- 依赖：ADR-004、ADR-006、ADR-007、ADR-009
- 后续目标：Desktop Technical Preview

## 背景

仓库中已有两个容易混淆的目标：

1. ADR-004 的“最快可见 MVP”已经完成，证明 Perry、Host、Rust Core、Skia 与多框架 Counter 可行。
2. `PROJECT-DESIGN.md` 和 `ROADMAP.md` 的 G0-G6 实际描述完整 Desktop Technical Preview，包括 SDK 发布、签名、供应链、性能预算和外部 Adapter 支持。

如果继续把两者都简称为 MVP，任务优先级会在“先证明真实应用闭环”和“先完成公开发布治理”之间摇摆。项目需要一个介于技术可行性验证与 Technical Preview 之间、可以自动验收的产品里程碑。

## 决策

当前实现目标定义为 **Desktop Notes MVP**：使用 Minimal TSX 构建一个单窗口、本地文件型 Notes 应用，在 macOS 与 Windows 上证明输入、无障碍、异步系统能力和窗口生命周期形成同一条端到端链路。

### MVP 必须包含

- G2 退出门禁真实闭环：多语言 golden/property 测试、Surface suspend 资源释放、close 指标收尾和跨 session 可观测性。
- 标题单行编辑与正文多行编辑：选择、caret、中文 IME preedit/commit/cancel、Emoji/grapheme 安全操作。
- Button、Text、Input/TextArea 的稳定语义树与 AccessKit 桥，可读、可聚焦、可执行适用 action。
- generation Task、取消、owner close、结构化错误、权限 manifest、文本文件打开和原子保存。
- suspend/resume 后保留文档状态并完整重绘；close 取消未完成任务并失效所属资源。
- Minimal TSX Notes 参考应用及其语义驱动 E2E。
- CI 在 macOS 与 Windows 生成不依赖仓库源码、Node 或 Rust 的 unsigned 可运行产物。

### MVP 不包含

- 把多个外部框架提升为 Desktop Notes MVP 的必需产品路径。Technical Preview 已单独选定 Solid 为唯一 Tier-1 公开 Adapter，并以 Notes 核心切片验证；这不改变 Minimal TSX 是本 MVP 的唯一路径。
- 公开 npm/crate 发布、签名、公证、SBOM/provenance、自动更新和正式 release channel。
- 完整 CLI onboarding、完整 Inspector、完整设计系统、动画、GPU backend、多窗口、Linux Tier-1 或移动端。
- 富文本、云同步、协作、数据库、最近文件列表和崩溃恢复。

## 关键验收旅程

```text
启动 Notes
  -> 创建空白文档
  -> 使用中文 IME 与 Emoji 编辑标题/正文
  -> 通过语义树聚焦并操作保存按钮
  -> 打开或保存本地 UTF-8 文本
  -> suspend/resume 后内容与焦点合同保持有效
  -> close 取消未完成操作且无迟到回调
  -> unsigned 产物在 clean macOS/Windows 环境启动
```

任一步骤失败都表示 MVP 未完成；Counter、单元测试数量或接口骨架不能替代该旅程。

## 路线图映射

2026-08-06 实施修订：不改变本 ADR 的产品范围，只把原先过粗的 M1..M4 拆成与 `MVP.md`、`ROADMAP.md`、`TODO.md` 一致的可验证里程碑；以下映射取代最初的阶段编号。

- **M0 - G2 hardening**：G2B-09、metrics 与 Surface/close 生命周期门禁。
- **M1 - Editing core**：G3A-01..05、07。
- **M2 - IME + multiline**：G3A-06、08..11。
- **M3 - A11y + Task**：G3B 与 G4-01..04；两条依赖线可在协议冻结后并行。
- **M4 - Files + Notes**：G4-05..08 与 G5-01..04。
- **M5 - Package**：MVP 所需最小 packager、macOS/Windows unsigned artifact 与最终矩阵。
- **MVP Gate**：双平台 E2E、unsigned artifact、文档和关闭/恢复证据。
- **Technical Preview**：其余 G5 开发者体验与全部 G6 发布治理。

## 后果

- Minimal TSX 是 MVP 唯一产品路径，避免同时调试多个框架的编辑、A11y 和系统 API。
- G3/G4 仍按共享协议设计，未来 Adapter 可以复用，但不阻塞 MVP。
- G2 文档勾选不能盖过生命周期审查；退出门禁必须以新测试和当前 commit 的验证证据为准。
- Technical Preview 的范围没有删除，只是被明确放在 Notes MVP 之后。

## 复议条件

出现以下任一情况时新增 ADR 复议，不在实现中静默扩大范围：

- 产品不再采用本地 Notes 作为 north-star 场景；
- 首发平台不再是 macOS + Windows；
- Minimal TSX 不再是第一公共路径；
- MVP 必须包含签名发布或外部框架完整 parity；
- Perry/FFI 无法支持 G3/G4 所需的稳定协议。
