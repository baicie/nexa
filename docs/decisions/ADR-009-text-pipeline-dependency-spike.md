# ADR-009：文本索引与排版依赖分层

- 状态：Accepted（G2B production stack）
- 日期：2026-08-04
- 更新：2026-08-05（完成 G2B-08，并明确 TS/FFI 文本索引边界）
- 依赖：ADR-006、ADR-007

## 背景

Nexa UI 的文本合同必须先于输入、布局和绘制稳定下来。G2B-06 已用 paragraph metrics 替代 production layout 的字符数估算；G2B-07..08 又让 production Host 以同一 paragraph snapshot 生成 GlyphRun，并由 Skia glyph API 执行。引入真实排版栈会同时改变字体资源身份、二进制体积、跨平台构建和许可证边界。

G2B 已经有自有 `FontDatabase`、显式文本索引合同和 backend-neutral Display List 方向。生产选型必须让 shaping 与 Skia 使用同一字体资源，否则 shaper 输出的 glyph ID 对 renderer 没有稳定含义。

## Spike 结论

| 方案 | 版本/MSRV | 依赖与所有权 | Skia 接缝 | 结论 |
| --- | --- | --- | --- | --- |
| Skia Paragraph | `skia-safe 0.99` 已存在 | Paragraph 同时拥有 shaping/line layout，输入索引与平台 fallback 仍需另建 | 同一 Skia backend 内直接，但会把公共 paragraph 合同绑定到 renderer | 不采用为生产语义所有者；可保留为对照 fixture |
| `cosmic-text` | `0.19.0` / Rust 1.89；`0.17.0` / Rust 1.80 | 自带 font system、fallback、shaping、layout 与 editing，和现有数据库/EditableText 重叠 | 需要从 cosmic face 重新映射到 Skia typeface | 0.19 超出 workspace Rust 1.88；降级仍引入双重所有权，拒绝 |
| 直接 Rust shaping 栈 | `rustybuzz 0.20.1`、`unicode-bidi 0.3.18` | `nui-text` 保持 font/fallback/paragraph 所有权；均为 pure Rust | glyph ID 来自共享 `FontSource { Arc<[u8]>, face_index }`，Skia 从同一资源建立 typeface | 采用 |

锁定依赖：

| Crate | 用途 | License | Rust 兼容性 |
| --- | --- | --- | --- |
| `rustybuzz 0.20.1` | OpenType shaping；输出 glyph、advance、offset、cluster | MIT | 在 Rust 1.88 构建验证 |
| `unicode-bidi 0.3.18` | Unicode Bidirectional Algorithm | MIT OR Apache-2.0 | 声明 MSRV 1.47 |
| `unicode-linebreak 0.1.5` | UAX #14 line-break opportunities | Apache-2.0 | 声明 MSRV 1.56；精确 pin |
| `unicode-segmentation 1.13.x` | UAX #29 extended grapheme boundaries | MIT OR Apache-2.0 | workspace lock 在 Rust 1.88 构建验证 |
| `unicode-script 0.5.8` | Unicode Script 属性与 itemization | MIT OR Apache-2.0 | workspace lock 在 Rust 1.88 构建验证 |
| `font-test-data 0.6.1` | 固定许可字体，仅测试使用 | MIT OR Apache-2.0；所含 Noto/Vazirmatn fixture 按其 provenance/OFL | 声明 MSRV 1.82 |

## 决策

