# dant

[English](../../README.md) · 简体中文

Windows 上的数字伙伴，有自己的 Ubuntu 虚拟电脑。使用 Rust / Tauri 桌面壳、Node.js 本地服务和 VM 内的 Codex App Server。

按原版 UI 与架构重建，适配 Windows + Hyper-V / VMware Workstation。Windows 负责界面、VM 安装管理、本机通知和 API 代理；Ubuntu VM 持有聊天、任务、记忆、附件与 Codex 执行器。职责与 Mac / UTM 原版对应，通信改为 SSH 本地隧道。详见 [实现架构](architecture.md)。

订阅语音采用 Codex Realtime V3、WebRTC 与 `gpt-live-1-codex`。已用现有 ChatGPT 登录实测 SDP 协商及静默 WebRTC 连接，无需 API Key；麦克风、扬声器和连续对话仍需人工实机验收。独立 API 语音保留为可选通道。

## 功能

- 单一持续聊天，Markdown、链接、附件、引用回复、表情和消息状态。点赞及目标消息会进入后续任务或新通话的上下文，取消与更换表情也会更新。
- 中英文界面，浅色 / 深色 / 跟随系统主题，字体与字号设置，以及可调宽度的电脑面板。
- Telegram Bot 私聊接入，与桌面共享 VM 对话、任务和文件；通过一次性配对限制可操作账号。
- VM 内串行执行任务，暂停、继续、待验收和明确验收；消息送达、执行确认、用户已读分别记录。
- SSH 转发桌面画面及输入，不在宿主机执行 Agent 的工作命令。
- 每条消息最多 5 个附件，每个 10 MiB；成功执行后自动归档 `output/` 中新增或变化的文件。
- VM 文件记忆、人工接管共享锁和两分钟租约、本机未读完成通知、单次定时任务，以及订阅实时通话。

## 本地启动

需要 Windows 11、Node.js 22+、Python 3.11+ 和 OpenSSH。自动创建可使用已启用的 Hyper-V，或已安装且包含 `vmrun`、`vmware-vdiskmanager` 的 VMware Workstation。Hyper-V 创建需要 Windows 管理员授权；VMware 流程无需 Hyper-V 提权。已有 Ubuntu VM 可通过 SSH 连接，不限制其虚拟化软件。

```powershell
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:4317>。也可以运行 `start.cmd`。

## 创建工作电脑

已有 VM 时，在设置里选择“连接已有电脑”。应用会查找当前用户已登记的有效连接配置：只有一个时自动导入，多个时由你选择。也可以填写旧 `vm.json` 所在目录进行导入，或手动填写 VM 地址、SSH 用户、端口和私钥路径。导入保留已有虚拟磁盘、ChatGPT 登录和 VM 聊天，不会重新创建电脑；先前创建失败的记录也不会阻止连接。

在设置中点击“创建工作电脑”，选择“自动选择”、Hyper-V 或 VMware Workstation，可调整 CPU、内存、磁盘与 VM 内管理权限。自动选择优先保留已有配置，否则依次选择可用的 Hyper-V、VMware；显式选择失败时不会悄悄切换。应用会下载校验镜像、显示准备与启动安装进度，通过就绪检查后连接。只有 Hyper-V 流程请求 Windows 管理员授权。关闭后再次打开应用，会继续检查已有安装进度。

也可以通过 PowerShell 执行 Hyper-V 流程：

```powershell
# 普通 PowerShell：下载官方 Ubuntu 镜像、校验 SHA-256、创建 SSH 密钥与 cloud-init 种子
./scripts/prepare-vm.ps1

# 需要 VM 内免密码 sudo 时显式选择此项（仅影响新 VM）
./scripts/prepare-vm.ps1 -AdminSudo

# 管理员 PowerShell：创建 Hyper-V VM
./scripts/create-vm.ps1

