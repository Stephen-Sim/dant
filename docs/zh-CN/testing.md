# 测试

[English](../testing.md) · Chinese

测试按生产职责归属：Go 验证 Core 行为，TypeScript 验证浏览器与构建工具，Rust 验证原生行为，Python／PowerShell／Bash 验证 VM 辅助工具。测试使用合成数据和注入服务，不连接已配置 VM、真实模型、麦克风或 Telegram 账号。

## 目录与入口

| 目录                             | 职责                                                      |
| -------------------------------- | --------------------------------------------------------- |
| `tests/go/<package>/`            | Go 行为、持久化、并发及失败测试，镜像 `core/<package>/`。 |
| `tests/ui/<feature>/`            | 浏览器渲染、交互和传输校验，镜像 `ui/<feature>/`。        |
| `tests/tooling/<module>/`        | 构建、配置、生成契约、Go 工具和 CI 脚本。                 |
| `tests/native/`                  | 浏览器／原生集成契约；Rust 行为测试同时通过 Cargo 执行。  |
| `tests/native/rust/`             | 原生 Rust 行为模块，通过私有 `#[cfg(test)]` 路径引入。    |
| `tests/powershell/`              | Pester 行为及命令覆盖率，宿主／VM／设备边界全部模拟。     |
| `tests/vm/`                      | 隔离的 Python 和 PowerShell VM 辅助工具验证。             |
| `tests/support/`、`tests/types/` | 公共合成夹具和编译期契约。                                |

保持递归发现。`npm test` 与 `npm run test:coverage` 使用同一份维护中的 TypeScript 测试清单。Go 命令校验每个镜像测试映射，并显式传递 `-overlay`，保留包内私有访问和平台后缀，不为测试导出内部接口。从 `core/` 裸运行 `go test ./...` 不会发现 `tests/go/`。

两个 Node 入口在 Windows 上逐个运行维护中的测试文件，其他平台最多同时运行四个文件。共享调度规则限制 Windows 上 Git Bash、PowerShell 和 Python 夹具短进程之间的资源竞争。全部测试、子进程截止时间和覆盖率要求继续启用。

Rust 运行时模块仅在 `#[cfg(test)]` 下通过明确 `#[path]` 引入外部测试模块，保留私有访问；原生 LLVM 报告测量 `src-tauri/` 运行时及构建源码，测试模块不计入其分母。

## Go Core 行为

| 所有者                                   | 必需行为与失败覆盖                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| Controller、Computer                     | 离线配置、鉴权、准确 VM／连接身份、代理、生命周期、部署和停止未确认。                 |
| Work、Store、Runtime                     | 单准入所有者、持久任务、暂停／取消、继续、凭据等待、RPC 关联和未知结果。              |
| History、Files                           | 对话作用域、已读／交付回执、不可变附件 ID、经验证的字节及目标根目录解析。             |
| Memory                                   | SQLite schema／修订、规范化与多语言搜索、先限定范围再限额、确认、敏感数据边界和取消。 |
| Schedules                                | 发生次数声明、修订、夏令时／补执行、重启恢复和不可重放派发回执。                      |
| Voice、Telegram                          | 通话身份、挂断后任务、字幕、媒体限额、配对所有者授权、交付回执和等待退出。            |
| Skills                                   | 完整文件保留、编辑器／JSON／ZIP 容量、导入、凭据边界和鉴权下载。                      |
| Backups、Application                     | 认证归档、完整暂存捕获、跨根目录恢复、离线证明、激活、回滚和未知结果。                |
| Security、Diagnostics、Settings、Updates | 秘密边界、有界记录、并发持久化、偏好和绑定目标的安装租约。                            |

断言公开结果、持久状态和有界副作用。失败夹具区分已确认失败、取消和执行未知；返回错误本身不能证明外部操作没有发生。不能用贴近实现的小样本替代真实容量、并发或恢复测试。

## 门禁

`npm run check:core` 执行固定工具链格式、vet 及全部 Go 包测试，生成 atomic 语句覆盖率。每个功能包必须实际执行语句；Controller、Computer 和 Telegram 各自至少 **90%**。包缺失、过期 profile 或进程失败不能复用先前结果。Linux CI 另在具备 C 编译器时执行 `npm run test:core:race`。

完整 Go 命令有十分钟预算，最多并行两个包进程，每包最多四个并行用例。每包的整个测试二进制另有预算：**Windows 为 300 秒，其他平台为 120 秒**；这是包内累计时间，不是每个用例或单次 SQLite 写入的截止时间。test、race、coverage 命令及集成 check 均启用详细输出，显示每个已完成用例的耗时。整体超时会使检查失败，不能把部分覆盖率报告当作成功结果发布。

这些预算只用于 CI／工具链。运行时截止时间、完整夹具清单、确定性 memory 排序用例、atomic 全模块覆盖率、固定依赖及 SQLite `synchronous=FULL` 持久性保证保持不变。超时栈只记录截止时正在执行的操作，不能据此确定该操作自身持续了多久，或包预算耗尽的具体原因。

浏览器总体要求 **90% 行、80% 分支、80% 函数**，appearance 单模块至少 90% 行，全部维护中的 UI helper 必须出现。Go 语句、TypeScript 行／分支／函数、Rust LLVM 行／函数／region、Python 行／分支弧的分母不同，不能合并。测试数量、`cargo test` 或 Python unittest 成功本身都不能证明覆盖率百分比。浏览器入口另有 DOM／渲染／事件夹具；百分比不能代替布局或打包后原生窗口验证。

`npm run test:native:coverage` 通过 LLVM 插桩测量 Rust，在 `.cache/coverage/rust/` 保存 JSON、LCOV 和 Markdown。`npm run test:python:coverage` 对全部维护 Python 辅助工具插桩，包含子进程、Go 内嵌的探测资源和零命中文件，无排除行并要求至少 **95% 行、90% 分支**。`npm run test:powershell:coverage` 使用 Pester 5.9.0 测量可执行命令，包含未执行脚本，并要求至少 **95% 命令覆盖率**；命令不是分支，也不对 `Add-Type` 编译的 C# 正文插桩。语音 P/Invoke 和电脑资源文件身份适配器即使经行为夹具执行，仍须单独标为未测嵌入代码。`npm run test:bash:coverage` 在 Linux 通过固定 kcov 43 测量原始 VM shell 脚本；解析不算覆盖率，Windows 不能提供该测量。未测范围必须明示。通过有意义的行为和失败测试接近 100%，不能缩小清单或放宽门禁来抬高比例。参见 [CI 覆盖率报告](ci.md#覆盖率报告)。

使用精确 Go **1.27.2**、声明的 Rust 工具链、锁定的 npm 依赖及受支持的 Node 原生 TypeScript 基线。Windows 构建工具使用当前主机经过校验的 `SystemRoot` 和 `ProgramFiles` 目录，缺失时失败，不猜测盘符。完整检查：

```powershell
npm run format:check
npm run typecheck
npm run check:states
npm run check:contracts
npm run check:core
npm run test:coverage
python -m unittest discover -s tests/vm -p "test_*.py" -v
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run test:native:coverage
npm run test:python:coverage
npm run test:powershell:coverage
npm run coverage:inventory
node scripts/ci/preflight.mts
pwsh -File scripts/ci/check-powershell.ps1
node scripts/ci/version.mts
npm run build
```

修改维护文件时使用 `npm run format`。工作中执行定向测试，集成前完成全部相关门禁。缺少工具、平台专用排除和实际失败必须如实报告，不能称为通过。

源码检查、发行产物校验和真实设备验收彼此独立，参见 [CI](ci.md)和[验收](verification.md)。
