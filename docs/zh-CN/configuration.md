# 本地配置

[English](../configuration.md) · Chinese

将仓库根目录的 [`.env.example`](../../.env.example) 复制为 `.env`。开发启动器与 Vite 在启动编译后的 Go Controller 前读取它；已有的进程环境变量优先。`.env` 及私有变体由 Git 忽略，也不会进入 VM 归档或桌面安装资源。

| 变量              | 默认值      | 用途                  |
| ----------------- | ----------- | --------------------- |
| `DANT_HOST`       | `127.0.0.1` | 本地开发 API 地址。   |
| `DANT_PORT`       | `4317`      | 本地开发 API 端口。   |
| `DANT_DEV_PORT`   | `4318`      | Vite 开发端口。       |
| `DANT_GUEST_HOST` | `127.0.0.1` | VM 图形桌面桥接地址。 |
| `DANT_GUEST_PORT` | `4320`      | VM 图形桌面桥接端口。 |

地址只接受 `127.0.0.1` 或 `localhost`，端口必须是 1 至 65535 的整数。无效配置会明确报错，不会悄悄改回默认值。Go [`config`](../../core/internal/config/network.go) 负责运行端点与 VM 部署设置的校验；[`scripts/config`](../../scripts/config/network.mts) 只校验构建／开发端点。健康检查、截图和操作地址使用运行端点配置。

原生桌面 IPC 与 SSH 转发的 VM API 保持固定端口 `4317`，它们属于协议常量，不受开发端口设置影响。部署时，清单只传递两项公开的 guest 设置，并同时写入 worker 与 guest 服务；修改这些设置会改变部署指纹，`.env` 本身不会被复制。凭据继续通过已有的受保护设置保存。

配置、领域枚举和安全常量的区别见[代码规范](code-style.md)。

安装版不需要 `.env`，缺少该文件时使用内置默认配置；`.env.example` 只是模板，不会作为运行时后备文件读取。

## Worker 数据

部署后 Worker 的默认数据根目录为 `~/dant/data/`。下表路径相对于其配置的数据目录；这些是私有运行数据，不是仓库文件或 `.env` 设置。

| 路径                         | 数据权威                                 |
| ---------------------------- | ---------------------------------------- |
| `state.json`                 | 聊天消息、持久任务及已读/交付/提交回执。 |
| `memory/dant/memory.sqlite`  | 持久笔记、确认记忆及保留的项目上下文。   |
| `schedules/schedules.sqlite` | 调度、创建请求删除记录及派发屏障。       |

旧调度只导入一次，备份保存在调度数据库旁。记忆 Markdown 文件在迁移后仅作显式导入导出快照。不要用旧 JSON/Markdown 副本覆盖更新的数据库，详见[持久化与恢复](architecture.md#数据与生命周期)。
