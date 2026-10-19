# Go Core 迁移设计

[English](../go-core-migration.md) · Chinese

**状态：正在实现基础层与隔离的 Memory 影子检索。** 已打包应用仍使用 TypeScript/Node.js Controller 与 Worker。仓库已加入固定版本的 Go 模块、跨运行时生成的状态契约、构建检查及只读 Memory 影子运行时。影子结果不会进入模型上下文，也不会取得执行权。[系统架构](architecture.md)仍描述生产行为。

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

1. **先建立实现基础。** [AGENTS.md](../../AGENTS.md) 与[代码规范](code-style.md)已明确 Go 模块归属、测试和可复现格式化。模块固定 **Go 1.27.2**，该版本在 2026 年 10 月 19 日根据[官方发布记录与支持政策](https://go.dev/doc/devel/release)核对。现有 TypeScript、Python 和 Rust 检查继续启用。需要安装这一准确版本的官方编译器；检查禁止自动选择工具链。
2. **影子验证记忆召回。** Node 保持唯一写入者和执行者。Go 辅助程序读取不可变、绑定 revision 的快照或有界候选，对比召回、作用域、排序、脱敏和文本预算。影子结果不进入模型、不触发工具。行为一致后，通过适配器接入记忆搜索和已获执行权输入的上下文。
3. **移交 Memory 归属。** 所有记忆变更、项目上下文写入与整合操作都转交 Go。允许 Go 写入前先保证只有一个写入者。保留用户 revision 冲突、确认及明确导入/导出；Node 适配器只作为客户端。
4. **移交 Worker 执行权。** 在兼容测试后实现 Store、Scheduler、Heartbeat、Codex RPC 与 Engine 准入，一起启用其分发权限。影子 Scheduler 或 Engine 可以观察隔离样本或快照，但不得领取真实任务、创建真实 Codex 会话或调用工具。
5. **移交 Controller 与打包。** 保持 Windows provider 行为，再把宿主编排转为 Go。Tauri sidecar 启动、资源白名单、部署、服务管理、源码指纹、版本与产物来源一并更新。确认引用、部署和回滚行为后再删除旧后端模块。Node 仍是 UI 构建依赖，也可能是用户工具的依赖；移除后端运行时不授权删除这些工具。

每个阶段都应可以独立审查、独立发布。某项职责只有在明确切换后才以新实现为准，此前现有行为仍是权威。

## Go 实现边界与优化

Go 入口放在 `core/cmd/`，功能包放在 `core/internal/`。Memory 分开管理检索策略、SQLite Repository、固定参数化查询和经校验的行映射。SQL 作用域条件、确认规则和 revision 校验是安全不变量，不属于环境配置。通用 CRUD Repository 或 ORM 不能替代这些功能专属校验。

```text
core/
  cmd/dant-core/          仅处理信号与进程入口
  internal/
    contracts/           生成的状态词表与传输限制
    shadow/              影子角色组装、选项和快照生命周期
    transport/           有界 stdio 分帧、分发与取消
    memory/              检索策略、Repository、查询与行映射
      stdio/             Memory 请求与响应适配器
scripts/core/            固定版本工具、契约生成与影子客户端
tests/core/              TypeScript 工具测试与显式一致性检查
```

Go 行为测试与所属包相邻。接口由需要可替换能力的消费方定义，例如 Memory stdio 适配器只依赖查询操作与快照校验。领域包不导入命令入口或传输适配器。Controller、Worker 和 Provider 在职责真正迁移时再增加对应包，不提前堆放空的通用层。

第一阶段 Memory 使用 `database/sql` 与固定版本的纯 Go SQLite。FTS5 的 `MATCH`、`bm25`、不可变快照和准确 revision 行为适合显式 SQL。GORM 支持 [Raw SQL](https://gorm.io/docs/sql_builder.html)，但在这里引入后仍需维护这些查询，以及独立的 schema 兼容策略。当前不引入 ORM 或自动 schema 迁移。SQL 使用绑定参数，不能拼接调用方传入的查询、作用域、标识符或排序规则。

`src/contracts/state-domains.json` 生成现有冻结的 TypeScript 状态域与 Go 类型状态；`core-protocol.json` 生成共享传输限制。`npm run check:contracts` 拒绝生成结果漂移。API DTO 生成与执行权屏障仍属于后续工作；基础契约存在不代表整个 Core 契约已迁移。

影子运行时只提供通过父进程 stdio 调用的 `ping`、`search`、`retrieve`。四个 worker 与十六项队列限制读取并发。截止时间、显式取消、唯一输出写入者、帧限制和有界会话身份，防止 goroutine、队列或保留 ID 无限制增长。取消只停止等待，不能授权重放。这个运行时没有模型连接、任务准入、调度分发或 HTTP 监听。

Node 所有者在同一事务内同步 FTS 并捕获脱敏的权威参考投影。独立快照保留全部索引行，以维持相同排名，并将搜索 revision 与权威 revision 绑定。Go 复用进程与读取连接，不为每次查询启动进程或复制数据库。影子快照不复制原数据库及原始笔记、项目表。查询规范化与敏感值处理继续复用现有 TypeScript 实现，直到这部分也单独通过一致性迁移。

使用 `npm run test:core:parity` 运行隔离的跨运行时夹具与预热延迟测量。检查身份、作用域、顺序、摘录、可空元数据与分数，包括 CJK 与 UTF-16 边界。Node 查询权威数据库，Go 查询不可变投影；计时包含这项架构差异，不能当作通用语言性能比较。分别记录启动、快照创建和预热请求延迟。后续需另行测量大文件流与背压、Scheduler/Heartbeat I/O 取消、进程 RSS 和实际 UI 交互。即使独立 I/O 并发运行，任务状态变更与 SQLite 写入也保持单一所有者。

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