1. `nui-text::TextIndexMap` 是 UTF-8、UTF-16、Unicode scalar 和 grapheme 的唯一边界转换合同。所有编辑、选择、IME 和 paragraph hit-test API 必须通过它转换，禁止在边界处隐式混用 offset 单位。
2. `TextIndexMap` 使用 `unicode-segmentation` 的 extended grapheme 实现，不维护手写 UAX #29 子集。组合标记、变体选择器、Emoji modifier、ZWJ、CRLF 和 regional-indicator flag 均不可在 cluster 内拆分。
3. `FontSource` 由不可变共享 bytes 与 TTC face index 构成，并在注册前验证。`FontDatabase`、rustybuzz shaper 和后续 Skia typeface adapter 必须引用同一个 source；禁止 renderer 按 family 名重新选择另一字体。
4. Rust `nui-text` 的公开 paragraph/shaping offset/range 都使用带类型的 `Utf8Offset` / `Utf8Range`。TypeScript 与 FFI 的 `TextRange` / `TextSelection` 使用 UTF-16 code unit，并在 Bridge 边界通过 `TextIndexMap` 校验和转换；无单位的裸 `usize`/`number` 不得跨模块边界。`BidiRun` 同时暴露 logical range、embedding level 和方向；paragraph 中另存 visual run order。glyph cluster 是原始 source 的绝对 UTF-8 byte offset。
5. rustybuzz advance/offset 在 API 边界由 font units 按 `font_size / units_per_em` 转成 logical pixels。每个 `ShapedRun` 保留 `FontId`、source range、script 和 direction，供 G2B-05 paragraph 与 G2B-07 GlyphRun 复用。
6. fallback 以 extended grapheme cluster 为最小单位。ZWJ、variation selector 等 default-ignorable code point 会完整送入 shaper，但不要求独立 cmap glyph；一个 cluster 不得因逐 scalar fallback 被拆到多个 font run。
7. `nui-text` 不依赖 `nui-core`。G2B-07 由 Core 定义可序列化的 paint GlyphRun，并从 `nui-text::ShapedRun` 转换，避免形成 `nui-core <-> nui-text` 循环依赖。
   `nui-layout-taffy` 通过注入式 `ParagraphCache` 消费 `ParagraphSnapshot`，不把 `FontDatabase` 或 Skia 类型耦合进 `nui-core`。缓存 key 包含 source、font request、node font style、font size、width constraint、default direction 与 `FontDatabaseRevision`；默认最多保留 256 个 snapshot。Taffy measure error 通过 layout adapter 的 typed `LayoutError::Text` 返回。
8. `unicode-linebreak` 的 byte offset 只在 `nui-text` 内部出现；公共 API 包装为 grapheme-aligned `LineBreakOpportunity { Utf8Offset, LineBreakKind }`。CRLF 合并为一个 Hard，尾随 hard break 后另合成 EndOfText，保证编辑 caret 有最终空行。
9. 有限宽度采用最后可容纳 UAX #14 opportunity 的贪心断行，并拒绝 rustybuzz `unsafe_to_break` 或 grapheme 内部候选。不存在安全候选时保留不可断内容并标记 line overflow，不任意拆字。
10. 全文只构造一次 `BidiInfo`；每个断行后的 non-empty line 调用 `visual_runs(paragraph, absolute_range)` 单独执行 UAX #9 L1/L2。run、cluster、glyph 和 caret 均保留原文绝对 UTF-8 offset。
11. `ParagraphSnapshot` 自持 source、`TextIndexMap` 与 FontDatabase revision。每行输出 font-derived baseline/metrics、visual `PositionedRun`、cluster bounds 和 affinity-aware caret stops；混合 fallback 的 metrics 只取该行实际参与字体的最大 ascent/descent/leading。

## 后果与边界

- 生产路径直接依赖五个 pure-Rust Unicode/OpenType crate，不新增 ICU/HarfBuzz native library 或运行时数据文件。
- `unicode-linebreak 0.1.5` 使用 Unicode 15.0 数据，并把 Complex-Context Dependent（SA）统一按 AL 处理；泰文等需要字典分词的文本暂不做语言定制。
- soft hyphen 的可选断点暂不暴露，因为当前 GlyphRun 合同还不能在断点插入可见 hyphen。ligature 内多个 grapheme caret 暂按 cluster advance 等分，后续可由字体 caret 数据替换。
- MVP 保留原始 whitespace advance、物理左起点和字体 normal line metrics；alignment、line-height tailoring 与 whitespace collapse 不属于 G2B-05。
- G2B-06 以已有 `ttf-parser` 有界发现最多 32 个 macOS/Windows/Linux 字体文件与 128 个 face；每个生产 face 都持有共享 bytes/index。彩色 Emoji raster、variable axis 选择和 Skia glyph golden 仍分别进入 G2B-08 与 G2B-09。
- `FontDatabase` 是 process resource；Perry 默认会话使用系统字体，嵌入方可用校验后的 `NuiHost::with_fonts` 注入。window reset 只清 paragraph snapshots，不重建 font ID/revision。Host layout、paint、pointer、wheel 在释放 Host 锁后路由 typed layout failure；legacy `layout_tree` 仅保留为丢弃错误的非生产兼容入口。
- `font-test-data` 只用于测试，不进入 release dependency graph。固定 fixture 先证明 Latin ligature/combining、Arabic joining、CJK cmap 和 invalid TTC/font error；平台字体差异由 macOS/Windows CI smoke 单独覆盖。
- Windows/macOS release package size 仍在 G6-05 记录最终数字；本 ADR 只锁定“无新增 native runtime”和 dev fixture 不入包的边界。

