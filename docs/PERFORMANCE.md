# 性能基线与预算

本文件定义 G6-07 的可复现合同。预算配置位于
`release/performance-budgets.json`，确定性的校验器位于
`tools/performance-budget.mjs`，独立 hosted 边界位于
`.github/workflows/performance.yml`。

当前状态是 **`reference-notes-v3` 双平台 baseline active**。PR capture run
`31991801398` attempt 1 已用每平台一份共享候选制品、3 个独立
GitHub-hosted replica，以及绑定 3 份 raw report 真实字节的 report set 完成
采集、评审、归档和激活。v1/v2 已评审 raw report 继续作为历史证据保留，
但不能跨 workload 或采样语义复用；本地 AOT smoke 仍不能替代 hosted
原生证据。G6-07P 仍等待 baseline active 状态下的新 `performance-required`
hosted run。

## Reference Workload

版本化 workload ID 是 `reference-notes-v3`，对象是同一 execution commit
构建的 unsigned Desktop Notes distribution。两个独立平台分别形成基线，
禁止把 macOS 数值复制到 Windows，或把开发机数值提交为 hosted
baseline。

一次正式采集必须满足以下条件：

1. 在 `macos-15` 的 `darwin-arm64` 或 `windows-2022` 的 `win32-x64`
   clean hosted producer 上只构建一次 release artifact，生成确定的 tar，再把同一份
   archive 交给该平台 3 个独立 hosted capture replica。
2. 每个 replica 先完成 3 次不入报告的 warmup，再完成 10 次独立
   measured 进程运行。每个 measured 进程固定采集 1 个 startup present
   和随后 100 个 steady-state present。
3. cold start 使用 monotonic clock，从进程创建前一刻量到 Runtime
   `FrameOutcome::Presented` 的 first-present observation。`Ready` lifecycle、
   TS `console.log`、离屏 paint 或进程存活都不是 first-present。
4. first present 固定归入 startup 边界，不进入 steady-state p95；该帧无论快慢都按
   位置分类，不能按数值选择。first present 后不注入输入，等待 5 秒 settle window，
   再读取一次进程 RSS。
5. tick/layout/paint 只能来自 first present 之后 G2C-07 的
   `FrameMetricsObserver` 真实阶段计时。
   `tickMs` 是同一 presented record 中所有 `FrameDurations` 的总和，
   `layoutMs` 和 `paintMs` 分别来自对应字段。
6. 每个 replica 精确提交 1000 个成功 steady-state presented record 的
   tick/layout/paint 样本。startup 及 steady-state 中任一 failed run 或
   dropped frame 都使整份报告无效；除固定的首个 startup present 外，
   不能删除任何慢样本。
7. 3 个 replica 必须共享 workload/platform/commit/run ID/attempt 和完整
   artifact identity，但 replica 编号必须精确为 `1/2/3`。只有 3 份都完整时
   才能聚合 report set，单份 runner report 不能作为生产预算门禁。

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

1. 从预算配置读取 warmup/measured/replica 数量、每进程 startup present
   数和精确 steady frame 数，不允许 CLI 降低它们。
2. 用 parent `performance.now()` 在 spawn 前取起点，第一条 native presented event
   到达时结束 cold-start 测量。
3. 只通过无输入 coalesced redraw 达到每进程 frame 目标。measured 目标固定为
   `1 startup + ceil(minimumSamples / measuredRuns) steady-state`；达到目标后停止重绘，
   并从 first present 起至少等待 5 秒，再读取目标 PID 的 RSS。
4. 在 macOS 使用无 shell 的 `ps` 参数读取 KiB，在 Windows 使用无 profile 的
   PowerShell `Get-Process ... WorkingSet64`；解析失败、进程消失或非正整数均失败。
5. 取得 measured run 的 RSS 和足量 frame 后终止专用子进程。collector 发起的终止
   是采样生命周期的一部分；在此之前的异常退出属于 failed run。
6. 验证 hosted 环境、实际 OS/arch、runner image、`GITHUB_RUN_ID`、
   `GITHUB_RUN_ATTEMPT` 和与 `GITHUB_SHA` 完全相等的 commit。run ID 必须是
   规范正十进制字符串，attempt 必须是正整数。
