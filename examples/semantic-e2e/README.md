# Semantic E2E Fixture

G3B-05 的 Minimal TSX fixture，覆盖 Button、Input 与 TextArea 的默认语义，以及按 Semantic role/name 执行 Focus、SetValue 和 Invoke 的无坐标工作流。

```bash
pnpm --filter @nexa/example-semantic-e2e start
```

自动场景位于 `scenario.json`。`native-smoke.yml` 先运行相同的 `g3b05_` AccessKit converter 与 Bridge Dispatcher harness，再运行 `semantic-accessibility-smoke`：macOS 使用 NSAccessibility，Windows 使用 UI Automation，均从真实平台树按 role/name 查询并操作生产 Adapter 暴露的控件，不使用屏幕坐标。
