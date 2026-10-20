# 后端测试迁移

[English](../testing-migration.md) · Chinese

生产后端现在由 Go Controller 和 Worker 负责，浏览器测试继续使用 TypeScript。退役旧 Node 后台测试，意味着由实际 Go 模块的行为与失败测试接替其职责；不能把旧后台搬进测试辅助目录，也不能降低门槛。

| 原 Node 测试职责                      | 当前 Go 行为与失败证据                                                                                                                                                                                                                                                                                                                          | 保留的浏览器／工具校验                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Controller API、离线恢复、通知和退出  | [`controller`](../../tests/go/internal/controller/)：离线设置与状态、配置持久化、代理、事件、备份及桌面生命周期契约测试                                                                                                                                                                                                                         | 原生托盘、更新、通话浮层与离线界面状态校验                                                                                      |
| VM 配置档、Provider、部署和暂停屏障   | [`computer`](../../tests/go/internal/computer/)：归属、精确 binding/generation、静止条件、暂停未知结果、已验证安装包和部署时限                                                                                                                                                                                                                  | PowerShell 生命周期隔离用例；`tests/vm/` 中的 Python 安装器与更新 guard                                                         |
| 任务接纳、暂停／取消、续作和凭据等待  | [`work`](../../tests/go/internal/work/)、[`store`](../../tests/go/internal/store/) 与 [`runtime`](../../tests/go/internal/runtime/)：单一执行权、持久 unknown 屏障、取消、Provider EOF 和停止证明                                                                                                                                               | 实际 Go active 快照通过两层浏览器状态／进度解析；任务面板与操作 UI 测试                                                         |
| 历史、引用、置顶／收藏、反应和已读    | [`history`](../../tests/go/internal/history/) 与 [`app/conversation_routes_test.go`](../../tests/go/internal/app/conversation_routes_test.go)：精确作用域、仅元数据变更、删除墓碑、失败编辑和附件已读边界                                                                                                                                       | 聊天历史、集合、在线状态及默认反应 UI 测试                                                                                      |
| SQLite 记忆、搜索、召回、规范化和迁移 | [`memory`](../../tests/go/internal/memory/)：写入生命周期、schema/revision、敏感内容边界及独立 Node golden；[`shadow`](../../tests/go/internal/shadow/) 和 stdio 测试保留只读与协议失败校验                                                                                                                                                     | `test:core:parity` 比较 30 个 prepared 搜索／召回案例和 29 条有序引用，并检查取消、null／未知字段、过期 revision 与快照字节不变 |
| SQLite 定时任务和周期派发             | [`schedules`](../../tests/go/internal/schedules/)：claim／dispatch 屏障、并发、重启恢复、夏令时和补跑                                                                                                                                                                                                                                           | 定时任务编辑、本地化和渲染测试                                                                                                  |
| API／订阅通话、字幕和转写             | [`voice`](../../tests/go/internal/voice/)、[`voice/captions`](../../tests/go/internal/voice/captions/) 及 runtime observer：通话身份、挂断后的已接纳工作、未知输入、临时字幕和有界停止                                                                                                                                                          | 浏览器通话控件、字幕 wire 校验、原生浮层与隔离 Python ASR 用例                                                                  |
| Telegram 配对、指令、附件和镜像       | [`telegram`](../../tests/go/internal/telegram/)：精确私聊归属、持久 receipt、附件字节、指令屏障、暂停／未完成工作和有界安全重试                                                                                                                                                                                                                 | Telegram 设置与投递状态 UI 测试                                                                                                 |
| Skills 库与导入／导出                 | [`skills`](../../tests/go/internal/skills/)、[`skills_transport_test.go`](../../tests/go/internal/app/skills_transport_test.go) 与 [`skills_export_capacity_test.go`](../../tests/go/internal/app/skills_export_capacity_test.go)：81 文件二进制／UTF8 字节往返、8 MiB 单文件／9 MiB 内容／10 MiB ZIP、转义 JSON 预算、大文件尾部凭据及认证下载 | Skill 编辑、导入及导出 UI 测试，浏览器／原生传输边界                                                                            |
| 本机／可移植备份和恢复                | [`backups`](../../tests/go/internal/backups/)、application 激活及 Controller 备份测试：认证归档、来源身份、回滚、未知恢复、空间预检和离线证明                                                                                                                                                                                                   | 浏览器传输使用独立 Go 导出的可移植备份 fixture；Python 安装器用例继续执行                                                       |
| 凭据、诊断、偏好和更新                | [`security`](../../tests/go/internal/security/)、[`diagnostics`](../../tests/go/internal/diagnostics/)、[`settings`](../../tests/go/internal/settings/) 与 [`updates`](../../tests/go/internal/updates/)：秘密边界、持久提交、累计用量和安装租约                                                                                                | 外观可移植性、开发配置、构建／资源完整性、契约和语言目录                                                                        |

