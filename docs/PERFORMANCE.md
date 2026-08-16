# 性能基线与预算

本文件定义 G6-07 的可复现合同。预算配置位于
`release/performance-budgets.json`，确定性的校验器位于
`tools/performance-budget.mjs`，独立 hosted 边界位于
`.github/workflows/performance.yml`。

当前状态是 **双平台 hosted baseline 已评审并激活**。macOS 与 Windows 的 12 个
baseline 全部由同一 PR merge execution revision 的完整 raw report 支撑；配置校验会
逐项回读报告并重新计算统计量。后续 workflow 必须以 `require_active` 运行并将新采样
与这些基线比较，本地 AOT smoke 仍不能替代 hosted 原生证据。

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
该 hosted 缺口已由真实 first-present/RSS/FrameMetrics 集成关闭；任何后续重建仍不能用
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

本次激活证据来自 GitHub Actions run `31895582357`，source branch HEAD 为
`ecd1d9c90ecf5844223417ee118fd5292b556b4d`，PR merge execution revision 为
`892e1cede80762f791564302c86b8afa42157575`。两份报告都记录 `failedRuns=0`、
`droppedFrames=0`，样本数均为 `10/10/1/100/100/100`，且保留全部原始值：

| Platform       |       cold start median | idle RSS median | artifact max |       tick p95 |    layout p95 |      paint p95 | Raw report                                                                       |
| -------------- | ----------------------: | --------------: | -----------: | -------------: | ------------: | -------------: | -------------------------------------------------------------------------------- |
| `darwin-arm64` |  `608.5209584999975 ms` |   `593264640 B` | `27159082 B` | `49.259417 ms` | `3.543917 ms` | `47.430083 ms` | `release/performance/892e1cede80762f791564302c86b8afa42157575/darwin-arm64.json` |
| `win32-x64`    | `121.81270000000222 ms` |   `154607616 B` | `18527300 B` |   `12.3759 ms` |   `0.3558 ms` |   `11.6221 ms` | `release/performance/892e1cede80762f791564302c86b8afa42157575/win32-x64.json`    |

对应 performance jobs `95038387701` / `95038387744` 的 build、capture、check、upload
均成功。macOS artifact `9249896280` 的 GitHub digest 是
`sha256:17032edfea57be564ead320963f90ccfa7e90ee21088440d9bd546022c77dc94`，
raw JSON SHA-256 是 `afed702a8e53fb488516db84eb86bb25dbde4e82b5841d7435a4b498fa9e7680`；
Windows artifact `9250044203` 的 GitHub digest 是
`sha256:f657480ead9276d1f4aabf67fcc18b4c1173b32ec4402ff58835f7014b191671`，
raw JSON SHA-256 是 `050efdbdacb8df13c2a5f04fc6c18633a704f7410f4718723993710357842dc3`。
该 run 的无关 Windows picker proof 后处理失败不改变两个独立 performance jobs 或
报告身份；G5 picker/package 随后已由全绿 run `31902303937` 单独闭环。

## Active Baseline Regression Evidence

PR run `31902303937` 以 `performance-required` 重新采集两平台完整报告并对
已激活 baseline 执行回归检查。GitHub run metadata 的 source head 为
`e56bb9e2c531e9cd3d97837465eca92d5e2c31dd`；报告和 artifacts 实际绑定
Actions merge execution revision
`991b28142783833c14be659125c4564d14219cc5`。两者不得混用。

- macOS job `95054917085` 成功；artifact `9251609127` GitHub digest 为
  `sha256:c30fe9ca3c10db17244f3154d9bd3597b568aff2cb44590cb1c74e9a61117654`，
  raw JSON SHA-256 为
  `19cf2e01ede6ef3b12da2e6ad748b261ce46f2a478c55b7d21abac7049684d99`。
- Windows job `95054917056` 成功；artifact `9251738405` GitHub digest 为
  `sha256:11877dd46e9a2bf964690156a31a30a4f394795284981aa302d2075badd82d4b`，
  raw JSON SHA-256 为
  `7f8d4598578a31796ef0fe44fe376de8c857a293b7bdbd0d0204ef23b088f8d9`。
- 同一 run 的 `CI / result` job `95059146281` 成功；本次 workflow 变更进一步将
  `performance-required` 显式加入 aggregator 的 `needs` 与 fail-closed 判断。

两个 budget check 均未发现超过 active 阈值的回归。本次记录是对现有 baseline
的复核，不改写原始 activation provenance，也不是签名、clean-tag rehearsal
或发布证据。

## Workflow Boundary

`performance.yml` 可通过手动触发、每周 schedule 或 reusable workflow 运行；PR
只有显式添加 `performance-capture`、`performance-required` 或
`release-rehearsal-required` label 才由 `ci.yml` 调用，避免普通变更承担双平台长任务。
rehearsal label 固定要求 active baseline，并把这个同 revision job 的结果传给
candidate rehearsal，避免在两个独立 hosted VM 上重复采样同一个性能 gate。手动与
tag rehearsal 没有 caller result，因此仍自行调用 performance workflow。它固定 Node 22 和 Action SHA，在
`macos-15` / `windows-2022` 上先运行
`pnpm release:build` 物化 Native Host 输入，再构建 Notes candidate，拆开 native
capture 与 budget check，并在 check 回归时仍上传完整 raw report。`require_active`
或 `performance-required` 会在采集前验证两个平台没有 pending baseline。

该 workflow 当前没有伪装成 native benchmark：它不会把编译成功、启动存活、
startup smoke、测试 fixture 或 artifact byte count 填入 cold start、RSS、tick、
layout、paint。release rehearsal 复用同一 workflow，并固定要求 active baseline；复用
的是完整 gate result，不改变阈值、统计量、样本数或 pending-baseline 的 fail-closed 语义。

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
