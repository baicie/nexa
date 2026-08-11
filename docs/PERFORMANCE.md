# 性能基线与预算

本文件定义 G6-07 的可复现合同。预算配置位于
`release/performance-budgets.json`，确定性的校验器位于
`tools/performance-budget.mjs`，独立 hosted 边界位于
`.github/workflows/performance.yml`。

当前状态是 **预算合同与 native collector 本地实现完成、hosted 基线待采集**。
macOS 和 Windows 的所有 baseline 都显式为 `pending`，且不包含数值或 evidence。
本地 AOT smoke 只证明探针、进程驱动和 RSS 读取链路可运行，不能替代 hosted
原生证据，因此当前状态不能用于关闭 G6-07。

## Reference Workload

版本化 workload ID 是 `reference-notes-v1`，对象是同一 commit 构建的
unsigned Desktop Notes distribution。两个独立平台分别形成基线，禁止把
macOS 数值复制到 Windows，或把开发机数值提交为 hosted baseline。

一次正式采集必须满足以下条件：

1. 在 `macos-15` 的 `darwin-arm64` 或 `windows-2022` 的 `win32-x64`
   clean hosted runner 上构建 release artifact。
2. 先完成 3 次不入报告的 warmup，再完成 10 次独立进程运行。
3. cold start 使用 monotonic clock，从进程创建前一刻量到 Runtime
   `FrameOutcome::Presented` 的 first-present observation。`Ready` lifecycle、
   TS `console.log`、离屏 paint 或进程存活都不是 first-present。
4. first present 后不注入输入，等待 5 秒 settle window，再读取一次进程 RSS。
5. tick/layout/paint 只能来自 G2C-07 的 `FrameMetricsObserver` 真实阶段计时。
   `tickMs` 是同一 presented record 中所有 `FrameDurations` 的总和，
   `layoutMs` 和 `paintMs` 分别来自对应字段。
6. 至少提交 100 个成功 presented record 的 tick/layout/paint 样本。
   任一 failed run 或 dropped frame 都使整份报告无效，不能选择性删除慢样本。

Native probe 已接入真实 Notes Host/Perry AOT 进程，并已在本机完成 first-present、
无输入 redraw、5 秒 settle 和 RSS smoke；本机不能生成合格的 hosted native report。
hosted 缺口必须通过真实 first-present/RSS/FrameMetrics 集成关闭，不能用
`Date.now()` 循环、sleep 时长、测试 clock 或 fixture 常量补值。

## Native Event And Collector Contract

G6-07B 使用 opt-in Host 探针，不新增业务 API。只有
`NEXA_PERFORMANCE_CAPTURE_V1=1` 才启用；collector 设置
`NEXA_PERFORMANCE_FRAME_TARGET`，普通 Notes 进程不读取第二个变量。探针在真实
`buffer.present()` 成功并由 `FrameMetricsObserver` 完成记录后写出一行：

```text
NEXA_PERFORMANCE_EVENT {"schemaVersion":1,"kind":"frame",...}
```

payload 包含 `outcome`、可选 `dropStage`、session/tick/frame/surface generation、
完整 `counts` 和完整 `durationsNs`。Rust `u64/u128` 全部使用十进制字符串，collector
以 `BigInt` 解析，避免 JavaScript safe-integer 截断。duration 是
`Duration::as_nanos()`；collector 只把 `outcome=presented` 的完整原始记录换算为
毫秒，`tickMs` 必须对同一记录的所有阶段求和。stdout 写出位于 record 完成之后，
不属于被报告阶段。

collector 必须：

1. 从预算配置读取 warmup/measured 数量和最小 frame 样本，不允许 CLI 降低它们。
2. 用 parent `performance.now()` 在 spawn 前取起点，第一条 native presented event
   到达时结束 cold-start 测量。
3. 只通过无输入 coalesced redraw 达到每进程 frame 目标，随后停止重绘；从 first
   present 起至少等待 5 秒，再读取目标 PID 的 RSS。
4. 在 macOS 使用无 shell 的 `ps` 参数读取 KiB，在 Windows 使用无 profile 的
   PowerShell `Get-Process ... WorkingSet64`；解析失败、进程消失或非正整数均失败。
