# 运行支持

[English](../runtime-support.md) · Chinese

运行架构为 **Go Controller + Go Ubuntu Worker + Rust Tauri 宿主 + TypeScript UI**。源码检查、产物完整性和真实设备验收分别要求证据，参见[验收](verification.md)。

## 安装后的应用

| 组件             | 要求与职责                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| Windows 桌面     | Tauri 2、Windows WebView2、打包的 `dant-core.exe`、固定宿主辅助文件及已配置可用的 VM 提供商。   |
| Ubuntu Worker    | 打包的 Linux amd64 Go 程序、VM 普通用户、systemd 用户服务、可用图形桌面和 Python 桌面辅助工具。 |
| Codex App Server | 独立安装的固定版本 Codex CLI、原有认证账号/配置和 stdio JSON-RPC；负责推理与工具迭代。          |
| 传输             | 已鉴权的 loopback API 和 SSH 转发；只有 SSH 不代表拥有可挂起/恢复的 VM 提供商。                 |
| 数据             | 原状态文件、SQLite 记忆/调度、Skills、工作区和受保护秘密；不需要外部数据库服务。                |

安装后的 Core 使用打包 Go 程序，不加载 `.env.example`。本地 `.env` 可选，缺失时使用经验证的默认值。Codex 安装或用户编写工具可能独立要求 Node/npm。

Windows 仍是桌面发布目标。HostPlatform/VMProvider 能力适配为其他宿主预留边界，不代表已经支持 macOS 或 Linux 桌面安装包。目前打包的 Linux 程序用于 Ubuntu Worker 和隔离工具，不能据此声称 Linux 桌面已完整验收。

## 构建与测试工具

| 工具                 | 仓库要求                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| Go                   | 严格 1.27.2、固定依赖、`GOTOOLCHAIN=local`；生产构建使用 `CGO_ENABLED=0`。                           |
| Node                 | 22.18+ LTS 或 24+，支持原生 TypeScript，用于浏览器测试与开发／构建工具。                             |
| npm                  | 使用 `npm ci` 安装锁定依赖，包含仓库固定的 Prettier 和 Vite。                                        |
| Rust                 | 打包工作流固定的 1.99.1，包含 rustfmt 与锁定 Cargo 依赖。                                            |
| Python 与 shell 工具 | CI 使用 Python 3.12，另需 `pycdlib==1.14.0`、OpenSSH、Bash 和 PowerShell，以执行原隔离 VM/辅助门禁。 |
| Linux race 检查      | Go race detector 需要可用 C 编译器，不改变生产无 CGO 构建。                                          |

编译器优先查找 `.tools/go1.27.2/go/bin`，否则校验 PATH 中的版本，不自动下载其他编译器。参见 [CI](ci.md)和[代码规范](code-style.md)。

## 开发启动

构建生产资源前，先提交已审查的源码。版本/源码信息必须对应实际编译字节；脏工作树或 CI SHA 不匹配会使准备失败。

```powershell
npm ci
npm run package:resources
npm start
# 或使用同一份经校验的编译后端与 Vite：
npm run dev
```

资源准备构建 UI 和 Windows/Linux 程序，暂存到 `src-tauri/resources`（或配置的 Cargo 资源位置）。原生 debug 宿主使用该资源根，开发数据单独保存。`npm start` 与 `npm run dev` 校验准备好的清单；后台资源变化后要求从干净提交重新构建。

便携 ZIP 中 `dant.exe` 与完整 `backend/` 目录必须一起保留，其中包含 Go 程序、UI、固定辅助文件、协议 JSON、许可证和来源清单，不含秘密和运行状态。替换单个程序必须重新构建并校验其清单。

## VM 更新兼容

Controller 校验 Linux bundle，阻止新准入并确认当前执行器停止后才更新。离线准备数据前必须有完整认证私有备份；新服务证明版本和源码后才标记完成。停止未知、数据不兼容、缺少备份或源码不符均阻止激活。

关闭窗口后可以在托盘继续工作；显式 Exit 在确认暂停后挂起所属托管 VM。服务更新则保持 VM 开机以替换其服务。参见[Go Core](go-core.md)、[VM 设置](VM.md)、[更新](updates.md)和[备份](backups.md)。
