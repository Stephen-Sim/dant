# 可选语音 API Key

[English](../VOICE-KEY.md) · Chinese

本文只说明 dant 的可选独立 API 语音。默认通话使用 ChatGPT 登录、Codex Realtime V3 与 WebRTC，无需单独 API Key，仍受账号订阅额度约束。现有账号已通过静默 WebRTC 连接测试；该测试不代表真人麦克风与扬声器验收。参见 [官方语音说明](https://learn.chatgpt.com/docs/features/voice) 与 [订阅用量说明](https://learn.chatgpt.com/docs/pricing)。

如自行选择独立 API 方案，可以在设置中展开“可选：独立 API 语音”并配置 OpenAI API Key，再显式选择 API 通话。此方案的 API 用量按对应 API 项目计费，不包含在 ChatGPT 订阅中。未配置不影响默认订阅通话、文字聊天或电脑任务。

Windows 版把 Key 保存在应用数据目录的 `voice-key.dpapi`，使用 Windows DPAPI `CurrentUser` 保护。该文件只包含密文，Key 不写入 `state.json`、聊天记录或 Git。状态接口只提供是否配置和来源，不回显 Key；已配置不表示已通过远端 API 的有效性或额度验证。

独立 API 通话开始时，Controller 只经已建立的 SSH 本地隧道将 Key 交给 VM 通话进程内存，停止或关闭后清除。它不会作为模型任务内容发送，也不写入 VM 认证文件。默认订阅通话不读取或转交这个 Key。

删除配置会移除本机密文。若进程通过 `OPENAI_API_KEY` 环境变量获得 Key，删除本机配置后仍可能显示已配置，来源会变为 `environment`。应用不修改启动进程的环境变量。Windows 上已有本地密文时优先使用本地配置。

DPAPI 依赖当前 Windows 用户身份和用户配置文件。换账号、迁移环境或密文损坏时，应重新配置 Key；无法解密会清楚报错，不回退到明文文件，也不会悄悄改用其他环境 Key。非 Windows 环境目前仅支持由启动进程注入 `OPENAI_API_KEY`，界面保存会报不支持，不创建明文替代文件。

## 服务端接入

Go 组装通过 `security.NewVoiceKeyStore` 传入经过校验的数据目录、宿主 OS、选定的环境 Key 与窄接口 `security.Protector`。`Status()` 返回元数据；`Set(ctx, inputKey)`、`Clear(ctx)` 返回状态与错误，调用者必须处理错误。只有内部语音启动可以调用 `Get(ctx)`，返回的 Key 不得进入 HTTP 响应、事件、日志或持久化状态。

`source` 是 `stored`、`environment` 或 `null`；`storage` 是 `windows-dpapi` 或 `environment`。请求日志不得包含输入 Key。所属实现为 [`voice_key.go`](../../core/internal/security/voice_key.go)。

`Set()` 先保护输入，再以唯一临时文件写入密文、刷盘、原子替换目标文件；保护或写入失败保留旧配置。设置和删除操作在同一存储实例内串行处理。

Go Windows protector 通过固定版本的 Windows 绑定直接调用 `CryptProtectData`、`CryptUnprotectData`，保留原 entropy 与当前用户保护范围，禁止交互保护 UI，校验结果大小，清零并释放返回的原生内存。Key 不再经过 PowerShell 子进程或命令行。明文只在请求所属进程短暂存在，错误只暴露不含 Key 的固定代码。

测试注入 OS、环境值与窄 protector。`tests/go/internal/security/` 使用临时虚构 token 检查原子保存、失败保留、清除、非 Windows 行为、取消、Windows 原生 DPAPI 往返与篡改拒绝，不读取已有用户凭据；通过统一 overlay 入口运行。

```powershell
npm run test:core
```

参考：[Microsoft ProtectedData](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata)、[CurrentUser 保护范围](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope)。
