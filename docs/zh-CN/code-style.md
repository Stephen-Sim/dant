# 代码组织与格式

[English](../code-style.md) · Chinese

本规范适用于仓库中的新代码和被修改的代码。[AGENTS.md](../../AGENTS.md) 将其作为仓库工作要求。

## 按功能组织模块

运行时模块按职责放入 `src/` 的功能目录，浏览器模块按功能放入 `ui/` 的目录，文件名应明确表达用途。入口负责组装应用；传输、持久化、渲染和业务逻辑放在各自模块。共享契约可以供多个运行时使用，但不能依赖它们的入口。

| 目录                                                               | 职责                                                |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| `src/app/`、`src/runtime/`                                         | 应用组装、Controller/Worker 服务、进程与 RPC 边界。 |
| `src/work/`、`src/conversation/`                                   | 任务执行、续作、计划、对话和持久状态。              |
| `src/computer/`、`src/files/`、`src/voice/`                        | VM/桌面操作、附件与交付、音频和通话。               |
| `src/telegram/`、`src/security/`、`src/skills/`、`src/schedules/`  | 对应集成或业务功能。                                |
| `src/config/`、`src/settings/`、`src/updates/`、`src/diagnostics/` | 校验后的环境配置、偏好、版本与更新、运行元数据。    |
| `src/i18n/`                                                        | 语言注册表、共享翻译工具与语言目录。                |
| `ui/chat/`、`ui/call/`、`ui/work/`、`ui/schedules/`、`ui/files/`   | 浏览器功能及其渲染、交互模块。                      |
| `ui/settings/`、`ui/platform/`、`ui/shared/`、`ui/i18n/`           | 设置界面、原生适配、共享浏览器基础模块、本地化。    |

为保留现有启动和打包契约，稳定的 `src/server.mts` 启动入口和浏览器入口文件可以留在各自源码根目录。

浏览器渲染状态并提交经过校验的用户操作；Windows Controller 管理宿主机配置、VM 连接和请求转发；Ubuntu Worker 拥有任务 Engine 和持久工作状态；Tauri 负责 Windows 原生集成。提取或移动模块时必须保留这些边界，详见[架构文档](architecture.md)。

移动文件时一并修改导入、打包白名单、测试夹具、覆盖率路径、命令和文档链接。保留已有数据位置与公开接口；需要改变时必须同时提供明确迁移。避免循环依赖，不要用无边界的工具目录混放各功能逻辑。

测试目录也按模块对应：后端测试放在 `tests/work/`、`tests/conversation/`、`tests/computer/` 等目录；界面测试放在 `tests/ui/chat/`、`tests/ui/settings/` 等对应目录。公共夹具放在 `tests/support/`，编译期契约放在 `tests/types/`，Python VM 测试放在 `tests/vm/`。`npm test` 和覆盖率检查使用同一个递归发现模块，移动目录不能漏跑测试。单独执行时使用完整路径，例如 `node --test tests/work/task-cancel.test.mts`。

已采用的 Go 核心包放在 `core/internal/<feature>/`，行为测试 `*_test.go` 与实现放在同一个包中。相关 TypeScript 工具放在 `scripts/core/`，工具的 Node 测试放在 `tests/core/`。新增 Go 包本身不会切换应用运行时；迁移必须保留现有 Controller、Worker、浏览器与认证传输边界。

## 格式化命令

使用 `npm ci` 安装锁定的 JavaScript 依赖。格式化采用 `package-lock.json` 锁定的 **Prettier 3.9.10**，以及 Rust 的 `rustfmt` 组件。Windows 构建工作流指定打包工具链；运行 Rust 格式检查前，为该工具链安装 `rustfmt`。

```powershell
npm run format
npm run format:check
```

