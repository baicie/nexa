# Nexa UI Quickstart

本教程面向 Desktop Technical Preview 的 Minimal TSX 主路径。Nexa UI 直接生成并运行原生桌面程序，不使用 WebView。

> 当前源码快照中的 9 个 Technical Preview npm 候选包（含 Tier-1 `@nexa/adapter-solid`）已配置为可发布，并已由本地九包 tarball consumer 完成安装、typecheck、Node ESM import、`doctor`、Perry AOT、Host 链接、打包和 evidence verify。它们尚未发布到 registry。从空目录执行下面的 clean-user 流程，前提是这些 package 已发布到或授权给你的 registry；仓库内测试通过不等于公开 registry 已可用。

## 环境要求

| 工具    | 要求       |
| ------- | ---------- |
| Node    | `>=22`     |
| pnpm    | `10.34.3`  |
| Perry   | `0.5.1220` |
| macOS   | arm64/x64  |
| Windows | x64        |

`nexa doctor` 会从当前项目声明并安装的依赖图检查这些版本、两套 Native Host 的 runtime/ABI，以及当前 target。它不会接受 PATH 中的全局 Perry 作为替代。

## 创建项目

Registry 可用后，在一个受控的空目录执行：

```bash
pnpm dlx @nexa/cli@0.1.0 new hello-nexa
cd hello-nexa
pnpm install
pnpm doctor
pnpm typecheck
```

`new` 不执行安装或网络请求。它创建以下固定结构：

```text
hello-nexa/
├── app.manifest.json
├── package.json
├── tsconfig.json
└── src/
    └── main.tsx
```

生成器拒绝绝对路径、父级穿越、符号链接、非空目标、Windows 保留名和不安全项目名。默认 manifest 的 `permissions` 为空。

## 编写界面

生成的 `src/main.tsx` 是可直接运行的最小应用：

```tsx
import { Button, Column, Text, Window, mount, signal } from "@nexa/ui";

function App() {
  const count = signal(0);

  return (
    <Window title="Hello Nexa">
      <Column width={360} padding={24} gap={16}>
        <Text fontSize={28}>Hello Nexa</Text>
        <Text>Count: {count}</Text>
        <Button onClick={() => count.value++}>Increment</Button>
      </Column>
    </Window>
  );
}

mount(App);
```

把 `signal` 本身或 `() => string` 作为文本 child，Host 会增量更新对应原生节点；不要为了显示响应式值提前读取 `.value`。

## 开发与构建

```bash
pnpm dev
pnpm build
pnpm package
```

- `dev` 使用项目本地 Perry watcher，并把临时 binary 放在 `.nexa/dev/`。
- `build` 校验并嵌入 `app.manifest.json`，输出 `dist/<package-name>[.exe]`。
- `package` 总是重新执行受信 build，再生成当前平台的 unsigned distribution；没有 skip-build 或跨平台打包选项。

具体目录布局、assets 限制和交付边界见[打包指南](./PACKAGING.md)。

## 使用系统能力

系统 API 默认拒绝。先在 `app.manifest.json` 中只加入实际需要的权限：

```bash
pnpm add @nexa/dialog@0.1.0 @nexa/fs@0.1.0
```

```json
{
  "$schema": "https://nexa-ui.dev/schema/app-manifest-v1.json",
  "schemaVersion": 1,
  "id": "dev.nexa.hello-nexa",
  "name": "Hello Nexa",
  "version": "0.1.0",
  "requiredProtocol": { "major": 1, "minor": 0 },
  "permissions": ["system.DialogOpen", "system.FsRead"]
}
```

然后启动并等待 typed Task：

```ts
import { openFile } from "@nexa/dialog";
import { readTextFile } from "@nexa/fs";

const pick = openFile({ title: "Open note" });
const selected = await pick.result;

if (selected !== null) {
  const read = readTextFile(selected);
  const text = await read.result;
  console.log(text);
}
```

用户关闭 picker 时结果为 `null`。`task.cancel()` 是幂等的；当前 native Dialog backend 只能停止结果交付并丢弃迟到结果，不能主动关闭已经显示的系统 picker。

## 在源码仓库验证

未配置授权 registry 时，可在本仓库验证现有工作区：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm workspace:validate
pnpm test
pnpm build
pnpm --filter @nexa/example-reference-notes typecheck
pnpm --filter @nexa/example-reference-notes build
```

这条路径证明 workspace 与参考应用，不证明外部用户能够从 registry 安装 SDK。当前支持范围与尚未关闭的平台门禁见[兼容性与已知限制](./COMPATIBILITY.md)。