7. 记录 archive SHA-256、artifact regular-file bytes、排序文件树 SHA-256
   和主可执行文件 SHA-256。同一平台三份 raw report 的完整 artifact
   identity 必须一致；采集前后 identity 必须一致，presented frame 的
   session/frame identity 必须稳定递增。

任何 warmup 失败都直接中止；任何 measured timeout、malformed native event、drop、
缺失样本、RSS 失败或异常提前退出都不生成报告。collector 不删除慢样本、不激活
baseline，也不发布或签名制品。

## Metrics

| Metric          | Collection               | Runner statistic      | 当前回归阈值 | 定义                                        |
| --------------- | ------------------------ | --------------------- | ------------ | ------------------------------------------- |
| `coldStartMs`   | `hosted-native`          | median                | +20%         | 10 进程的 spawn 到 first present            |
| `idleRssBytes`  | `hosted-native`          | median                | +20%         | 10 进程 first present 后 idle 5 秒的 RSS    |
| `artifactBytes` | `deterministic-artifact` | max (shared artifact) | +5%          | unsigned distribution 内 regular files 之和 |
| `tickMs`        | `hosted-native`          | median-of-process-p95 | +15%         | steady record 的全部真实阶段耗时之和        |
| `layoutMs`      | `hosted-native`          | median-of-process-p95 | +15%         | steady Runtime Layout 阶段                  |
| `paintMs`       | `hosted-native`          | median-of-process-p95 | +15%         | steady Runtime Paint 阶段                   |

`artifactBytes` 按路径排序递归计数 regular-file bytes，不跟随 symbolic link，
遇到 link 或 special file 直接失败。它可以在本地确定性复核，但只有与 hosted
native report 同 commit、同 clean artifact 的结果才能激活 release baseline。

median 对偶数样本取中间两个值的平均数；p95 使用 nearest-rank。
对 frame 指标，先在每个 measured process 的 100 帧中取 p95，再对 10 个
process p95 取中位数，避免把单个快进程的大量样本淹没慢进程。最后对
3 个独立 runner summary 的每项指标取中位数，该值才能与 active budget 比较。
active budget 的上限计算为：

```text
limit = baseline * (1 + maxRegressionPercent / 100)
```

## Report Contract

校验器消费 3 份完整 raw runner report 及绑定它们真实字节的 report
set，而不是任意填写的 summary。下面只是字段结构，占位符不是基线证据：

```jsonc
{
  "schemaVersion": 2,
  "kind": "performance-runner-report",
  "workload": "reference-notes-v3",
  "platform": "darwin-arm64",
  "commit": "<40-character lowercase commit SHA>",
  "capturedAt": "<ISO-8601 timestamp>",
  "replica": 1,
  "runner": {
    "provider": "github-actions",
    "image": "macos-15",
    "hosted": true,
    "runId": "<canonical positive decimal>",
    "runAttempt": 1,
  },
  "artifact": {
    "name": "reference-notes-macos-arm64",
    "executable": "Nexa Notes.app/Contents/MacOS/NexaNotes",
    "bytes": 27159002,
    "executableSha256": "<64-character lowercase sha256>",
    "treeSha256": "<64-character lowercase sha256>",
    "archiveSha256": "<64-character lowercase sha256>",
  },
  "quality": {
    "failedRuns": 0,
    "droppedFrames": 0,
  },
  "measuredProcesses": [
    {
      "index": 1,
      "coldStartMs": 0,
      "idleRssBytes": 0,
      "frames": {
        "tickMs": [0 /* exactly 100 non-negative raw numbers */],
        "layoutMs": [0 /* exactly 100 non-negative raw numbers */],
        "paintMs": [0 /* exactly 100 non-negative raw numbers */],
      },
    },
    // Exactly 10 measured-process objects with index 1..10.
  ],
}
```

一个平台的 report set 结构为：

