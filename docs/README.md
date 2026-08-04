# Nexa UI 文档

## 当前规划

- [项目详细设计](./PROJECT-DESIGN.md)：目标、现状、目标架构、核心合同、测试与成功标准。
- [路线图](./ROADMAP.md)：G0–G6 里程碑、依赖、退出条件、并行方式与风险。
- [执行 Todo](../TODO.md)：可领取、可验证、带依赖和文件范围的任务清单。

以上三份文档当前均为 **Draft**。负责人确认详细设计中的假设和待确认问题后，才能把对应架构和里程碑视为批准。

## 架构决策

- [ADR 索引](./decisions/README.md)
- [ADR-004：框架适配器、统一 Native UI Host 与最快可见 MVP](./decisions/ADR-004-framework-adapters-native-host-mvp.md)
- [ADR-005：跨平台系统 API、权限模型与插件架构](./decisions/ADR-005-system-host-permissions-plugins.md)
- [ADR-006：Application Runtime、平台组合层与 P0 契约](./decisions/ADR-006-application-runtime-composition-p0.md)

ADR 记录已做出的长期决策；详细设计负责把这些决策组合成当前目标架构；路线图和 Todo 负责执行顺序。出现冲突时，应先新增或修订 ADR，再更新设计与计划。
