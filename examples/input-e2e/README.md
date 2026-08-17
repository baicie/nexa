# Input E2E Fixture

G3A-11 的 Minimal TSX fixture，覆盖单行/多行 composition 状态、CJK、Emoji ZWJ、combining text 与编辑器剪贴板快捷键。

```bash
pnpm --filter @nexa/example-input-e2e start
```

自动场景数据位于 `scenario.json`。`native-smoke.yml` 在 macOS 与 Windows 上运行同一组 `g3a11_` Rust harness；剪贴板步骤使用内存 backend，不读取或修改 runner 的真实剪贴板。