```jsonc
{
  "schemaVersion": 1,
  "kind": "performance-report-set",
  "workload": "reference-notes-v3",
  "platform": "darwin-arm64",
  "commit": "<shared execution commit>",
  "capturedAt": "<aggregation timestamp>",
  "runner": {
    "provider": "github-actions",
    "image": "macos-15",
    "hosted": true,
    "runId": "<shared run ID>",
    "runAttempt": 1,
  },
  "artifact": {
    "name": "reference-notes-macos-arm64",
    "executable": "Nexa Notes.app/Contents/MacOS/NexaNotes",
    "bytes": 27159002,
    "executableSha256": "<shared executable SHA-256>",
    "treeSha256": "<shared tree SHA-256>",
    "archiveSha256": "<shared archive SHA-256>",
  },
  "reports": [
    {
      "replica": 1,
      "path": "nexa-performance-darwin-arm64-replica-1.json",
      "sha256": "<SHA-256 of the exact raw file bytes>",
      "capturedAt": "<raw capture timestamp>",
    },
    // Replicas 2 and 3 have the same descriptor shape.
  ],
  "summary": {
    "method": "median-of-three-runner-summaries",
    "runners": [
      {
        "replica": 1,
        "metrics": {
          "coldStartMs": 0,
          "idleRssBytes": 0,
          "artifactBytes": 27159002,
          "tickMs": 0,
          "layoutMs": 0,
          "paintMs": 0,
        },
      },
      // Exactly three per-runner summaries.
    ],
    "metrics": {
      "coldStartMs": 0,
      "idleRssBytes": 0,
      "artifactBytes": 27159002,
      "tickMs": 0,
      "layoutMs": 0,
      "paintMs": 0,
    },
  },
}
```

raw 报告必须包含全部 10 个进程边界。Native 指标出现于 `hosted: false`、
runner image 与平台不匹配、进程或每进程帧数不精确、数值非有限或为负、
failed run 非零、dropped frame 非零时，校验器都会 fail closed。report set
只接受精确的 `1/2/3` replica，并会重新读取 raw 文件的真实字节、核对 SHA-256、
重建整份 manifest 和 summary。

生产入口还冻结采样政策：每平台 3 个 replica；每个 replica 执行 3 次
warmup 和 10 次 measured；每个 measured 进程固定 1 个 startup present 后再提交
100 个 steady-state present。单元合同可以使用更小的 fixture，但
`validate`、`status`、artifact CLI 和 native collector 对生产配置拒绝弱化后的
数量。active baseline 的 `evidence.reportSet` 必须是仓库相对路径，每一级
父目录、report set 和三份 raw 文件都必须是非 symlink 的 regular file。校验器
重建 report set 并重算平台 statistic 后才接受 `baseline.value`。同平台六项
active metric 必须引用同一个完整 report set。

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
  --archive "$RUNNER_TEMP/performance-candidate-darwin-arm64.tar" \
  --platform darwin-arm64 \
  --runner-image macos-15 \
  --replica 1 \
  --commit "$GITHUB_SHA" \
  --output "$RUNNER_TEMP/nexa-performance-darwin-arm64-replica-1.json"
```

先校验每份完整 hosted raw report，再聚合一个平台 report set：

```bash
node tools/performance-budget.mjs validate-report \
  --report /path/to/replica-1.json \
  --json

node tools/performance-budget.mjs aggregate \
  --report /path/to/replica-1.json \
  --report /path/to/replica-2.json \
  --report /path/to/replica-3.json \
  --output /path/to/report-set.json \
  --json

node tools/performance-budget.mjs check-set \
  --report-set /path/to/report-set.json \
  --json