`format` 格式化 Prettier 支持的源码和文档，然后执行 `cargo fmt` 和固定版本的 Go 格式化工具。`format:check` 只检查这三者，不修改文件。局部操作可使用 `format:prettier`、`format:prettier:check`、`format:rust`、`format:rust:check`、`format:go`、`format:go:check`。使用这些本地命令，不依赖默认配置不同的全局格式化工具。

Prettier 处理 JavaScript、TypeScript、JSON、CSS、HTML、Markdown 和 YAML。`.prettierrc.json` 规定两个空格、分号、JavaScript 单引号、尾逗号、100 列目标宽度与 LF，同时保留正文现有换行。`.editorconfig` 规定 UTF-8、末尾换行；Python、Rust、PowerShell 使用四个空格。Python、PowerShell 和 Bash 继续执行现有语法检查和行为测试，不引入未声明的格式化依赖。

Go 源码严格使用 **Go 1.27.2** 及其附带的 `gofmt`，采用 Go 的制表符缩进。`scripts/core/go.mts` 优先使用 `.tools/go1.27.2/go/bin` 中的固定工具，否则校验 PATH 中的 Go；格式化或测试前会拒绝其他版本。它固定设置 `GOTOOLCHAIN=local`，检查不能暗中选择或下载另一套编译器。工具缺失时须明确安装这个版本的官方工具链。独立核心 CI 在 Windows 与 Linux 使用相同版本。

`.gitattributes` 让自动识别的文本在所有平台（包括 Windows CI）保留 LF；Git 的二进制识别会保持图片等二进制文件不变。

`.prettierignore` 排除生成产物、缓存、安装依赖、私有运行数据、环境文件和生成的锁文件格式。`package-lock.json` 仍由 Prettier 检查。不得通过排除维护中的源码或添加 formatter-ignore 注释消除失败。

## 配置与常量

环境选项统一通过共享配置模块读取，在该边界解析、校验并给出有文档的默认值，然后传给对应模块。不要在各功能中散布 `process.env` 读取。`.env.example` 只记录非秘密示例和空的秘密占位，真实值放在忽略的本地配置或已有安全凭据设施中。

协议限制、合法标识、权限白名单和固定错误码属于代码常量。放在功能旁；多个运行时确实需要相同值时，放入共享契约。不能为了减少常量而将安全约束变成可随意配置的环境项。日志和错误不得包含秘密或未限制长度的进程输出。

本地 JSON 持久化需要处理 Windows 文件锁时，复用共享的原子文件替换模块，重试策略使用命名常量并保持次数上限。下一次尝试前必须重新确认源文件、目标文件和目录身份；文件变化或无法确认时停止重试。这个模块不重试任务执行、网络请求或其他外部操作。

## 语言与用户内容

统一使用共享语言注册表和本地化层。语言代码、自称、方向与 locale 元数据只有一个来源。界面固定文案翻译保留占位符，日期和数字使用所选 locale。控件必须有可访问名称并支持键盘，包含从右到左的布局。

用户消息、任务名称、项目记忆、文件等内容保留原文。切换界面语言不翻译历史，也不授予新的工作权限。

## 命名状态与 TypeScript 契约

状态统一引用 `src/contracts/states.mts` 中冻结的运行时枚举。键名采用 UpperCamelCase，例如 `TaskStatus.Running`、`TaskPriority.Normal`、`PlanStepStatus.InProgress`，序列化值保持已有字符串。不要把持久状态换成数字序号或翻译后的显示文案。任务、提交、续作、连接、升级分别属于不同状态域；任务标记为暂停不等于执行器已经停止，结果未知的提交也不能视为可安全重试的失败。

`ChatTaskStatus` 与 `WorkStatus` 有意区分：聊天任务沿用原来的允许状态；持久任务可在两个执行回合间保持 `continuing`，或在核对结果时保持 `unknown`。旧显示值仍由原兼容边界处理。接受未知输入时使用 `isEnumValue(domain, value)` 校验，明确拒绝或保留未确认结果，不要凭空补出安全状态。

