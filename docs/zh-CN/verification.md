# Windows / VM 验证记录

[English](../verification.md) · 简体中文

日期：2026-10-17。此记录区分自动协议测试和真实设备测试，不把模拟执行器结果当作真实语音验收。

## 0.3.0 更新

本地 JavaScript 共执行 331 项测试：330 项通过，1 项 Windows 符号链接测试跳过，无失败。覆盖率为行 96.92%、分支 84.01%、函数 85.43%。47 项 Python 测试全部通过。新增范围包括虚拟化平台选择、VMware 配置归属元数据、外观严格校验、字体枚举与主题导入导出、真实通话事件中的计时器清理，以及表情反馈的更新和取消。本机实际枚举得到 198 种字体。

已有 Hyper-V VM 在空闲时通过正常 SSH 部署路径更新，并重新连接在线，保留同一个会话及当时全部 24 条消息；没有新增验收对话或改变已有表情。表情反馈在后续任务或新通话时进入模型上下文，持续语音没有新文字请求时不会即时推送，也不会因点赞自动执行任务。

VMware Workstation 17.0.2 实机完成官方镜像校验、磁盘转换和扩容至 40 GiB。首次启动发现 VMXNET3 缺少 PCIe 桥，改为 E1000 后测试 VM 已成功启动。原 Hyper-V VM 保留。由于本机 VMware DHCP 服务停止，且当前进程没有启动该 Windows 服务的权限，尚未完成 VMware IP、SSH 和桌面就绪验收。创建流程已加入 NAT/DHCP 服务检查，在改变 VM 文件前报告具体原因。

## 初版架构验收的自动检查

- Node 测试：158 项，157 通过、1 项 Windows 符号链接测试跳过，0 失败。
- Python 测试：15 项全部通过，覆盖镜像、种子、SSH 密钥、租约、MCP stdio、WAV 校验与 Windows 短路径别名。
- 发布版本门禁：4 项全部通过。
- 前端生产构建通过；Rust `cargo check --locked` 通过。
- Bash 与八份 PowerShell 文件的语法检查通过；GitHub Actions 配置通过 actionlint。

测试包含启动回执前的乱序事件、串行 steer、未知提交结果、幂等消息、重启暂停、用户验收、450 ms 视口已读、五文件归档上限、不可变附件、Linux 路径锚定、MCP 结果归属、租约、准确 callId 停止、断线恢复与原生 IPC。

中英文检查包含两份界面词典的关键流程、已保存错误切换、离线语言偏好持久化与重连同步、VM 默认回复语言、只有附件时的语言，以及听写/朗读权限提示。第一次 Windows CI 的 WAV 夹具暴露临时目录 8.3 别名问题，已在测试中规范化路径并新增真实别名回归，保留 VM 的目录保护。

## 新版回归与覆盖率

0.2.0 本地执行 277 项 JavaScript 测试，276 通过、1 项 Windows 符号链接检查跳过、0 失败；覆盖率为行 96.6%、分支 81.81%、函数 83.78%。15 项 Python、7 项版本及覆盖率门禁检查、PowerShell/Bash 语法、actionlint、前端构建和锁定依赖的 Cargo 检查均通过。CI 会独立生成提交版本的平台报告。

执行 `npm run test:coverage` 获取当前实际测试数量与覆盖率，报告位于 `.cache/coverage/`，CI 分别上传 Windows 与 Ubuntu 结果。新增测试覆盖已有 VM 导入、多候选选择、保护有效配置、失败安装后连接、离线外观设置、系统及原生主题、真实设置事件，以及 Telegram 配对、授权、附件限制、重复更新、未知交付和退出。API 回归另测账号配置、主动文档下载、记忆、回执、禁止未知任务自动重试与定时任务只派发一次。

浏览器入口通过渲染及事件夹具测试，未计入 Node 对已加载 JavaScript 模块的覆盖率；Rust 编译、Python 辅助测试和真实设备测试也分别报告，不宣称每条设备路径都已经执行。真实 Telegram 收发还需要你在本地设置中填写自己的 Token 并配对。

## 真实 Hyper-V VM

Ubuntu 24.04 AMD64，普通 `dant` 用户，Hyper-V 虚拟环境、图形会话、SSH、两个用户服务及 user lingering 已核验。工作 API 及租约桌面桥只监听 VM 内 loopback。

原 Windows 聊天及附件迁移前已备份，原有认证由 VM Codex 保留。通过 Controller 执行真实任务后，Windows 原始 `state.json` 的 SHA-256 保持不变，新增记录归 VM。

真实任务验收包括文本及图标附件、MCP 截图、MCP 消息恰好一次交付、`output/architecture-acceptance.txt` 自动归档、105,662 字节 PCM WAV 交付、消息执行确认、用户已读与验收、607,309 字节真实桌面截图、人工租约与键盘输入、拒绝旧会话输入。

安装版连接修复后，真实 Controller 使用其 AppData 配置启动，在旧安装状态仍为 `failed` 时成功连接，Controller 与 Worker 均在线，原会话与全部 21 条消息保留。原 Windows 状态哈希不变，VM 磁盘未重建，AppData 另生成的密钥和失败记录均保留。已部署 Telegram 状态接口，无凭据时保持关闭；另由 VM 无令牌 HTTPS 请求确认 Telegram DNS/TLS 可达，没有发真实 Bot 消息。

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
