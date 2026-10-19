# Go Core 迁移与切换

[English](../go-core-migration.md) · Chinese

当前源码组装为 **Go Agent Core + Rust Tauri + TypeScript UI**。Go 负责 Controller 和 Linux Worker 后端，包括持久化、执行编排、记忆、调度、通话、Telegram、文件、Skills、安全、VM 部署和备份。TypeScript 保留用于浏览器、构建工具与兼容性测试基准。这里描述源码实现，不代表新版本已经发布或完成本机安装验收。

模型推理、工具迭代和持久模型对话仍由 Codex App Server 负责。dant 的 Go Engine 负责准入、持久任务、确认、资源所有权与交付，不另建一套 LLM 循环。参见[系统架构](architecture.md)和[运行支持](runtime-support.md)。

## 运行时与模块归属

| 所有者                                                            | 生产职责                                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `core/cmd/dant-core`、`core/internal/application`                 | 校验进程角色、组装依赖、管理退出。                                            |
| `core/internal/controller`、`computer`、`platform`                | 宿主配置、提供商、SSH 转发、部署、生命周期与离线视图；Windows 不创建 Engine。 |
| `core/internal/app`、`work`、`runtime`                            | 已鉴权的 Worker API、单执行准入、任务连续性与原 Codex RPC 协议。              |
| `core/internal/store`、`history`                                  | 原对话文件、准确 ID、持久任务、通话文字输入记录与已读/交付回执。              |
| `core/internal/memory`、`schedules`                               | SQLite 所有权、修订感知的记忆/FTS 召回、重复规则与派发屏障。                  |
| `core/internal/voice`、`telegram`                                 | 原通话/媒体生命周期、转录、字幕与配对消息，未知交付不得重放。                 |
| `core/internal/files`、`skills`、`security`、`backups`、`updates` | 经校验的文件、Skill 支持文件、凭据、加密归档与更新契约。                      |
| `src-tauri/src`、`ui`                                             | 原生窗口/系统集成与 TypeScript 浏览器交互。                                   |

Go 功能测试放在包旁。固定查询、事务所有权和校验后的行映射保留在所属 Repository，入口和 HTTP 适配器不接受任意 SQL 或调用者选定的数据库路径。窄接口属于消费者，不增加通用 Repository 或自动 ORM 迁移。

Controller 与 Worker 是编译后程序的独立角色。Controller 不在宿主创建任务 Engine 或执行 Agent 工作。宿主与提供商抽象保留 Windows Hyper-V/VMware 行为；可识别 Unix 宿主能力只是扩展点，不代表 macOS/Linux 桌面版本已经支持。

## 稳定契约与数据

`src/contracts/state-domains.json` 生成 Go 类型化状态与 TypeScript 冻结状态域，`core-protocol.json` 提供共享传输限制。`npm run check:contracts` 检查漂移。运行时解码器仍校验实际消费字段，包括状态值、消息/turn/对话身份，以及缺失、显式 null 和零的区别。共享文字工具保留 ECMAScript trim、UTF-16 预算与受支持旧 JSON 文字；Unicode golden 夹具比较参考实现的归一化和大小写行为。

原 API 路由、`X-Dant-Token`、origin/host 校验、原生 IPC、`4317` 应用 API、`4320` 桌面 bridge 与认证 SSH 转发保持不变。Token 鉴权本地 HTTP，SSH 加密宿主到 VM 的通道。Worker 仍在有图形桌面的 Linux VM 内使用普通用户运行。更换语言实现不增加权限。

切换保留原位置与身份：

| 数据权威                     | 保留契约                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `state.json`                 | 消息、持久任务、提交/续作回执、时间戳、可空值及支持的旧字段。                           |
| `memory/dant/memory.sqlite`  | Schema 1、笔记、项目、条目、修订触发器、确认/冲突规则与 FTS5。                          |
| `schedules/schedules.sqlite` | 调度、创建请求删除记录、执行时间认领，以及 prepared/materialized/held/handed-off 回执。 |
| 文件、Skills 与凭据          | 不可变附件 ID、支持文件、私有 vault 路径和加密封装。                                    |
| 备份与 Codex home            | 原归档格式和来源身份，按备份契约排除模型认证。                                          |

激活后 Go Memory Store 是唯一生产写入者。它在自身 SQLite 事务内同步过期 FTS，并在复用缓存前检查 revision。自动召回先按对话/任务过滤，再排序和限制数量；二次检查确认状态和来源，对参考脱敏并限制 UTF-16 长度。它把相关记忆附加到已准入的输入，不能授权工作。候选和冲突条目在显式确认前不参与召回。

Scheduler SQLite 认领与 JSON 消息屏障仍是独立持久写入。先落准确消息 ID，再提交禁止重放的交接回执。入队确认丢失不能创建另一份派发，恢复保留暂停/未知状态和原 ID。续作 Supervisor 与 Scheduler 都经过同一个 Engine 准入所有者，定时器不创建第二个执行器。

