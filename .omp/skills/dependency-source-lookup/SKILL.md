---
name: dependency-source-lookup
description: Look up pinned dependency source and docs when a dependency's behavior, boundary conditions, or side effects are uncertain during development.
---

# 依赖源码自查（Dependency Source Lookup）

开发中遇到第三方依赖的行为、边界条件或副作用不确定时，按本流程自查钉版源码与文档。核心原则对齐 root AGENTS.md 的「Read library source before guessing」：先 read 对应钉版源码再写代码，禁止凭文档摘要或函数名猜测。

## 决策流程

1. **定位钉版源码根**：本机 `/media/liao/storage1/act_ai_deps/`；远程机 `${remote_home}/storage1/act_ai_deps/`。
2. **按域归类找库目录**：按下面的「act_ai_deps 域归类表」定位具体库目录。
3. **read 头文件 + 实现确认真相**：read 对应库的头文件（include/）与实现（src/，必要时连测试），确认行为、边界与副作用；禁止凭函数名或文档摘要猜。
4. **版本 / 拓扑 / 构建顺序**：查 `/media/liao/storage1/act_ai_build/DEPS.md`（远程 `${remote_home}/storage1/act_ai_build/DEPS.md`）——依赖版本、拓扑与构建顺序的唯一真源。
5. **跨模块参考源码与论文**：查 `~/workspace/refs`（远程 `${remote_home}/workspace/refs`），入口为 `product_doc/reference/external_refs_manifest.md`（本机完整路径 `/home/liao/workspace/refactor/act_ai_product/product_doc/reference/external_refs_manifest.md`）。

## act_ai_deps 域归类表

| 域 | 钉版库（目录） | 主要消费方 |
|---|---|---|
| 运动学/动力学 | pinocchio(4.1.0)、eigen(3.4.0)、eigenpy、hpp-fcl、urdfdom(4.0.0)、urdfdom_headers、console_bridge | zero_control、robot_calibrations、dynamics_calibration_py |
| QP/优化 | eiquadprog(1.3.1) | zero_control WBC |
| 轨迹 | ruckig(0.9.2) | zero_control 轨迹执行器 |
| IPC/通信 | iceoryx2（lukeliao fork）、zenoh / zenoh-c / zenoh-cpp(1.9.0)、capnproto(1.5.0) | iceoryx2：drivers ↔ algorithms；zenoh：robot_runtime、data_collection；capnproto：act_ai_types wire schema |
| 总线/驱动 | ethercat（IgH 1.6.10） | act_ai_drivers |
| 仿真 | mujoco-rs、mujoco-tinyxml2、mujoco-deps、ccd、qhull、lodepng、tinyobjloader、marchingcubecpp | sim 链路 |
| 基础/构建 | boost(1.83.0)、fmt、spdlog、nlohmann_json、tinyxml2、googletest、jrl-cmakemodules | 各库构建与测试基建 |

版本、拓扑与构建顺序的**唯一真源**是 `/media/liao/storage1/act_ai_build/DEPS.md`（远程 `${remote_home}/storage1/act_ai_build/DEPS.md`），域归类表不替代它。

## Routing 契约

- 外部 refs（`~/workspace/refs` 及各自仓内 refs/）默认是 **reference**，不是 source of truth；引用时标注来源，不当作事实。
- `act_ai_types` 是跨模块 IPC / wire schema 的唯一真源。
- `product_doc` 是文档的唯一真源。

## Do not do

- 不要把 `act_ai_deps/` 或 `~/workspace/refs` 当主开发区修改——它们是钉版/参考镜像；改库走升级或替换钉版的正式流程，不在开发任务里顺手改。
- 不要凭函数名、文档摘要或直觉写依赖调用；行为、边界、副作用不确定时先 read 钉版源码确认真相。
- 不要在生命周期、线程/并发假设、内存所有权不确定时跳过读源码——这是 C++/Rust 依赖最常见的隐性坑。
- 不要只依赖在线文档或最新版本文档判断行为；本仓钉的是特定版本，以钉版源码为准。
