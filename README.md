# dant

Windows 上的数字伙伴，有自己的 Ubuntu 虚拟电脑。使用 Rust / Tauri 桌面壳、Node.js 本地服务和 VM 内的 Codex App Server。

项目正在从零重建。当前核心代码、界面和 Windows 可执行文件已构建验证；真实 VM、订阅推理和双向语音需要在完成部署后验收。接口接入不代表实机测试通过。

## 功能

- 单一持续聊天，Markdown、链接、附件、引用回复、表情和消息状态。
- 中英文界面，黑白设计，整页设置，可调宽度的电脑面板。
- VM 内串行执行任务，停止、接管、交还；聊天与长期记忆保存在本地。
- SSH 转发桌面画面及输入，不在宿主机执行 Agent 的工作命令。
- 图片、文件和录音消息；Agent 可分享工作目录中的文件。
- 未读消息通知、定时任务，以及 Codex 实验实时通话接入。

## 本地启动

需要 Windows 11、Node.js 22+、Python 3.11+。VM 默认使用已启用的 Hyper-V，管理 VM 需要管理员权限。

```powershell
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:4317>。也可以运行 `start.cmd`。

## 创建工作电脑

在设置中点击“创建工作电脑”，可调整 CPU、内存、磁盘与 VM 内管理权限。应用会下载并校验镜像，调起 Windows 管理员授权，显示安装进度，并在桌面就绪后连接。关闭后再次打开应用，会继续检查已有安装进度。

也可以通过 PowerShell 执行相同流程：

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

默认 4 核、6 GB 内存、40 GB 动态磁盘。VM 用户 `dant` 使用 SSH 密钥，不启用密码登录。完整流程和排障见 [VM 说明](docs/VM.md)。已有 Ubuntu VM 也可以安装 `vm/` 中的执行器后手动填写 SSH 连接信息。

连接 VM 后，在设置中发起 ChatGPT 设备码登录，使用 OpenAI 官方页面完成认证。凭据由 VM 内 Codex 管理，dant 不复制宿主机 ChatGPT 凭据。模型、额度和实时通话可用性取决于账号及 Codex 版本。

## Windows 桌面构建

需要 Visual Studio C++ Build Tools 和 Windows SDK。Rust 可安装在项目目录，脚本不修改系统 PATH：

```powershell
./scripts/setup-tools.ps1
./scripts/build-desktop.ps1
```

输出位于 `src-tauri/target/release/`，安装包位于其 `bundle/nsis/` 子目录。安装版把用户数据保存在每个用户自己的应用数据目录；源码启动默认使用项目下 `data/`。开发验收时可以通过进程环境变量 `DANT_DATA` 显式指定数据目录。

## 验证

```powershell
npm test
npm run build
python -m py_compile vm/guest.py vm/desktop.py scripts/seed.py
```

自动测试使用模拟执行器验证队列、协议事件、持久化和 API。它们不代表真实模型或 VM 验收。首次实机验证应依次检查：桌面截图、接管输入、ChatGPT 登录、真实回复、任务中断、文件交付、重启恢复，再测试麦克风/播放/打断和通知。

## 数据与运行边界

- `data/`：聊天、记忆、文件、SSH 密钥和 VM 磁盘；不纳入 Git。
- `.cache/` 和 `.tools/`：下载镜像、协议参考和项目构建工具；不纳入 Git。
- VM 内 Agent 拥有所选 VM 权限；宿主机只运行管理应用和 SSH 连接。
- 任务调度需要应用正在运行；目前没有安装 Windows 后台服务。
- 录音附件可上传、交付和播放；内容理解取决于模型工具。实时语音依赖 Codex 的实验接口，不使用未公开的 ChatGPT 网页音频接口。
- 桌面面板通过 SSH 隧道获取截图与发送输入，适合文档、浏览器和开发工作，不是高帧率视频串流。

## 官方接口参考

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Hyper-V New-VM](https://learn.microsoft.com/en-us/powershell/module/hyper-v/new-vm)
- [Ubuntu 24.04 官方镜像](https://cloud-images.ubuntu.com/releases/noble/release/)
- [Tauri](https://v2.tauri.app/)
