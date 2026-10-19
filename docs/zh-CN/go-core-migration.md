# Go Core 迁移设计

[English](../go-core-migration.md) · Chinese

**状态：目标架构已确认，实现尚在规划。** 当前应用，包括 Beta12 源码，仍使用 TypeScript/Node.js Controller 与 Worker。本文没有实现 Go 后端、Go 构建检查或运行时切换。[系统架构](architecture.md)仍描述当前实际行为。

目标是 **Go Agent Core + Rust Tauri + TypeScript UI**。迁移改变 dant 后端编排层的实现语言；模型推理、工具迭代和模型会话仍由 Codex App Server 负责。Go 不能另外实现一套 LLM 循环。

## 职责归属

| 组件             | 目标职责                                                                               | 必须保留的现有边界                                         |
| ---------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| TypeScript UI    | 页面、交互、渲染与经过校验的请求                                                       | 不在本机执行任务，不直接访问数据库                         |
| Rust Tauri       | 窗口、托盘、通知、原生 IPC、安装器、系统编辑器与操作系统集成                           | 原生命令保持现有窗口作用域与传输校验                       |
| Go Controller    | HostPlatform、VMProvider、SSH 转发、生命周期、部署、更新、宿主设置、本地备份与离线视图 | 不在宿主构造执行 Engine 或运行 Agent 工具                  |
| Go Worker        | 权威对话状态、执行准入、任务生命周期、记忆、调度、Heartbeat 与工具路由                 | Linux VM、普通用户、健康桌面、唯一执行归属                 |
| Codex App Server | 模型推理、持久模型线程与工具迭代                                                       | 保留子进程 stdio JSON-RPC，以及实际确认的 thread/turn 身份 |
| VM 桌面辅助工具  | 截图、输入、文件操作与人工控制租约                                                     | 保留 Python 桥接与现有授权检查                             |

即使来自同一 Go 模块，Controller 与 Worker 仍是分开的运行角色。Worker 离线时，Controller 不能接管执行。HostPlatform 与 VMProvider 继续作为明确的适配器；迁移 Go 本身不等于实现 macOS 或 Linux 宿主支持。

现有实现边界是 [`src/app/`](../../src/app/)、[`src/work/`](../../src/work/)、[`src/runtime/`](../../src/runtime/)、[`src/conversation/`](../../src/conversation/) 与 [`src/schedules/`](../../src/schedules/)。通过小范围适配接口逐步迁移职责，不把所有逻辑堆进新入口文件。

## 先确定契约

dant 自有 API 的 DTO、具名状态域、错误、身份字段和协议上限，应使用一份语言无关的 Schema 源，生成 Go、TypeScript 和需要的 Rust 类型及校验器，并由 CI 检查生成结果是否漂移。保持现有序列化值；生成类型不能替代运行时校验。Codex 协议适配器保持独立，并与锁定的 App Server 版本兼容。

兼容契约包括：

- 现有 API 路由、鉴权、允许的 Origin、事件流和原生 IPC。保留 [`protocol.json`](../../src/config/protocol.json) 中应用 API `4317` 与桌面桥 `4320` 的默认值、现有容量限制及 SSH 转发；传输重设计另行处理。
- 精确的 conversation、work、message、thread、turn、call 与连接 generation 身份。应用异步结果前重新确认捕获的身份仍有效。
- 当前 API 区分的字段缺失、`null`、`false` 与零值。Go 的 `omitempty` 不能吞掉明确清除；数值使用具名类型或精确 JSON number，不能直接依赖未经校验的 `float64` 映射。
- 已有未知结果与稳定错误码。丢失确认不能转化为自动重试或成功回执。
- 序列化为稳定字符串的具名状态域。未知外部状态必须校验失败或明确保留不确定，不能归一化成执行许可。

保留当前本地 token/Origin 检查、鉴权转发及凭据桥作用域。迁移中的 Go 子进程应通过父进程控制且有界的 stdio 通信，避免另开未鉴权端口。token 不得进入命令行参数，凭据不得进入诊断、Schema 或测试样本。

## 持久化兼容

保留 `state.json`、附件身份、Skills 与支持文件原字节、Codex home/线程数据、备份清单、凭据加密封装，以及以下数据库：

| 权威存储                     | 必须兼容的内容                                                              |
| ---------------------------- | --------------------------------------------------------------------------- |
| `memory/dant/memory.sqlite`  | Schema 版本、notes、项目键、记忆条目、revision 触发器、FTS5 与确认/冲突规则 |
| `schedules/schedules.sqlite` | 任务、创建请求 tombstone、唯一 occurrence claim 与分发回执                  |
| `state.json`                 | 消息、持久任务、提交状态、来源身份、时间戳及旧版字段                        |

更换运行语言不构成重命名存储、生成替代 ID 或补造缺失时间戳的理由。保留现有 revision 比较、busy timeout、`synchronous=FULL` 和 DELETE journal，除非另有验证过的迁移。现有 Schema 守卫要求的 revision 触发器定义必须保持一致。Go 的 SQLite 实现必须在 Windows 与 Linux 证明 FTS5 和当前 Unicode/CJK 检索行为可用，再选择并锁定驱动。