# 等待初次软件安装完成后检查
./scripts/check-vm.ps1
```

VMware 可在普通 PowerShell 中依次运行 `prepare-vmware.ps1`、`create-vmware.ps1`，再用相同的 `check-vm.ps1` 检查。dant 复用本机 Workstation，不代为安装虚拟化软件。精确命令与验收边界见 [VMware 说明](vmware.md)。

默认 4 核、6 GB 内存、40 GB 磁盘。VM 用户 `dant` 使用 SSH 密钥，不启用密码登录。完整流程和排障见 [VM 说明](VM.md)。已有 Ubuntu VM（包括 VMware）也可以通过导入或填写 SSH 连接接入，不转换磁盘或重新创建系统；来宾需有可用图形桌面和 VM 运行依赖，详见 VM 说明。

连接 VM 后，在设置中发起 ChatGPT 设备码登录，使用 OpenAI 官方页面完成认证。凭据由 VM 内 Codex 管理，dant 不复制宿主机 ChatGPT 凭据。文字模型和额度取决于订阅账号及 Codex 版本。

执行器固定为经验证的 Codex CLI `0.163.0`。模型列表来自实际执行器；目录不是账号权限证明，须以成功完成推理为准。升级执行器时优先使用 VM 用户目录中的 `$HOME/.local/bin/codex`，无需给用户 sudo。模型退休和订阅兼容边界见 [官方模型说明](https://learn.chatgpt.com/docs/models)。

## Windows 桌面构建

需要 Visual Studio C++ Build Tools 和 Windows SDK。Rust 可安装在项目目录，脚本不修改系统 PATH：

```powershell
./scripts/setup-tools.ps1
./scripts/build-desktop.ps1
```

输出位于 `src-tauri/target/release/`，安装包位于其 `bundle/nsis/` 子目录。安装版把用户数据保存在每个用户自己的应用数据目录；源码启动默认使用项目下 `data/`。开发验收时可以通过进程环境变量 `DANT_DATA` 显式指定数据目录。

双击项目中的 `start-desktop.cmd`，默认使用与安装版相同的用户数据目录，并把项目原有 `data/` 作为连接配置导入来源。`DANT_DATA` 仍可显式指定独立目录。应用会登记本用户使用过的有效 VM 配置，便于安装版与源码版互相发现；不会把私钥或用户数据写入安装包。

## 外观

设置中通过缩略预览选择浅色、深色或跟随系统，支持主题预设、强调色、背景和文字颜色、本机字体搜索，以及分别调整界面、正文和代码字号；可减少动态效果，并导入或导出外观 JSON。选项立即生效并保存在 Windows Controller 的配置中，VM 离线时也能修改；字体保留中英文回退。

## Telegram

先连接 VM，再在设置的 Telegram 区域填写通过官方 [@BotFather](https://t.me/BotFather) 创建的 Bot Token。启用后生成配对链接，在你自己的 Telegram 私聊中打开链接并点击 Start，即可向 dant 发送文字和附件并接收回复。Token 只在本地设置中输入，不要发到聊天。完整步骤与运行边界见 [Telegram 接入](TELEGRAM.md)。

Telegram 网关在 VM 中运行，不需要开放公网端口；Windows 窗口关闭后，已配对机器人仍可在 VM 在线时继续收消息。机器人默认关闭，群聊与未配对账号不会触发任务。

## 语音通话

默认通过 VM 内 Codex App Server 的实验性 Realtime V3 接口使用 ChatGPT 登录。前端持有 WebRTC 音频连接，Controller 与 VM 只传 SDP 和控制事件。之前默认 WebSocket 测试返回“requires API key”的结论仅适用于那个通道；V3 WebRTC 已实测连接成功。可用性和额度仍取决于订阅账号与执行器版本，见 [官方语音说明](https://learn.chatgpt.com/docs/features/voice) 和 [用量说明](https://learn.chatgpt.com/docs/pricing)。

如自行选择独立 API 方案，在设置中展开“可选：独立 API 语音”，填写自己的 OpenAI API Key。Key 使用 Windows 当前用户 DPAPI 加密保存；只有显式选择 API 通话时，经 SSH 传给 VM 的通话进程短时使用，结束后清除，不写入 VM 磁盘、聊天或 Git。保存仅表示本地已配置，实际权限由官方 API 验证。

可选 API 通道使用 `gpt-realtime-2.1`，费用由 API 项目单独承担。默认订阅通道不要求这个 Key。应用只保存实际连接过的通话起止时间和时长，不把通话音频或转写正文写入聊天；明确交付的消息与文件照常保存。配置见 [语音说明](VOICE-KEY.md)。

## 验证

```powershell
npm test
npm run build
python -m py_compile vm/guest.py vm/desktop.py scripts/seed.py
```

自动测试使用模拟执行器验证队列、协议事件、持久化和 API。它们不代表真实模型或 VM 验收。首次实机验证应依次检查：桌面截图、接管输入、ChatGPT 登录、真实回复、任务中断、文件交付、重启恢复，再测试麦克风/播放/打断和通知。

## GitHub Actions

推送、Pull Request 和手动运行会触发 Ubuntu / Windows 的自动测试与前端构建。Windows 构建流程另外编译 Tauri 桌面程序，上传安装包、包含完整后端的 ZIP、SHA-256 校验文件和构建信息，可在 [Actions](https://github.com/Stephen-Sim/dant/actions) 下载。

推送与项目版本一致的 `v*` 标签时，会在构建成功后创建 GitHub Release 草稿，供检查后手动发布。流程不需要 OpenAI Key 或真实 VM，也不会打包个人聊天、凭据或 VM 磁盘。用法与范围见 [CI 说明](ci.md)。

## 数据与运行边界

- Windows `data/`：VM 连接、部署信息、通知、DPAPI 密钥及离线状态缓存；不纳入 Git。
- VM `~/dant/data/`：权威聊天、附件与 `memory/dant/`；`~/dant/workspaces/<conversationId>/output/` 保存工作交付现场。
- `.cache/` 和 `.tools/`：下载镜像、协议参考和项目构建工具；不纳入 Git。
- VM 内 Agent 拥有所选 VM 权限；宿主机只运行管理应用和 SSH 连接。
- 调度由 VM 用户服务运行；VM 在线且执行器健康时，关闭 Windows 窗口不会自动终止已提交工作。本机通知仍需 Windows 应用运行。
- 结果未确认的任务不会自动重放；服务重启后保留为暂停，检查现场后由用户明确继续。
- 录音附件与实时通话是独立能力，录音内容理解取决于模型工具。没有使用 ChatGPT 网页音频接口。
- 桌面面板通过 SSH 隧道获取截图与发送输入，适合文档、浏览器和开发工作，不是高帧率视频串流。

## 许可证

项目使用 [MIT License](../../LICENSE)。第三方依赖保留各自的许可证。

## 官方接口参考

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Realtime WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [Realtime 服务端工具控制](https://developers.openai.com/api/docs/guides/realtime-server-controls)
- [Hyper-V New-VM](https://learn.microsoft.com/en-us/powershell/module/hyper-v/new-vm)
- [Ubuntu 24.04 官方镜像](https://cloud-images.ubuntu.com/releases/noble/release/)
- [Tauri](https://v2.tauri.app/)
