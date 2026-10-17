# 可选语音 API Key

本文只说明 dant 的可选独立 API 语音。ChatGPT 桌面应用中的原生语音使用现有订阅额度，无需单独 API Key；dant 尚未接入该原生通道。不能把 dant 当前接口的限制理解为 ChatGPT 桌面语音必须额外付费。参见 [官方语音说明](https://learn.chatgpt.com/docs/features/voice) 与 [订阅用量说明](https://learn.chatgpt.com/docs/pricing)。

如自行选择独立 API 方案，可以在设置中展开“可选：独立 API 语音”并配置 OpenAI API Key。此方案的 API 用量按对应 API 项目计费，不包含在 ChatGPT 订阅中。未配置时可以继续使用已有 ChatGPT 订阅文字聊天与电脑任务。

Windows 版把 Key 保存在应用数据目录的 `voice-key.dpapi`，使用 Windows DPAPI `CurrentUser` 保护。该文件只包含密文，Key 不写入 `state.json`、聊天记录或 Git。状态接口只提供是否配置和来源，不回显 Key；已配置不表示已通过远端 API 的有效性或额度验证。

删除配置会移除本机密文。若进程通过 `OPENAI_API_KEY` 环境变量获得 Key，删除本机配置后仍可能显示已配置，来源会变为 `environment`。应用不修改启动进程的环境变量。Windows 上已有本地密文时优先使用本地配置。

DPAPI 依赖当前 Windows 用户身份和用户配置文件。换账号、迁移环境或密文损坏时，应重新配置 Key；无法解密会清楚报错，不回退到明文文件，也不会悄悄改用其他环境 Key。非 Windows 环境目前仅支持由启动进程注入 `OPENAI_API_KEY`，界面保存会报不支持，不创建明文替代文件。

## 服务端接入

```js
import {VoiceKeyStore} from './secrets.mjs';

const voiceKeys = new VoiceKeyStore(dataDir);
voiceKeys.status();             // {configured, source, storage}
await voiceKeys.set(inputKey);  // 返回状态，不返回 Key
await voiceKeys.clear();        // 删除本地密文，返回状态
const key = await voiceKeys.get(); // 仅服务端内部语音请求使用
```

`source` 是 `stored`、`environment` 或 `null`；`storage` 是 `windows-dpapi` 或 `environment`。`get()` 不能直接用于 HTTP 响应、WebSocket 事件、日志或持久化状态。API 请求中的输入 Key 也不能写入请求日志。

`set()` 先保护输入，再以唯一临时文件写入密文、刷盘、原子替换目标文件；保护或写入失败保留旧配置。设置和删除操作在同一存储实例内串行处理。

Windows PowerShell 的保护脚本为固定内容。Key 仅通过子进程 stdin 输入，不进入命令行参数。保护结果是 DPAPI 密文；解保护结果通过新的随机一次性 mask 包裹后返回，stdout 也不包含明文 Key。子进程错误会转成不含输入内容的固定错误。明文只在用于语音请求的进程内存中短暂存在。

测试可通过构造参数注入 `platform`、`env`、`protect`、`unprotect` 或 `spawnProcess`。测试用临时虚构 token 检查原子保存、失败保留、清除、非 Windows 行为、子进程参数/stdout、Windows DPAPI 往返和篡改拒绝，不读取已有用户凭据。

```powershell
node --test tests/secrets.test.mjs
```

参考：[Microsoft ProtectedData](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata)、[CurrentUser 保护范围](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope)。
