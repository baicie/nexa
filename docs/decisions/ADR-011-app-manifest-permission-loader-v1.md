# ADR-011: App Manifest 与 Permission Loader v1

- 状态：Accepted（Desktop Notes MVP）
- 日期：2026-08-07
- 依赖：ADR-005、ADR-007、ADR-010
- 实现任务：G4-04

## 背景

System Host 已有稳定的 Permission ID、`PERMISSION_DENIED` 错误和 Task/Error 边界，但旧实现仍以 `PermissionSet::default()` 自动放行剪贴板。该默认值无法证明应用声明了能力，也会让后续 FS/Dialog 调用在不同入口形成不同授权规则。

开发运行与发布产物还需要两种可信输入：开发期从项目文件读取 manifest，发布期从包内字节读取 manifest。两条路径如果使用不同解析或默认值，会使开发环境通过、发布环境却获得不同权限。

## 决策

### 1. 单一 JSON v1 合同

应用 manifest 使用严格 JSON，schema ID 固定为 `https://nexa-ui.dev/schema/app-manifest-v1.json`。v1 只包含启动和权限判断需要的字段：

```json
{
  "$schema": "https://nexa-ui.dev/schema/app-manifest-v1.json",
  "schemaVersion": 1,
  "id": "dev.nexa.notes",
  "name": "Nexa Notes",
  "version": "0.1.0",
  "requiredProtocol": { "major": 1, "minor": 0 },
  "permissions": ["system.ClipboardRead", "system.ClipboardWrite"]
}
```

- 顶层和嵌套对象拒绝未知字段。
- `id` 使用小写 reverse-DNS 风格；`version` 必须是 SemVer，v1 将 major/minor/patch 各限制为最多 18 位十进制数字，使 Schema 与 Rust 使用同一保守数值域。
- JSON `integer` 按数值而非词法形式判断，因此 `1`、`1.0` 和 `1e0` 等价；小数、负数和超过 `u32` 的值拒绝。
- `name` 必须包含至少一个非 JavaScript whitespace 的 Unicode scalar，拒绝 C0/C1 control、BOM-only 和未配对 UTF-16 surrogate。
- `requiredProtocol.major` 必须与 runtime 相同，minor 不得高于 runtime。
- `permissions` 只接受 System protocol 中 active 的完整名称，拒绝未知项和重复项。
- manifest 最大 64 KiB，避免启动边界无界分配。

Schema 负责编辑器、CI 与打包期 shape 校验；Rust loader 仍独立执行同样的安全关键语义校验，不能假设输入已经由 CLI 验证。共享 raw JSON fixture 同时驱动 Ajv 与 Rust，防止解析后的 JavaScript 值掩盖数字词法或 Unicode 差异。

### 2. 开发与发布共用解析器

提供两个可信宿主入口：

- development：从显式文件路径做有界读取；
- release：从打包器提供的内嵌字节做有界读取。

二者必须进入同一个 parser/validator，并产生同一个 `AppManifest`。不读取当前工作目录中的隐式默认文件，不在 release 路径回退到环境变量，也不因开发模式自动增加权限。

### 3. 默认拒绝与按命令授权

`PermissionSet::default()` 等价于 deny-all。授权集只能由已验证 `AppManifest` 构造。

调用方只能使用公开的 `require_command(CommandId)`，由 System Core 的穷尽 match 选择命令需要的权限；底层 `allows`/`require(permission, command)` 保持私有，不能由每个 FFI 函数自行传入一个可能错误的 Permission ID。active Permission ID/name 由单一 canonical table 驱动双向映射。无权限命令（例如 CancelTask）仍可执行。新增 Command 时，Rust 的穷尽匹配与 manifest drift test 必须同时更新。

### 4. 可信宿主只安装一次

System Host 的权限上下文在未配置时 fail closed。只有 Rust composition/launcher API 可以安装已验证 manifest，并且一个进程只能成功安装一次；TypeScript API 不暴露 grant、reload 或 manifest path。窗口或 session reset 不扩大也不清空 app 级权限。

OS 自身的授权仍是第二道门禁。App manifest 声明不代表 OS 已授权，后续 backend 必须把两类拒绝分别标记为 `PermissionSource::Manifest` 和 `PermissionSource::OperatingSystem`。

## 错误与可观测性

Loader 返回类型化错误，至少区分 I/O、超限、JSON/shape、schema URI/version、app identity/version、protocol 不兼容、未知权限和重复权限；错误不得 panic。System command 在 manifest 未安装或未声明能力时继续使用 ADR-007 的 `PERMISSION_DENIED`，context 中保留 command、permission 和 `source=manifest`。

## 验收

1. JSON Schema 接受 development/release fixtures，拒绝未知字段、重复/未知权限、非法 identity/version、未配对 surrogate 和非整数数值。
2. 两种 loader 对相同内容得到相同 manifest，并对所有失败输入 fail closed。
3. 默认 PermissionSet 不允许敏感命令；声明只开放对应命令；无权限命令不受影响。
4. schema、Rust canonical Permission table 和 System protocol active permission registry 做 exact-set 零漂移。
5. System Host 未配置时拒绝，安装后按声明授权，第二次安装不能扩大权限。

## 后果

- G4-05/G4-06 新增 FS/Dialog Permission 时，必须先扩展 System protocol registry、app schema enum 和 Rust 映射；drift test 会阻止只改一处。
- G5 CLI/packager 只负责选择 development 文件或 release 内嵌字节，不重新定义权限语义。
- 旧 Clipboard sentinel ABI 在 G4-07 前仍保留返回格式，但不再拥有默认授权旁路。

## 暂不实现

- 运行时弹窗申请或修改 manifest；
- path glob、目录 scope、网络 origin 等参数化权限；
- manifest 签名、插件声明和资源清单；
- 移动端 entitlement/Info.plist/Android Manifest 生成。
