# Windows / VM 验证记录

日期：2026-10-17。此记录区分自动协议测试和真实设备测试，不把模拟执行器结果当作真实语音验收。

## 自动检查

- Node 测试：158 项，157 通过、1 项 Windows 符号链接测试跳过，0 失败。
- Python 测试：15 项全部通过，覆盖镜像、种子、SSH 密钥、租约、MCP stdio、WAV 校验与 Windows 短路径别名。
- 发布版本门禁：4 项全部通过。
- 前端生产构建通过；Rust `cargo check --locked` 通过。
- Bash 与八份 PowerShell 文件的语法检查通过；GitHub Actions 配置通过 actionlint。

测试包含启动回执前的乱序事件、串行 steer、未知提交结果、幂等消息、重启暂停、用户验收、450 ms 视口已读、五文件归档上限、不可变附件、Linux 路径锚定、MCP 结果归属、租约、准确 callId 停止、断线恢复与原生 IPC。

中英文检查包含两份界面词典的关键流程、已保存错误切换、离线语言偏好持久化与重连同步、VM 默认回复语言、只有附件时的语言，以及听写/朗读权限提示。第一次 Windows CI 的 WAV 夹具暴露临时目录 8.3 别名问题，已在测试中规范化路径并新增真实别名回归，保留 VM 的目录保护。

## 真实 Hyper-V VM

Ubuntu 24.04 AMD64，普通 `dant` 用户，Hyper-V 虚拟环境、图形会话、SSH、两个用户服务及 user lingering 已核验。工作 API 及租约桌面桥只监听 VM 内 loopback。

原 Windows 聊天及附件迁移前已备份，原有认证由 VM Codex 保留。通过 Controller 执行真实任务后，Windows 原始 `state.json` 的 SHA-256 保持不变，新增记录归 VM。

真实任务验收包括文本及图标附件、MCP 截图、MCP 消息恰好一次交付、`output/architecture-acceptance.txt` 自动归档、105,662 字节 PCM WAV 交付、消息执行确认、用户已读与验收、607,309 字节真实桌面截图、人工租约与键盘输入、拒绝旧会话输入。

## 订阅语音

现有 ChatGPT 登录、Codex CLI 0.163.0、`gpt-live-1-codex`、Realtime V3：

1. 使用真实 WebRTC 实现生成音频 transceiver 与 `oai-events` SDP。
2. 经 Windows Controller 调用 VM NativeRealtimeVoice，收到 V3 启动事件与 SDP answer。
3. WebRTC 进入 connected，数据通道进入 open，随后明确上报 connected。
4. 通话内显式文字通过相同线程真实执行、确认和交付；重复 clientMessageId 没有再次执行。
5. 挂断得到停止确认，保存实际连接过的通话记录。

这条链路未配置 API Key。早期只测默认 WebSocket 通道并据此判断订阅语音不可用，是错误推断；已改为默认 V3 WebRTC 订阅通道。可选 API 语音未用付费 Key 实测。

## 尚需人工体验验收

真实麦克风采集、扬声器播放、连续语音打断、系统通知横幅及长时间稳定运行尚未由本记录证明。Windows 本地听写仅核验识别包存在（中英文）与辅助调用逻辑，没有自动开启麦克风。UI 已按用户提供的截图重做并完成构建和交互逻辑检查；未绕过先前浏览器访问许可限制做截图预览。