SQLite 使用固定版本的纯 Go `modernc.org/sqlite`、有界忙等待、`synchronous=FULL` 与 DELETE journal。更换运行时语言不改变 schema，也不启用 WAL。后续 schema/journal 变化需要单独的备份与兼容策略。

## 旧 Node Worker 切换到 Go Worker

这个边界由安装器负责，因为仅靠 Go mutex 或数据根锁，不能证明旧 Node 执行器已经停止。

1. Controller 在上传 Linux 程序和辅助文件前，校验版本、源码提交、固定路径、长度与哈希。
2. `vm/worker-install.py` 取得内核安装锁并记录安装阶段。当前维护协议阻止新准入；只有确认属于旧版本路由时，才沿用原保护与停止进程证明。
3. 安装器停止旧用户服务，并确认服务和所属 Codex 进程结束。停止结果未知时不继续切换。
4. 安装经验证的 Go 程序与 Go 服务定义，创建私有恢复归档，并在离线 `prepare-worker` 打开或迁移原数据前校验归档。准备阶段不启动模型、调度或 Telegram 派发。
5. 新 Worker 在开启实时服务前取得数据根独占所有权。版本和源码证明匹配后，才把部署记录为当前。

失败时保留数据、私有归档及明确的未确认安装回执。不对已准备的数据重新启动旧 Node Worker，也不重放未知操作。恢复前须独立核对实际状态并持有独占所有权。备份恢复同样先校验归档、暂停任务/调度、禁用 Telegram，并使用原目标绑定的回执协议。

Worker 在打开 Store 或 Memory 前还会检查 `install-attempt.json`，独立启动服务及系统重启也不能跳过。`reserving`、`stopping` 和 `preparing` 阶段禁止启动实时服务。离线准备只有在归档认证和全部准备步骤成功后才写入 `worker-preparation.json`，绑定本次尝试、版本、源码提交、已验证 bundle、准确的数据/工作区根目录，以及归档身份与哈希。`activating` 必须同时持有该回执和未变化的恢复归档；`committed` 保留回执并允许正常清理旧归档，不会每次启动都扫描数 GB 备份。受管 `app` 符号链接只能指向准确的已验证发布目录。完全不存在安装日志时，仍明确兼容首次或手动安装；损坏或不完整日志不能走这个例外。

## 构建、资源与开发

工具与 CI 固定 **Go 1.27.2**，关闭自动选择工具链。生产二进制使用 `CGO_ENABLED=0`、`-trimpath` 和显式版本/源码构建信息。`buildCore` 要求已提交且干净的工作树，校验预期 CI 提交，并在编译后再次检查。不能把脏源码标成另一个干净提交。

`npm run package:resources` 构建 TypeScript UI 并准备以下校验资源：

- 根目录 `dant-core.exe`，供 Windows Controller 使用。
- `resources/core/dant-core-linux-amd64` 及固定 VM 辅助文件 bundle manifest。
- UI、固定宿主/VM 辅助文件、协议 JSON 和许可证。
- 绑定版本、源码提交和 SHA-256 的构建清单及完整资源清单。

不打包后端 TypeScript 目录、`node_modules`、Node 程序、`.env` 或运行数据。原生宿主启动编译后的 Go Controller，只接受匹配的 runtime/version/source 标记。生产环境没有 Node 回退。Python 桌面辅助工具和 Codex App Server 继续保留各自职责。

提交已审查的改动后，先运行 `npm run package:resources`，再用 `npm start` 启动经校验的 Go 后端。`npm run dev` 使用同一份准备好的后端与 Vite。启动器不会暗中重编译脏源码或运行 `src/server.mts`。工具要求见[运行支持](runtime-support.md)，门禁见 [CI](ci.md)。

## 兼容证据与剩余验收

原只读 Memory 影子角色保留为显式测试工具：有界 stdio 帧、四个 worker、有界队列、取消与修订检查，不具有执行能力。TypeScript owner 生成脱敏夹具投影，Go reader 比较作用域、排名、可空元数据、摘录和分数。影子结果不会进入生产上下文，生产召回直接使用 Go Store。

`npm run test:core:parity` 保留隔离参考比较，覆盖 CJK、NFKC 展开、UTF-16 边界、来源隔离和 SQLite 整数值 REAL 时间戳。其他 Go 夹具验证写入、冲突、重启/派发阶段、通话、未知结果、备份恢复和传输取消。保留的 TypeScript 测试是兼容基准或浏览器/工具测试，不是第二套实时后端。

运行固定格式化、`go vet`、全部包测试与 Linux race 检查，同时保留严格 TypeScript、原覆盖率、Python VM 辅助、Rust、版本与发布完整性门禁。源码测试通过不能证明打包原生启动、真实 VM 更新/恢复、音频、Telegram 送达或桌面任务成功。这些必须使用验证后的产物单独记录验收；本文不代表已安装或发布成功。
