# Go Core

[English](../go-core.md) · Chinese

dant 使用 **Go Core + Rust Tauri + TypeScript UI**。Go 可执行文件分别运行 Windows Controller 和 Linux Worker；Rust 负责 Windows 原生集成，TypeScript 负责浏览器交互和开发工具。参见[系统架构](architecture.md)、[运行支持](runtime-support.md)和[测试](testing.md)。

Codex App Server 负责模型推理、工具迭代及持久模型对话。dant Engine 负责执行准入、持久任务、确认、资源所有权和交付。记忆、调度及其它事件来源都使用同一执行准入路径。

## 模块归属

| 包                                                       | 职责                                                      |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `core/cmd/dant-core`、`core/internal/application`        | 校验进程角色、组装依赖、取得所有权并等待退出完成。        |
| `controller`、`computer`、`platform`                     | 宿主配置、提供商、SSH 转发、部署、VM 生命周期和离线视图。 |
| `app`、`work`、`runtime`                                 | 已鉴权的 Worker API、单执行准入、任务连续性和 Codex RPC。 |
| `store`、`history`                                       | 对话文件、持久任务身份、通话输入、已读状态和交付回执。    |
| `memory`、`schedules`                                    | SQLite 记忆、修订感知召回、重复任务和派发屏障。           |
| `voice`、`telegram`                                      | 通话、媒体、转录、字幕和配对消息。                        |
| `files`、`skills`、`security`、`backups`、`updates`      | 校验后的文件字节、技能、凭据、加密归档和更新。            |
| `config`、`contracts`、`i18n`、`settings`、`diagnostics` | 校验配置、共享传输类型、本地化、偏好和有界运维记录。      |

Controller 不在宿主创建任务 Engine，也不执行 Agent 工作。Worker 以普通用户运行在图形化 Linux VM 内。提供商抽象支持 Windows Hyper-V 和 VMware 工作流；仅具备 Unix 宿主抽象，不代表支持 macOS/Linux 桌面发行版。

入口保持精简，窄接口属于消费者，阻塞操作把 `context.Context` 放在首位。固定查询、事务和校验后的行映射由所属功能管理。goroutine 必须有明确的所有者、上限、取消和等待退出机制。

## 契约与数据权威

`resources/contracts/state-domains.json` 生成 Go 和 TypeScript 状态域；协议默认值位于 `resources/config/`，语言资源位于 `resources/i18n/`。`npm run check:contracts` 检查生成漂移。解码器校验实际消费字段，并区分缺失、显式 null 和零。共享文字边界明确 Unicode 规范化、trim 和 UTF-16 限额。

应用 API 使用本机 `4317` 端口、会话令牌及 host/origin 校验；SSH 提供宿主到 VM 的已鉴权隧道。Worker 桌面 bridge 默认使用本机 `4321`。切换语言、读取记忆或收到定时事件均不能授予执行权限。

| 持久数据权威                 | 契约                                                       |
| ---------------------------- | ---------------------------------------------------------- |
| `state.json`                 | 消息、持久任务、提交／继续回执、时间戳及受支持的保存字段。 |
| `memory/dant/memory.sqlite`  | 笔记、项目上下文、结构化条目、修订触发器和 FTS5。          |
| `schedules/schedules.sqlite` | 任务、创建请求墓碑、发生次数声明和派发回执。               |
| 文件与 Skills                | 稳定附件 ID、经验证的字节和完整技能目录。                  |
| 凭据与备份                   | 私有存储、加密封装及已认证的恢复归档。                     |

SQLite 使用固定版本的纯 Go `modernc.org/sqlite`、有界繁忙等待、`synchronous=FULL` 和 DELETE journal。修改 schema 或日志方式需要明确的兼容和恢复策略。导入受支持的早期数据格式前，必须校验并备份；保留身份及已有时间戳，不补造缺失值。

记忆在复用有界缓存前检查持久修订。召回先限定作用域，再排名和限额，核对已确认状态及来源，脱敏并遵守输入预算。它给已准入任务提供上下文，不负责启动或授权任务。