`src/contracts/contracts.ts` 定义共享边界结构；各功能专用的类型放在所属模块旁。浏览器代码、Node 应用模块、工具和 Node 测试使用 TypeScript；已采用的 Go 核心包使用 Go 的静态类型。运行时 TypeScript 模块使用 `.mts`；纯类型文件使用 `.ts`，并通过 type-only import 引入。生成的浏览器 bundle、第三方文件和用户文件测试夹具中的 JavaScript 保留原格式。

`src/contracts/state-domains.json` 统一拥有跨运行时的状态词表。`npm run generate:contracts` 生成 TypeScript 与 Go 契约；`npm run check:contracts` 使用固定格式化工具核对生成内容。不能单独维护另一套 Go 线值，也不能分别手改生成文件。Go 边界同样必须拒绝未知状态，保留任务身份、旧数据兼容和明确的未确认语义。功能专属 Go 类型留在对应包内。依赖由 `core/go.mod` 与 `core/go.sum` 固定，变更须有意进行并经过审查。

持久化放在所属功能的 Repository 内。固定的参数化查询、事务归属和经校验的行映射，与应用策略分开；不要把 SQL 或数据库行传给入口或渲染器。重复使用的可选作用域值使用命名绑定。授权条件、持久化文档名、确认规则和 schema/revision 校验是代码不变量，不属于用户可修改的配置。优先提供具体功能操作，避免通用 CRUD 抽象。只有在证明收益及 SQLite、FTS、schema 兼容性后才引入 ORM 或 SQL 生成器；运行时语言迁移期间不能启用自动 schema 变更。

固定版本编译器开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 和 `noEmit`。`npm run typecheck` 依次检查三个工程：Node 入口与工具、Vite 浏览器应用、全部 Node 测试。Node 使用 `NodeNext` 解析；浏览器和混合浏览器测试使用 `Bundler`，对应实际依赖包入口。声明文件检查保持开启。编译夹具包含必须始终被拒绝的非法状态。`npm run check:states` 对已接入的 Store、计划、续作、调度器、桌面生命周期与 VM 生命周期模块禁止原始状态字面量。各模块明确适用的状态域，避免将无关品牌名或外部协议字段误判为状态；迁移其他域时同步扩展检查名单。

运行时 TypeScript 使用可擦除类型的 `.mts`，要求 Node 22.18+ LTS 或 24+。预检和打包会执行有时间上限的探针，确认原生 TypeScript、内置 SQLite 和 FTS5 查询可用；VM 安装器在改变现有运行时或服务前检查相同能力，不兼容时保留原状并报告 `runtime-incompatible`，维护升级运行时后再重新连接。迁移必须补齐严格类型、引用、打包和行为测试，再移除旧实现；不允许用 `any`、跳过检查或仅改后缀代替迁移。Vite 负责转换，独立类型检查门禁必须保留。

磁盘 JSON 和传输返回值先按 `unknown` 处理，由所属边界验证实际消费的字段。兼容旧记录缺失的字段，不生成虚假的任务标识、执行确认或时间。注入服务按消费者实际使用的能力定义接口，不要求具体实现的私有字段，也不让事件监听方法的返回值绑定到完整具体类。

需要提取源码的测试通过 `tests/support/source-fixtures.mts` 擦除 TypeScript 注解，再使用 JavaScript AST 定位声明和事件绑定。VM 执行选定的源码夹具前同样擦除类型。CSS 断言视图通过 PostCSS 规范空白，保留带引号选择器、颜色写法和属性值；不要依赖固定空格或单个物理行来提取函数。

DOM 测试仅使用 LinkeDOM 的公开 `parseHTML` 入口。`tests/types/linkedom.d.ts` 保留该入口原有的公开返回类型，并将输入限定为 HTML 字符串。这个明确边界隔离了上游内部 DOM 类声明的兼容问题，仓库和其他依赖的声明文件检查保持开启。