记忆与指令 golden 来自 Node **22.23.3** 的合成 fixture，记录源码提交 `d058bdc7509efce90bd9d96cc367b04e11c98bae` 与文件哈希。替代实现由 Go **1.27.2** 执行。Memory runner 仅用冻结的数据行重建私有 SQLite fixture，不保留 `MemoryStore` 或其它 TypeScript 后台实现，也不把旧 Node／Go 计时作为当前性能承诺。

原始[指令 golden](../../tests/support/goldens/work-prompt-node22.json) 作为共享测试数据保留。Go 的 [`instructions_golden_test.go`](../../tests/go/internal/work/instructions_golden_test.go) 校验原始捕获文件的哈希与来源信息，逐一比较包含数值类型、数组顺序的工具权限 schema，并核对完整指令模板的字节。这些资产等价测试归属 Go Work 包，不再保留单独的 Node 测试。

共享浏览器契约、语言目录、源码 fixture 辅助函数及构建／开发配置继续进行 TypeScript 检查。旧 Node 关键模块的覆盖率职责转交实际 Go 功能测试；格式、类型、生成契约、状态、必需覆盖率及 Windows／Linux Go 检查继续启用。最终退役后必须重新完整集成验证，先前的定向通过不能替代它。

## 已验证的退役边界

最终退役在 Go 行为与失败测试实际通过后执行。[`legacyimport`](../../tests/go/internal/legacyimport/) 验证 `TestImportArchivesLegacyFilesOncePreservesOriginalTextAndIsAuthenticatedIdempotent` 和 `TestImportRefusesAuthoritativeAndAmbiguousTargetsWithoutOverwritingThem`，并覆盖二进制／缺失文件、部分发布屏障、未知旧值和认证回执。[`application/legacy_import_test.go`](../../tests/go/internal/application/legacy_import_test.go) 证明显式离线角色不构造服务或 Engine。完整容量 Skill／编辑资产保留及真实 HTTP JSON／ZIP 传输边界也已由 Go 模块实际验证，小文件往返没有被当成等价证据。

逐文件映射与本机执行证据保存在忽略的 `.cache/core/retired-node-tests.json`；本页把可审查的功能级理由保存在 Git 中。测试 fixture 不连接真实 VM、不请求真实模型或 Telegram、不使用麦克风，也不读取用户数据。

## 当前测试归属

| 目录                                                    | 职责                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `tests/go/<package>/`                                   | 通过显式 overlay 编译的 Go 行为、持久化、协议、权限及失败路径测试。                 |
| `tests/ui/<feature>/`                                   | TypeScript 浏览器行为与渲染测试。                                                   |
| `tests/tooling/{build,config,contracts,core,computer}/` | Node 构建／开发工具、CI 校验、生成契约、记忆 parity runner 及隔离宿主脚本 fixture。 |
| `tests/native/`                                         | Rust／原生边界的 Node 校验；Rust 单元测试仍由原生编译器负责。                       |
| `tests/vm/`                                             | 使用隔离 fixture 的 Python VM 与安装器测试。                                        |
| `tests/support/`、`tests/types/`                        | 公共 fixture、冻结的独立 golden 及编译期契约。                                      |

`npm test` 和 `npm run test:coverage` 递归发现全部维护中的 Node 测试，包括从 `scripts/ci/` 移出的 CI 工具测试。CI workflow 保留显式校验步骤并改用新路径。`npm run test:core:parity` 执行 `tests/tooling/core/memory-parity.mts`；源码指纹跟随新路径，历史 oracle 来源记录保持原样。移动文件不改变行为或必需覆盖率门槛。
