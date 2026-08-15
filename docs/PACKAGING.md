# Packaging Guide

`nexa package` 把 conventional Minimal TSX 项目构建为当前平台的 unsigned distribution。它面向 Desktop Technical Preview，不提供交叉打包、签名、公证、installer、MSIX、archive 或发布。

## 输入合同

命令固定读取项目根目录中的：

```text
package.json
app.manifest.json
src/main.tsx
assets/                 # 可选
```

`package.json`、manifest 与 Perry/Host 版本必须通过 `nexa doctor`/build 合同。manifest 上限为 64 KiB，必须符合 schema v1，permission 只能取自已知枚举。

## 执行命令

```bash
pnpm doctor
pnpm typecheck
pnpm package
```

`package` 没有 skip-build。它先调用与 `nexa build` 相同的受信路径：

1. 从当前项目已声明并安装的依赖图解析精确 Perry。
2. 清除 manifest、Dialog fixture 与 codegen bypass 环境变量。
3. 注入已验证 manifest 的绝对路径并执行 Perry compile。
4. 只接受精确目标位置的 regular binary。
5. 验证 binary 内嵌的 manifest bytes 完全一致，且不含 Dialog fixture canary。

任一步失败都不会发布新的 package destination。

## 产物布局

macOS：

```text
dist/<name>-macos-<arch>/
└── <name>.app/
    └── Contents/
        ├── Info.plist
        ├── MacOS/<name>
        └── Resources/
            ├── app.manifest.json
            ├── nexa-build.json
            └── assets/              # 可选
```

Windows：

```text
dist/<name>-windows-x64/
├── <name>.exe
├── app.manifest.json
├── nexa-build.json
└── assets/                          # 可选
```

`nexa-build.json` 记录应用 identity、Protocol、target、兼容工具链版本和 asset 统计。产物不包含 `node_modules`、Cargo `target`、源码、`.nexa` 或全局工具目录；Perry 已把 Native Host 静态链接进 executable。

## Assets

项目根的可选 `assets/` 保留相对目录结构，并受以下硬限制：

| 限制   | 值      |
| ------ | ------- |
| 文件数 | 4,096   |
| 单文件 | 64 MiB  |
| 总大小 | 256 MiB |

Symlink 和非 regular entry 会被拒绝。Packager 在读取前后复核文件与目录 identity，以阻断可检测的 relink/replace 竞态；项目根和 `dist/` 仍必须由调用者控制。

## 发布原子性

内容先写入项目根下唯一的 `.nexa-package-*` staging directory，全部验证后才排他占位最终 destination。

- macOS 把完整 `.app` 单次移入 reservation。
- Windows 依次移动 executable、manifest、可选 assets，最后移动 `nexa-build.json` 作为完成标记。
- 可捕获失败会按 reservation identity 回滚；cleanup 失败不会遮蔽原始错误。
- 已存在的 destination 永远不会被覆盖。

进程被强制终止时，Windows 可能留下没有 `nexa-build.json` 的不完整 reservation；重试会拒绝覆盖，需先由操作者审计后显式删除。

## 启动

macOS 可直接启动 bundle：

```bash
open "dist/<name>-macos-<arch>/<name>.app"
```

Windows 从分发目录启动：

```powershell
& "dist\<name>-windows-x64\<name>.exe"
```

产物 unsigned。系统安全策略可能要求开发者在本机显式允许；这不等于签名或公证流程已经交付。

## CI 与证据边界

仓库 workflow 把 build/archive/upload 与 fresh download/validate/launch 分成两个 job。fresh job 不 checkout、安装工具链或重新构建，而是重新校验 manifest、metadata、target、version、assets 和 macOS plist 后启动 executable。

Workflow 配置和本地 contract 只证明路径会 fail closed。run `31902303937` 已绑定 source revision `e56bb9e2c531e9cd3d97837465eca92d5e2c31dd`，在 macOS/Windows 完成 build/archive 与 fresh download/validate/launch，并记录 artifact digest，因而关闭 G5-09/MVP-01。该 PR run 不是 clean tag，不关闭 MVP-02、签名或发布门禁。