## 验收

- `cargo test -p nui-text` 覆盖 script itemization、纯 LTR/RTL 与混排 visual order、Arabic joining、combining mark、Emoji ZWJ/VS/modifier cluster、default-ignorable zero-glyph cluster、非有限几何、invalid bytes/TTC index、missing source/glyph。
- `cargo clippy -p nui-text --all-targets -- -D warnings` 与 Rust 1.88 build 通过。
- 输出 run 完整引用原始 UTF-8 source；所有 range/cluster 都是合法字符和 grapheme boundary，所有 position 为有限 logical pixel 数值。
- G2B-08 已增加“同一 `FontSource` shape 后由 Skia glyph API 绘制非空像素”的接缝测试；该测试继续作为发布门禁保留。
- G2B-09 以固定 manifest 和 seed corpus 补齐多语言 golden/property 门禁；`cargo test -p nui-text` 当前为 54/54，geometry 量化为 1/64 logical pixel，fixture 仅使用测试字体，不进入 runtime package。

2026-08-05 的 G2B-04 证据：`font-test-data` 精确 pin `=0.6.1`；固定 Latin、Noto Serif TC、Noto Sans Arabic、Noto Handwriting Emoji 与真实 TTC fixture 覆盖 26 个测试；Clippy、rustdoc、rustfmt 与 diff-check 通过。段落断行、逐行 BiDi reorder 和 hit map 保持在 G2B-05。

2026-08-05 的 G2B-05 证据：`unicode-linebreak` 精确 pin `=0.1.5`；typed UAX #14 opportunities、CRLF/全部 hard separator、greedy/overflow、空行、CJK、逐行 L1/L2、混合 fallback metrics、ligature caret、combining、Emoji ZWJ、default-ignorable zero-glyph cluster 与非有限几何 paragraph fixture 均通过。4 个 line-breaking、18 个 paragraph 合同和 `cargo test -p nui-text` 的 48 个测试通过；workspace test/Clippy、rustdoc、rustfmt、TypeScript lint/typecheck/test/build、Prettier 与 diff-check 通过。

2026-08-05 的 G2B-06 证据：source-backed system-font discovery、`NuiHost::with_fonts` 校验、跨 reset 字体生命周期、font-weight-aware cache identity、256-entry capacity、Taffy constraint mapping、真实 Host paragraph metrics 与锁外 layout error routing 均有合同覆盖。`nui-text` 50/50、`nui-layout-taffy` 10/10、`nui-perry-bridge` 51/51、Host FFI 9/9，以及目标 crate Clippy/rustdoc/rustfmt/diff-check 均通过。

2026-08-05 的 G2B-07/08 证据：Core paint snapshot 覆盖 backend-neutral glyph commands 与 scroll/clip ordering；layout integration 证明 paragraph FontId 和 positioned glyphs 无损进入 display list；renderer 使用同一 source-backed Ahem face 的 glyph ID 绘制非空像素；Bridge Host paint 证明 paragraph measure 与 Skia glyph execution 共用进程字体资源。Core paint 5/5、layout 11/11、renderer 11/11、Bridge 52/52 及目标 Clippy/rustfmt 通过。
