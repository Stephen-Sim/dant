# 测试

[English](../testing.md) · Chinese

测试按生产职责归属：Go 验证 Core 行为，TypeScript 验证浏览器与构建工具，Rust 验证原生行为，Python／PowerShell 验证 VM 辅助工具。测试使用合成数据和注入服务，不连接已配置 VM、真实模型、麦克风或 Telegram 账号。

## 目录与入口

| 目录                             | 职责                                                      |
| -------------------------------- | --------------------------------------------------------- |
| `tests/go/<package>/`            | Go 行为、持久化、并发及失败测试，镜像 `core/<package>/`。 |
| `tests/ui/<feature>/`            | 浏览器渲染、交互和传输校验，镜像 `ui/<feature>/`。        |
| `tests/tooling/<module>/`        | 构建、配置、生成契约、Go 工具和 CI 脚本。                 |
| `tests/native/`                  | 浏览器／原生集成契约；Rust 行为测试同时通过 Cargo 执行。  |
| `tests/vm/`                      | 隔离的 Python 和 PowerShell VM 辅助工具验证。             |
| `tests/support/`、`tests/types/` | 公共合成夹具和编译期契约。                                |

保持递归发现。`npm test` 与 `npm run test:coverage` 使用同一份维护中的 TypeScript 测试清单。Go 命令校验每个镜像测试映射，并显式传递 `-overlay`，保留包内私有访问和平台后缀，不为测试导出内部接口。从 `core/` 裸运行 `go test ./...` 不会发现 `tests/go/`。

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

浏览器总体要求 **90% 行、80% 分支、80% 函数**，appearance 单模块至少 90% 行，全部维护中的 UI helper 必须出现。Go 语句和浏览器行是独立指标，不合并。浏览器入口另有 DOM／渲染／事件夹具；百分比不能代替布局或打包后原生窗口验证。

使用精确 Go **1.27.2**、声明的 Rust 工具链、锁定的 npm 依赖及受支持的 Node 原生 TypeScript 基线。完整检查：

```powershell
npm run format:check
npm run typecheck
npm run check:states
npm run check:contracts
npm run check:core
npm run test:coverage
python -m unittest discover -s tests/vm -p "test_*.py" -v
cargo test --manifest-path src-tauri/Cargo.toml --locked
node scripts/ci/preflight.mts
pwsh -File scripts/ci/check-powershell.ps1
node scripts/ci/version.mts
npm run build
```

修改维护文件时使用 `npm run format`。工作中执行定向测试，集成前完成全部相关门禁。缺少工具、平台专用排除和实际失败必须如实报告，不能称为通过。

源码检查、发行产物校验和真实设备验收彼此独立，参见 [CI](ci.md)和[验收](verification.md)。