```

`check-set` 退出码为 `0`（全部 active budget 通过）、`1`（合同错误或性能回归）、
`2`（report set 有效但仍存在 pending baseline）。`--allow-pending` 只用于
审阅首轮 candidate，不能用于 release gate。schema v2 runner report 不接受
单报告 `check`，防止绕过三副本。`status --require-active` 用于 rehearsal，任一
pending baseline 都返回 `2`。

## Baseline Activation

激活 baseline 必须经过以下审阅步骤：

1. 在两个 hosted producer 上分别生成同一 execution commit 的候选制品，并由每平台
   3 个独立 hosted replica 生成共 6 份完整 raw report。
2. 将每平台 3 份 raw 文件和 report set 原样归档在同一仓库相对目录，
   保持 set 内的相对 path 可解析，不得重新序列化 raw JSON。
3. 复核 workload、run ID/attempt、runner image、replica `1/2/3`、commit、
   archive/tree/executable identity、每份 10 个进程和每进程 100 帧、`quality`、
   raw byte digest 与 report-set summary，不得人工删除 outlier。
4. 将对应 baseline 从 `pending` 改为 `active`，`value` 原样使用
   `reportSet.summary.metrics`；同平台六项 `evidence` 全部写入同一
   report-set path、40 字符 commit 和 report-set ISO timestamp。
5. 对两个 report set 运行不带 `--allow-pending` 的 `check-set`，再对两个
   平台运行 `status --require-active`。

任何 workload、采样方法、runner image 或 metric 含义变化都必须先递增 schema
或 workload ID，并重新建立 baseline。旧平台 baseline 不可跨边界复用。

### Historical v1 activation

以下证据属于 `reference-notes-v1`，只用于审计旧采样合同，不能激活 v3。
v1 激活证据来自 GitHub Actions run `31895582357`，source branch HEAD 为
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

## Historical v1 Regression Evidence

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

两个 budget check 均未发现超过当时 active 阈值的回归。本次记录是对 v1 baseline
的复核，不改写原始 activation provenance，也不是签名、clean-tag rehearsal
或发布证据。

## v2 Steady-State Boundary

PR run `31952821895` 绑定 merge revision
`0e5c25417fc3db7b326a1af7e0c7833bf4c099e9`。Windows report 的 cold start、RSS、
artifact、tick 和 paint 全部通过，且 `failedRuns=0`、`droppedFrames=0`；仅
`layoutMs` nearest-rank p95 为 `0.5185ms`，超过 v1 上限 `0.40917ms`。对 v1
activation、run `31902303937`、run `31949361718` 和该失败报告逐进程复核后，确认
每 10 帧的首帧占总样本 10%，其中约半数承担一次性布局成本，使高值恰好落在约 5%
的 p95 断点。运行时代码和 collector 自 v1 activation 后均未变化，因此不能把再次
采样碰巧通过当作修复。

v2 用固定位置而非耗时值划分边界：每个 measured 进程的首个 Presented 只证明
cold start，随后 100 个 Presented 才进入 tick/layout/paint p95。所有 event 仍先完成
schema、identity、单调 frame ID、outcome/count 和 drop 校验；首帧 drop 仍阻断报告，
第二帧及以后任何慢样本都必须保留。该语义变更已递增 workload ID，并要求双平台
重新生成 raw report，禁止沿用或改写 v1 数值。steady 样本同时从 100 提高到 1000；
10 个独立 measured 进程和 5 秒 settle 不变，每进程采 100 个 steady frame，使
nearest-rank p95 由约 5 个尾样本扩展到约 50 个尾样本，而不是重复运行直到碰巧通过。

### v2 activation

PR run `31958001217` 的 source head 为
`3051815dd70118c292ad7f64d1c34b0f728182c7`，两份报告都绑定该次 Actions merge
execution revision `184351135c649f83af07730bf337ff9b20f8b89f`。macOS job
`95191688326` 与 Windows job `95191688333` 均完成 candidate build、真实 native
capture、pending-aware check 和 raw report upload。两份报告的 `failedRuns`、
`droppedFrames` 都是 `0`，样本数都精确为 `10/10/1/1000/1000/1000`，没有按耗时
删除样本。macOS / Windows 的 `capturedAt` 分别为
`2026-08-16T16:27:45.739Z` / `2026-08-16T16:38:08.451Z`：

| Platform       |       cold start median | idle RSS median | artifact max |      tick p95 |   layout p95 |    paint p95 | Raw report                                                                       |
| -------------- | ----------------------: | --------------: | -----------: | ------------: | -----------: | -----------: | -------------------------------------------------------------------------------- |
| `darwin-arm64` |  `222.8333330000023 ms` |   `593289216 B` | `27159002 B` | `1.934543 ms` | `0.25125 ms` | `0.14575 ms` | `release/performance/184351135c649f83af07730bf337ff9b20f8b89f/darwin-arm64.json` |
| `win32-x64`    | `124.14789999999994 ms` |   `154681344 B` | `18529860 B` |    `0.617 ms` |  `0.2208 ms` |  `0.1526 ms` | `release/performance/184351135c649f83af07730bf337ff9b20f8b89f/win32-x64.json`    |

macOS artifact `9266640366` 的 GitHub digest（上传 ZIP）为
`sha256:b29499dcf1104b7623270855428a430776a388f81a0cdf15a032ed56a3b8dbe3`，raw
JSON SHA-256 为
`4a988731c16b41a94fde7315387ed26e1fece9906c6e240babe9ca9c2fcb909d`；Windows
artifact `9266767913` 的 GitHub digest（上传 ZIP）为
`sha256:8a25fce685d9383ab8c5e8aae1a5343b0c573e026485d506936a353b8378acaf`，raw
JSON SHA-256 为
`e959227501ab4302e3380f1313de108166e9fac5f13d283b427b9b3848e3a506`。GitHub
artifact digest 与 raw JSON digest 的对象不同，二者不能互换。激活后两个 raw report
的严格 `check` 与两个平台的 `status --require-active` 均返回 `0`。

## v3 Runner Stability Boundary

PR run `31964264123` 绑定 source head
`90a1bd0a7d5737fb825d0ecb6cb7b8f726b52648` 和 merge execution revision
`f10690eb2933281a12cf9141e11a5ce859921d8a`。在代码 revision 不变的前提下，
macOS attempt 1 job `95206941346` 和 attempt 2 job `95261335323` 均因 active
budget 回归失败。两次报告的 `failedRuns` / `droppedFrames` 都是 `0`，但
cold start 中位数从 `296.3723955000005ms` 变为 `544.8533329999991ms`，
pooled frame p95 也从 `2.471625/0.300333/0.199916ms` 变为
`3.259833/0.444458/0.292458ms`。这是真实 hosted runner/build 波动，不能通过
反复采集直到碰巧通过来解决。

该 run 的重跑还在同一 run ID 下产生了两个同名 macOS artifact，证明只绑
run ID 而不绑 attempt 会导致证据歧义。v3 因此同时收紧四个边界：每平台只构建
一份共享候选 tar，使三个 replica 测量完全相同的 bytes/tree/executable/archive；
保留 10 个 measured process 边界，frame 先按进程取 p95 再取进程中位数；
平台使用 3 个独立 runner summary 的中位数；raw/set 同时绑定 run ID、
attempt、replica 和原始字节 SHA-256。任何一份 replica 缺失都会阻止平台 gate。

### v3 activation

PR capture run `31991801398` attempt 1 的 source head 为
`8302b89200698df6a6ead7772928107ba4d56eee`，六份 raw report 和两个 report set
绑定 Actions merge execution revision
`2c91ac02340245e5bad206bc1e9fe0d8b96b88fd`。两者用途不同，不得混用。
合同 job `95276587183`、producer jobs `95276749565` / `95276749685`、六个
capture jobs 和两个 aggregate jobs 共 11/11 成功。六个 capture job 的
`runner_name` 均不同，证明 replica 来自六个独立 GitHub-hosted VM；全部 raw
report 都记录 `failedRuns=0`、`droppedFrames=0`，并精确包含 10 个 measured
process 和每进程三类各 100 个 steady frame。

两个 report set 的激活值为：

| Platform       |           `coldStartMs` | `idleRssBytes` | `artifactBytes` |                `tickMs` |               `layoutMs` |                `paintMs` | Report set                                                                                                                |
| -------------- | ----------------------: | -------------: | --------------: | ----------------------: | -----------------------: | -----------------------: | ------------------------------------------------------------------------------------------------------------------------- |
| `darwin-arm64` | `295.58864549999953 ms` |  `592650240 B` |    `27159002 B` |          `2.7703335 ms` | `0.48343749999999996 ms` | `0.28893749999999996 ms` | `release/performance/2c91ac02340245e5bad206bc1e9fe0d8b96b88fd/darwin-arm64/nexa-performance-darwin-arm64-report-set.json` |
| `win32-x64`    | `130.51700000000164 ms` |  `154599424 B` |    `18529860 B` | `0.5083500000000001 ms` |             `0.23695 ms` | `0.12090000000000001 ms` | `release/performance/2c91ac02340245e5bad206bc1e9fe0d8b96b88fd/win32-x64/nexa-performance-win32-x64-report-set.json`       |

macOS report-set `capturedAt` 为 `2026-08-17T04:08:07.214Z`；Windows 为
`2026-08-17T04:08:05.332Z`。每项平台值都是三个完整 runner summary 的中位数，
没有删除或重采样任何慢 runner。macOS replica 2 的 cold start runner median 为
`963.0997294999997ms`，仍完整保留在 raw/report set 中，平台值由既定三副本中位数
自然隔离该 hosted runner 波动。

共享候选先从 GitHub artifact 独立下载，再对 tar、解包树、regular-file bytes 和
主可执行文件重新计算 identity；结果与三份 raw/report set 完全一致：

| Platform       |  Producer job | Candidate artifact | GitHub ZIP digest                                                         | Tar SHA-256                                                        | Tree SHA-256                                                       | Executable SHA-256                                                 |
| -------------- | ------------: | -----------------: | ------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `darwin-arm64` | `95276749565` |       `9275849120` | `sha256:604ae1660578200fc61164b0f5b1601f49af3111c7b985f1087430540c71d12b` | `a65a4dc98b77337fdc00228069af10acd7ccf0b00903c101a3e17f1ff0e62403` | `2362d65250a76e50c91afd4b26d23a5244c9a39ccdf255ab31b1908ce3944dff` | `ad9bd0f8d81631f7f46f1364a6056e3024c46d3396823e170e64158375921144` |
| `win32-x64`    | `95276749685` |       `9276016981` | `sha256:ec3c8909e9c4f0bda3f784c383c35bea3cf164dcd76d7f2e175c77c9515e0d61` | `e46a31de0581e73751f9203d1866e563a9154531427666b3204956cf0c513994` | `0bf9266d99d381ec84b8b27bab4e267dc59bc2cd58a601ca1e368056859f5f54` | `128bef8577b58ba583666151b54090d953baa27a548fdc2258e2e889bd6f44be` |

六份独立 raw artifact 与 report-set artifact 内的同名文件逐字节一致：

| Platform       | Replica |   Capture job | Runner                      | Raw artifact | GitHub ZIP digest                                                         | Raw JSON SHA-256                                                   |
| -------------- | ------: | ------------: | --------------------------- | -----------: | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `darwin-arm64` |       1 | `95280520234` | `GitHub Actions 1000026273` | `9276037138` | `sha256:5453ecc6e2ba4c5bdcbca4eb08c46e176b8a62f53f8f3611a356421df83f1db3` | `499358d6a8bbc576e45083a0f79cb807e41de75d28be087680b4c6427212f506` |
| `darwin-arm64` |       2 | `95280520262` | `GitHub Actions 1000026278` | `9276040405` | `sha256:b2fb05a4009bd6505871ee2ccb8e605126116cfea8d974e429bc0f3dee44e025` | `312edd110ef93b78a2c02a27bf713668e7369c7f3fcd3be29d2da32a9a0c4231` |
| `darwin-arm64` |       3 | `95280520297` | `GitHub Actions 1000026277` | `9276039663` | `sha256:a928a9271f52411ec3cb39079a673af557c1d228d73a7ffb02119f1c2616f487` | `d6f21184ba079cafeca13075fdc62a2fa0d9b54bb32b8ab29620985bae9da1b8` |
| `win32-x64`    |       1 | `95280520268` | `GitHub Actions 1000026274` | `9276040474` | `sha256:c7dec513d7f79576bdbc0929eaa56292795a19755e8511591193a8f8b7d217cb` | `786cbaecb81db113230f7ed0b084dc52cb2e138d70dae7b4e5ba62bb0b139f83` |
| `win32-x64`    |       2 | `95280520288` | `GitHub Actions 1000026275` | `9276038950` | `sha256:b58cc8084c7427c9fbedf08a85069d73f93109a6cc7f697fdaa90d2375b220b4` | `21c2cb5b4b080545310403e5fe8a2b24a52119d65a293a2a511094c57a8e90cb` |
| `win32-x64`    |       3 | `95280520276` | `GitHub Actions 1000026276` | `9276039075` | `sha256:83981aaed55d9fd1fcac9c0abe738623f69837f9078998adf562bca8fdfd38c8` | `8c60ca6836be3cbe80d31d8190cf8d9ee26d8933f37affe17cfd87ef5e3bb9aa` |

macOS aggregate job `95280728671` 上传 report-set artifact `9276045049`，
GitHub ZIP digest 为
`sha256:9c721ca520a7397b0758341fb71a7c918d73453570d62708f27e5ae892158902`，
report-set JSON SHA-256 为
`13cb0b5213bb526296c59d9655a8827c02c0650f98c56b50ea2c0c597bad6f33`。
Windows aggregate job `95280728587` 上传 artifact `9276044564`，GitHub ZIP
digest 为
`sha256:4510945a559feda1485e56b202d5536d5c002587ee4786116381b3de1a0ba707`，
report-set JSON SHA-256 为
`b22b98621a759b481e981106c0d176a2efe6bcb295ad156ee37439cfde58d1d5`。
GitHub digest、candidate tar digest、raw JSON digest 与 report-set JSON digest
分别绑定不同对象，不能互换。

归档后的两个 `check-set`、两个 `status --require-active` 和冻结配置校验均返回
`0`。该 capture/activation 只建立 v3 baseline；它不是 active-baseline required
复核、clean tag、签名、公证、registry 或发布证据，因此不能单独关闭 G6-07P、
G6-08P 或 G6-09P。

## Workflow Boundary

`performance.yml` 可通过手动触发、每周 schedule 或 reusable workflow 运行；PR
只有显式添加 `performance-capture`、`performance-required` 或
`release-rehearsal-required` label 才由 `ci.yml` 调用，避免普通变更承担双平台长任务。
rehearsal label 固定要求 active baseline，并把这个同 revision job 的结果传给
candidate rehearsal，避免在演练内部另起一组性能 runner。手动与 tag rehearsal
没有 caller result，因此仍自行调用 performance workflow。

该 workflow 固定 Node 22 和 Action SHA，每平台的 shared producer 先运行
`pnpm release:build` 物化 Native Host 输入，只构建和归档一次 Notes candidate；
3 个独立 capture job 分别下载该 tar、校验 archive SHA-256、运行 native collector
并上传 raw report。platform aggregate job 下载三份 raw，分步执行 `aggregate`
和 `check-set`；只要 aggregate 成功，即使 budget 回归也会上传包含三份 raw
的完整 report-set artifact。producer 或某个平台失败不会删除另一平台已生成的证据。
`require_active` 或 `performance-required` 会在采集前验证两个平台没有
pending baseline；首次 baseline 捕获只能由显式 `performance-capture` PR label
或手动 workflow 通过 `--allow-pending` 生成评审报告。

该 workflow 当前没有伪装成 native benchmark：它不会把编译成功、启动存活、
startup smoke、测试 fixture 或 artifact byte count 填入 cold start、RSS、tick、
layout、paint。release rehearsal 复用同一 workflow，并固定要求 active baseline；复用
的是完整 gate result，不改变阈值、统计量、样本数或 pending-baseline 的 fail-closed 语义。

## Local Implementation Evidence

2026-08-09 v1 本地证据（不激活 baseline）：

- `pnpm --filter @nexa/nui-host build` 刷新 Perry Native source closure；随后
  `pnpm --filter @nexa/example-reference-notes build` 重新 AOT/link Notes，binary
  marker 包含 `NEXA_PERFORMANCE_CAPTURE_V1` 与 `NEXA_PERFORMANCE_EVENT`，startup
  smoke 成功。
- 相对路径入口的真实 warmup 为 3/3 `Presented`、0 drop，first-present
  `2605.618ms`；真实 measured 为 10/10 `Presented`、0 drop，first-present
  `1188.724ms`，5 秒 settle 后 macOS RSS `71925760` bytes。样本只作为本地
  integration smoke，不写入 `release/performance-budgets.json`。
- `node --test tools/performance-budget.test.mjs tools/performance-collector.test.mjs`
  通过 `33/33`；`cargo test --manifest-path packages/nui-host/Cargo.toml --locked
performance` 通过 `3/3`。测试覆盖 commit/GITHUB_SHA、artifact 前后 identity、
  run ID/attempt、replica/process/frame 精确边界、raw-byte digest、report-set 重建、
  duplicate frame/count consistency、relative executable、RSS timeout、TERM→SIGKILL
  和 workflow producer/capture/aggregate/check-set/upload 顺序。