## Go 包与接口

每个 `core/internal/<feature>` 包负责自己的策略与数据访问。小型 `cmd` 入口只解析经校验的启动选项、组装依赖和管理进程退出，不承载查询、映射或协议实现。默认使用具体类型；只有消费者需要可替换边界时，才在消费方定义只包含实际所需操作的窄接口。避免提供方拥有的万能接口、通用 `BaseRepository` 层，以及混放无关功能的 `common` 或 `utils` 包。

阻塞或可取消操作以 `context.Context` 为第一个参数，将请求截止时间传递到 SQL 与子工作，不能在调用链内部替换成后台 context。长期 context 由最外层组装代码拥有。使用 `errors.Is` 和 `errors.As` 分类已包装的错误；只有所属边界能安全保留内部原因时才包装它。传输错误仅暴露固定且经校验的错误码，不包含 SQL、路径、查询正文或原始原因。取消一个请求时，仍须保留“执行停止”和“持久任务尚未完成”的区别。

每个 goroutine 都必须有归属与退出路径。限制 worker、队列、输入输出帧、截止时间和会话生命周期，退出时取消并等待 worker 完成。所有路径都释放 rows、statement、事务和文件。明确保护共享状态，并在异步工作中保持精确的请求、快照和 revision 身份。超时或缺失回复不能成为重放结果未知操作的理由。

所属 Repository 使用固定的参数化 SQL，将数据库行映射到经校验的功能类型。JSON 边界可以临时使用 `map[string]json.RawMessage` 检查合法字段，再解码到类型明确的 DTO；不能把无类型 map 当作应用内部的数据模型。契约区分缺失、显式 null 和零时，使用指针或功能专属的可空类型明确表示。迁移须保留已有 Unicode、数值精度、顺序、作用域及旧线协议语义，不能暗中归一化。

行为与失败路径测试采用 table-driven 方式，放在包旁。进程或存储边界使用隔离 SQLite 夹具与注入的窄接口，保留取消、并发和清理检查。已采用的门禁仍是固定版本的 `gofmt`、`go vet`、包测试与 Linux 竞态检测。只有证明有必要、固定可复现版本，并补齐本机和 CI 命令时，才引入其他 linter 或生成器。

## 验证与副作用

格式和行为分别检查。实施中运行相关测试；交付集成变更前完成 [AGENTS.md](../../AGENTS.md) 列出的检查。[CI](ci.md) 在测试 runner 检查 Prettier，在 Windows 打包 runner 构建前检查 Rust 格式。

`npm run check:core` 检查 Go 格式、运行 `go vet ./...`，并测试全部核心包。`npm run test:core` 运行包测试；`npm run test:core:race` 还会在 Linux 使用可用的 C 编译器运行竞态检测。核心 CI 在 Windows 与 Linux 执行检查，并在 Linux 增加竞态检测；缺少前提条件是失败，不能忽略测试。核心测试必须使用隔离数据与注入依赖，不得连接真实模型、操作 VM 或读取用户账号数据。

`npm run test:core:parity` 明确以 `CGO_ENABLED=0` 构建只读影子工具，创建私有临时记忆夹具，对比权威 TypeScript 搜索／召回结果与持久 Go IPC 读取器。仅分数允许绝对 `1e-10` 误差，其他引用字段和顺序必须完全一致。它分别记录两个运行时各 200 次顺序读取的实验 p50／p95 统计，不保证性能提升；输出只含统计，不含夹具正文。普通 Node 测试发现不会启动这个依赖 Go 的工具，核心 CI 会显式执行。

测试使用夹具、注入时钟与传输、临时数据。不得连接真实模型账号或 Telegram bot、操作用户 VM 或使用真实音频设备。保留精确的任务和连接身份、持久状态，以及结果未知时先核对而不重发的规则。不得为通过重构而关闭检查或降低覆盖率要求。