5. 取得 measured run 的 RSS 和足量 frame 后终止专用子进程。collector 发起的终止
   是采样生命周期的一部分；在此之前的异常退出属于 failed run。
6. 验证 hosted 环境、实际 OS/arch、runner image 和与 `GITHUB_SHA` 完全相等的
   commit，并记录 artifact regular-file bytes 与主可执行文件 SHA-256；采集前后
   identity 必须一致，presented frame 的 session/frame identity 必须稳定递增。

任何 warmup 失败都直接中止；任何 measured timeout、malformed native event、drop、
缺失样本、RSS 失败或异常提前退出都不生成报告。collector 不删除慢样本、不激活
baseline，也不发布或签名制品。

## Metrics

| Metric          | Collection               | Statistic | 当前回归阈值 | 定义                                        |
| --------------- | ------------------------ | --------- | ------------ | ------------------------------------------- |
| `coldStartMs`   | `hosted-native`          | median    | +20%         | process spawn 到 first present              |
| `idleRssBytes`  | `hosted-native`          | median    | +20%         | first present 后 idle 5 秒的 resident set   |
| `artifactBytes` | `deterministic-artifact` | max       | +5%          | unsigned distribution 内 regular files 之和 |
| `tickMs`        | `hosted-native`          | p95       | +15%         | presented record 的全部真实阶段耗时之和     |
| `layoutMs`      | `hosted-native`          | p95       | +15%         | Runtime Layout 阶段                         |
| `paintMs`       | `hosted-native`          | p95       | +15%         | Runtime Paint 阶段                          |

`artifactBytes` 按路径排序递归计数 regular-file bytes，不跟随 symbolic link，
遇到 link 或 special file 直接失败。它可以在本地确定性复核，但只有与 hosted
native report 同 commit、同 clean artifact 的结果才能激活 release baseline。

median 对偶数样本取中间两个值的平均数；p95 使用 nearest-rank；max 取最大值。
active budget 的上限计算为：

```text
limit = baseline * (1 + maxRegressionPercent / 100)
```

## Report Contract

校验器消费完整 raw sample report，而不是预先计算的 summary。下面只是字段结构，
占位符不是基线证据：

```jsonc
{
  "schemaVersion": 1,
  "workload": "reference-notes-v1",
  "platform": "darwin-arm64",
  "commit": "<40-character lowercase commit SHA>",
  "capturedAt": "<ISO-8601 timestamp>",
  "runner": {
    "provider": "github-actions",
    "image": "macos-15",
    "hosted": true,
  },
  "artifact": {
    "name": "reference-notes-macos-arm64",
    "executable": "Nexa Notes.app/Contents/MacOS/NexaNotes",
    "executableSha256": "<64-character lowercase sha256>",
  },
  "quality": {
    "failedRuns": 0,
    "droppedFrames": 0,
  },
  "samples": {
    "coldStartMs": ["<10 or more raw numbers>"],
    "idleRssBytes": ["<10 or more raw numbers>"],
    "artifactBytes": ["<one or more raw numbers>"],
    "tickMs": ["<100 or more raw numbers>"],
    "layoutMs": ["<100 or more raw numbers>"],
    "paintMs": ["<100 or more raw numbers>"],
  },
}
```

报告必须包含全部六项。Native 指标出现于 `hosted: false`、runner image 与平台
不匹配、样本不足、数值非有限或为负、failed run 非零、dropped frame 非零时，
校验器都会 fail closed。

生产入口还冻结采样政策：3 次 warmup、10 次 measured；cold start/RSS 各至少 10
条样本，artifact 至少 1 条，tick/layout/paint 各至少 100 条。单元合同可以使用
更小的 fixture，但 `validate`、`status`、artifact CLI 和 native collector 对生产
配置拒绝弱化后的采样数。active baseline 的 evidence report 必须是仓库相对路径，
每一级父目录和最终文件都必须是非 symlink 的 regular file；校验器会重新读取 raw
report，绑定 workload、platform、commit、capturedAt，并重新计算对应 statistic
后才接受 `baseline.value`。

## Commands

验证配置及查看当前 baseline 状态：

```bash
node tools/performance-budget.mjs validate
node tools/performance-budget.mjs status --platform darwin-arm64
node tools/performance-budget.mjs status --platform win32-x64
```