调度声明与 JSON 消息是两次独立持久写入。先保存固定消息身份，再提交不可重放的交接回执；确认缺失时保留不确定状态。重启和恢复保持未完成工作为暂停或未知，直到所属操作被核对。

## 安装与恢复

1. 校验目标版本、源码提交、固定 bundle 路径、长度和 SHA-256。
2. 取得安装锁和持久尝试身份，在停服务前按实际文件系统检查捕获、归档、校验及准备空间。
3. 预约维护、暂停准入，并确认服务及所属执行器进程已经停止；停止未确认时阻止安装。
4. 生成完整私有恢复归档，在离线 `prepare-worker` 打开或更新已有数据前认证归档。准备不启动模型、调度或 Telegram 交付。
5. 将成功准备绑定到准确尝试、源码、bundle、数据／工作区根和备份；仅激活该 Worker，确认实际角色、协议、版本及源码后才标记部署完成。

`install-attempt.json` 同时约束独立服务启动与重启。`reserving`、`stopping` 和 `preparing` 不能打开在线服务；`activating` 要求匹配的 `worker-preparation.json` 与未变化的恢复归档；`committed` 保留准备证明，同时允许正常备份保留策略。受管理的 `app` 链接必须指向经验证的发行目录。格式错误或不完整日志不能成为首次安装例外。

失败或未知操作保留日志与归档，不授予重放权限，也不能对已准备数据再启动另一个执行器。显式 `reconcile-stopped` 操作仅接受符合条件的准备前中断，要求准确尝试 ID、原日志哈希、经验证的源码清单、停止证明和安装锁。创建新尝试前保留原始证据；自动连接检查不会调用它。

恢复首先认证归档和目标，暂停未完成工作与调度、禁用 Telegram 交付并保留未知结果。参见[备份](backups.md)和[更新](updates.md)。

### 早期导出格式

`--role=legacy-import --source-dir <absolute-export> --data-dir <absolute-empty-target>` 导入受支持的早期 `manifest.json`、`state.json` 与 `files/<id>` 格式。它与便携备份恢复分开，不启动服务、模型或调度器。

目标必须为空并具有独占所有权。导入器保留来源证据，对可用附件仅建立一次映射，清除活动宿主连接凭据，并保持未完成任务暂停。缺失身份和时间戳不得补造。发布前先保存持久意图；只有来源和完整输出认证不变时才能幂等成功，部分或变化的输出需要协调恢复。

该格式限制为每文件 10 MiB、1,000 个不同文件、附件合计 512 MiB、state 128 MiB 和 manifest 64 KiB。这些限额仅适用于该导入角色，不是当前 VM 备份限额。

## 构建与验证

工具和 CI 固定使用 Go **1.27.2** 及 `GOTOOLCHAIN=local`。生产程序以 `CGO_ENABLED=0`、`-trimpath` 和明确版本／源码信息构建。构建要求干净的已提交源码，编译后再次核对源码身份。

`npm run package:resources` 构建 UI 并准备 Windows `dant-core.exe`、Linux Worker、固定宿主／VM 辅助文件、许可证及来源清单，不包含秘密或运行数据。原生宿主只接受与 bundle 的运行时、协议、版本和源码匹配的 Controller。

提交已审查源码后准备资源，再使用 `npm start`、`npm run dev` 或原生桌面启动器。已准备清单必须匹配待启动源码；后台资源变化后必须重新构建。

全部 Go 测试位于镜像完整包路径的 `tests/go/`。使用 `npm run check:core`、`npm run test:core`，以及具备 C 编译器的 Linux 上的 `npm run test:core:race`。显式编译器 overlay 保留包内私有访问并校验递归发现；从 `core/` 裸运行 `go test ./...` 不会发现外部测试树。

源码检查、产物完整性和真实设备验收是独立步骤，所需证据见[测试](testing.md)、[CI](ci.md)和[验收](verification.md)。
