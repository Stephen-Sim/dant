<p align="center"><img src="../../ui/public/brand/dant-logo.svg" width="80" height="80" alt="dant"></p>

# dant

[English](../../README.md) · Chinese

Windows 上的 AI 数字伙伴，既能与你聊天，也能在自己的 Ubuntu 电脑上完成工作。

**[下载 Windows 版](https://github.com/Stephen-Sim/dant/releases/latest)** · [体验 Beta](https://github.com/Stephen-Sim/dant/releases) · [文档目录](../README.md)

## 可以做什么

- **文字与通话。** 消息、语音、文件和工作结果留在同一段对话中。
- **自己的电脑。** 在 Ubuntu VM 中执行工作；你可以查看桌面，随时接管。
- **持续完成任务。** 查看步骤、暂停或取消工作，直接回复任务，也能带着保存的上下文重开。
- **积累共同经历。** 查看保存的记忆、添加可复用技能，安排单次或重复任务。
- **Telegram 随时联系。** 配对私人聊天，可配置仅转发未读回复及合并连续消息。

## 开始使用

需要 Windows 11、Python 3.11+、OpenSSH，以及 Hyper-V 或 VMware Workstation；也可以通过 SSH 连接已有的 Ubuntu 桌面 VM。

1. 下载并安装 dant。便携版请完整解压 ZIP，再打开与 `backend` 文件夹同目录的 `dant.exe`。当前安装包未签名，附 SHA-256 校验和。
2. 在**设置 → 工作电脑**创建电脑或连接已有 VM，详见[设置指南](VM.md)。
3. 在设置中登录 ChatGPT，然后交给 dant 第一项任务。

文字任务及默认语音使用 ChatGPT 订阅额度，语音可用性取决于账号；可选的独立 API 语音另行计费。详见[语音配置](VOICE-KEY.md)。

## 继续了解

[设置](settings.md) · [Telegram](TELEGRAM.md) · [更新](updates.md) · [架构](architecture.md) · [验证记录](verification.md)

<details>
<summary>从源码运行</summary>

安装 Node.js 22.18+ LTS / 24+ 及上述依赖后：

```powershell
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:4317>。构建桌面版还需要 Visual Studio C++ Build Tools 与 Windows SDK，然后运行 `scripts/setup-tools.ps1`、`scripts/build-desktop.ps1`。详见[开发与 CI](ci.md)、[代码规范](code-style.md)和[本地配置](configuration.md)。

</details>

项目使用 [MIT 许可证](../../LICENSE)，第三方依赖保留各自的许可证。