确定性测量一个已存在 artifact 的 regular-file bytes：

```bash
node tools/performance-budget.mjs artifact \
  --path dist/reference-notes-macos-arm64 \
  --platform darwin-arm64 \
  --output /tmp/nexa-artifact-darwin-arm64.json
```

在 GitHub-hosted runner 上生成完整候选报告：

```bash
node tools/performance-collector.mjs \
  --binary "dist/reference-notes-macos-arm64/Nexa Notes.app/Contents/MacOS/NexaNotes" \
  --artifact dist/reference-notes-macos-arm64 \
  --platform darwin-arm64 \
  --runner-image macos-15 \
  --commit "$GITHUB_SHA" \
  --output "$RUNNER_TEMP/nexa-performance-darwin-arm64.json"
```

校验完整 hosted report：

```bash
node tools/performance-budget.mjs check \
  --report /path/to/hosted-report.json \
  --json
```

退出码为 `0`（全部 active budget 通过）、`1`（合同错误或性能回归）、
`2`（报告有效但仍存在 pending baseline）。`--allow-pending` 只用于审阅首轮
candidate，不能用于 release gate。`status --require-active` 用于 rehearsal，
任一 pending baseline 都返回 `2`。

## Baseline Activation

激活 baseline 必须经过以下审阅步骤：

1. 在两个 hosted runner 上分别生成同一 source commit 的完整 raw report。
2. 保留原始报告并记录其仓库相对路径、commit 和 capture timestamp。
3. 复核 workload、runner image、artifact identity、warmup/sample counts 和
   `quality`，不得人工删除 outlier。
4. 将对应 baseline 从 `pending` 改为 `active`，`value` 使用校验器所定义统计量，
   `evidence` 同时写入 report path、40 字符 commit 和 ISO timestamp。
5. 对两个报告运行 `check`，再对两个平台运行 `status --require-active`。

任何 workload、采样方法、runner image 或 metric 含义变化都必须先递增 schema
或 workload ID，并重新建立 baseline。旧平台 baseline 不可跨边界复用。

## Workflow Boundary

`performance.yml` 通过手动触发或每周 schedule 运行，不接入当前 PR `ci.yml`。
它固定 Node 22 和 Action SHA，在 `macos-15` / `windows-2022` 上先运行
`pnpm release:build` 物化 Native Host 输入，再构建 Notes candidate，拆开 native
capture 与 budget check，并在 check 回归时仍上传完整 raw report。默认状态命令
准确报告 pending；手动选择 `require_active` 后，未完成 baseline 会 fail closed。

该 workflow 当前没有伪装成 native benchmark：它不会把编译成功、启动存活、
startup smoke、测试 fixture 或 artifact byte count 填入 cold start、RSS、tick、
layout、paint。正式 release rehearsal 必须等真实 hosted collector 和 active
baseline 都进入同一流程后再依赖此门禁。

## Local Implementation Evidence

2026-08-09 本地证据（不激活 baseline）：

- `pnpm --filter @nexa/nui-host build` 刷新 Perry Native source closure；随后
  `pnpm --filter @nexa/example-reference-notes build` 重新 AOT/link Notes，binary
  marker 包含 `NEXA_PERFORMANCE_CAPTURE_V1` 与 `NEXA_PERFORMANCE_EVENT`，startup
  smoke 成功。
- 相对路径入口的真实 warmup 为 3/3 `Presented`、0 drop，first-present
  `2605.618ms`；真实 measured 为 10/10 `Presented`、0 drop，first-present
  `1188.724ms`，5 秒 settle 后 macOS RSS `71925760` bytes。样本只作为本地
  integration smoke，不写入 `release/performance-budgets.json`。
- `node --test tools/performance-budget.test.mjs tools/performance-collector.test.mjs`
  通过 `27/27`；`cargo test --manifest-path packages/nui-host/Cargo.toml --locked
performance` 通过 `3/3`。测试覆盖 commit/GITHUB_SHA、artifact 前后 identity、
  duplicate frame/count consistency、relative executable、RSS timeout、TERM→SIGKILL
  和 workflow capture/check/upload 顺序。