**当前 FTS 检索有写入副作用。** [`memory-search.mts`](../../src/conversation/memory-search.mts) 在 `search_revision` 与 `revision` 不一致时重建索引。Go 只读查询不能悄悄跳过这一步。现有 Node owner 必须先同步索引并生成一致的 SQLite 快照，或提供有界、不可变的候选记录。Go 快照读取必须确认检索 revision 匹配；旧索引应返回明确的不可用/待处理状态，不能作为成功的空结果。不能未经 SQLite 快照协调直接复制正在使用的数据库文件。

调度继续明确区分 SQLite 与 JSON：SQLite claim 串行化精确 ID 的 JSON 写入，但两个文件不是同一个数据库原子事务。持久化 `handed-off` 栅栏防止重放，并不证明执行成功。

## 迁移阶段

1. **先建立实现基础。** 第一个 Go 源码变更前，更新 [AGENTS.md](../../AGENTS.md) 与[代码规范](code-style.md)，明确 Go 模块归属、测试和可复现格式化。加入锁定版本的构建、格式、测试与 race 检查，不能削弱现有检查。建议未来固定 **Go 1.27.2**，该版本在 2026 年 10 月 19 日根据[官方发布记录与支持政策](https://go.dev/doc/devel/release)核对。这是未来工具链基线，并非已经安装的依赖或现有仓库配置。
2. **影子验证记忆召回。** Node 保持唯一写入者和执行者。Go 辅助程序读取不可变、绑定 revision 的快照或有界候选，对比召回、作用域、排序、脱敏和文本预算。影子结果不进入模型、不触发工具。行为一致后，通过适配器接入记忆搜索和已获执行权输入的上下文。
3. **移交 Memory 归属。** 所有记忆变更、项目上下文写入与整合操作都转交 Go。允许 Go 写入前先保证只有一个写入者。保留用户 revision 冲突、确认及明确导入/导出；Node 适配器只作为客户端。
4. **移交 Worker 执行权。** 在兼容测试后实现 Store、Scheduler、Heartbeat、Codex RPC 与 Engine 准入，一起启用其分发权限。影子 Scheduler 或 Engine 可以观察隔离样本或快照，但不得领取真实任务、创建真实 Codex 会话或调用工具。
5. **移交 Controller 与打包。** 保持 Windows provider 行为，再把宿主编排转为 Go。Tauri sidecar 启动、资源白名单、部署、服务管理、源码指纹、版本与产物来源一并更新。确认引用、部署和回滚行为后再删除旧后端模块。Node 仍是 UI 构建依赖，也可能是用户工具的依赖；移除后端运行时不授权删除这些工具。

每个阶段都应可以独立审查、独立发布。某项职责只有在明确切换后才以新实现为准，此前现有行为仍是权威。

## 执行权切换

除现有 Engine 的单准入检查外，Worker 切换需要旧、新运行时共享的进程级归属栅栏。不能仅靠 Go 进程内 mutex 或 API 端口排除旧执行器。

1. 阻止聊天、语音、调度与 Heartbeat 的新准入，保留持久化队列。
2. 使用现有暂停/更新路径，核对活动 turn。移交前确认旧执行器及其 Codex 子进程已经停止；停止结果未知时不能激活新执行器。
3. 生成经过校验的备份，验证数据与 Schema 兼容，不改动备份或旧运行时文件。
4. Go Worker 获得独占归属后，才启动计时器、网关分发与 Codex 连接。按原 ID 核对未完成 claim，保留暂停和未知状态，不能重新提交。
5. 验证版本、能力、源码来源、鉴权状态/事件、记忆与调度后，Controller 才把新服务标为就绪。

回滚也要求独占归属。外部动作可能已经发生时，任何回退执行前都必须核对结果；更换二进制不构成重放许可。需要转换 Schema 的变更应另有备份迁移和兼容政策。

## 验证与完成标准

使用隔离、脱敏的 golden fixtures，对当前实现执行差分测试。覆盖记忆 revision/缓存变化、FTS 过期、Unicode 召回、作用域/脱敏预算、候选确认与 CRUD 冲突；调度时区/DST、补跑、优先级、崩溃阶段与重复 claim；以及迟到 RPC 确认、过期连接、取消、人工接管和未知结果。复用 `tests/conversation/`、`tests/work/`、`tests/runtime/`、`tests/schedules/` 与 `tests/backups/` 已表达的行为。

Go 测试不能创建真实模型会话、重连用户 VM、发送 Telegram 消息或使用麦克风。验证混合版本 Controller/Worker、重启和备份恢复、Windows/Linux 构建、原生 IPC 与打包来源。只有职责确实迁走、替代检查经过验证，才调整现有 TypeScript、Python、Rust、格式化、覆盖率及发布检查。

完成意味着打包后的 Go 两种角色实际拥有文档中的职责、保留现有数据，并在重启和恢复中证明只有一个执行者。性能结论需要启动时间、内存、状态传输与交互的测量；更换后端语言本身不证明修复 UI 渲染延迟。
