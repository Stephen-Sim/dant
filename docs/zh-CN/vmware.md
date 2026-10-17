# VMware Workstation

[English](../vmware.md) · 简体中文

dant 可以复用 Windows 上已安装的 VMware Workstation，自动创建 Ubuntu 工作电脑。这与通过 SSH 连接已有 Ubuntu VM 是两条路径：导入已有配置不会创建磁盘、转换 VM 或更改虚拟化软件。

## 依赖与选择

自动创建需要 Workstation 的 `vmrun.exe`、`vmware-vdiskmanager.exe`、Python 3、Windows OpenSSH，以及访问 Ubuntu 和软件仓库的网络。dant 复用这些工具，不代为安装 Workstation、qemu 或其他虚拟化产品，也不请求 Hyper-V 管理员授权。新来宾是否允许 dant 使用 sudo，是另外一项明确选择。

新电脑采用 VMware NAT 网络，Windows 的 **VMnetDHCP** 和 **VMware NAT Service** 两项服务必须正在运行。准备脚本会在下载镜像、生成密钥或种子之前检查，首次创建也会在转换磁盘之前再次检查。检查只读取服务状态；若服务停止、缺失或无法查询，请打开 Windows“服务”（`services.msc`），由电脑管理员启动或修复 VMware 服务后再重试。dant 不自动修改宿主服务、虚拟网络、Hyper-V 或 VBS。连接已有 SSH 电脑、恢复已经归属本项目的 VM，不受这项新建前检查阻挡。

以下命令只查看状态，不修改服务：

```powershell
Get-Service -Name 'VMnetDHCP','VMware NAT Service' | Select-Object Name,Status,StartType
```

设置 →“创建工作电脑”→“VMware Workstation”会显式使用 VMware。“自动选择”先保留已有 provider，否则优先可用 Hyper-V，再选 VMware。显式 VMware 创建失败后会报错，不会悄悄切换 Hyper-V；有效的已有电脑连接也会保留。

## 等效脚本

在项目目录的普通 PowerShell 中运行：

```powershell
$dantData = Join-Path $env:APPDATA 'com.dant.desktop\data'
.\scripts\prepare-vmware.ps1 -DataDirectory $dantData
.\scripts\create-vmware.ps1 -DataDirectory $dantData -Cpu 4 -MemoryGB 6 -DiskGB 40
.\scripts\check-vm.ps1 -DataDirectory $dantData
```

全程使用同一个绝对数据目录。准备脚本可用 `-VmrunPath`、`-VdiskmanagerPath` 指定已存在的工具路径。只有明确需要让新电脑里的 dant 管理系统时，才给准备脚本传 `-AdminSudo`；已有种子或磁盘不会为了更改权限而被重写。

准备阶段下载官方 Ubuntu 24.04 AMD64 VMDK，核对官方 SHA-256 清单，准备 SSH 密钥和 NoCloud 种子，并把 ISO 工具安装在独立工具目录。创建阶段生成受管理的 VMX 和磁盘，调用 Workstation 启动，通过 VMware Tools 等待地址，然后保存顶层 SSH 配置。来宾镜像包含 open-vm-tools。拿到 SSH 地址不代表安装完成；必须等图形桌面、截图桥和执行器的就绪检查通过。

默认四核、6 GB 内存、40 GB 磁盘。`create-vmware.ps1` 的 `-IPTimeoutSeconds` 可调整地址发现等待时间。Worker 和桌面服务采用与 Hyper-V 相同的 VM 数据归属边界，详见 [VM 运行说明](VM.md)。

## 文件、进度与恢复

专属文件位于 `<data>/vmware/`，包含 `cache/`、`tools/`、`vm-key`、`dant.vmx`、`dant.vmdk`、`manifest.json` 和 `logs/`。顶层 `vm.json` 选择当前连接，`vm-setup-status.json` 记录 provider、阶段和错误。私钥不要上传或附在问题报告中。

阶段包括 `checking-vmware`、`checking-vmware-network`、`downloading-image`、`verifying-image`、`preparing-seed`、`prepared`、`converting-image`、`expanding-disk`、`starting-vm`、`waiting-for-ip`、`guest-installing` 和失败阶段。中断时先查看记录中的 error 和对应日志。

受管理的 VM 中断后，可运行：

```powershell
.\scripts\create-vmware.ps1 -DataDirectory $dantData -Resume
```

恢复会先验证 manifest、关键 VMX 设置、磁盘身份与容量、种子及公钥摘要，然后才允许启动这台 VM 或更新 IP/连接资料。不会重新生成磁盘、种子或权限配置。部分生成的 building 磁盘会保留并拒绝恢复，需先人工检查；不要通过删除它来绕过检查。对于 dant 以外创建的 VM，应选择“连接已有电脑”并填写其 SSH 信息。

## 验收边界

工具检测和确定性测试覆盖 provider 选择、只读 NAT 服务检查、文件验证、拒绝覆盖已有状态与恢复行为。

2026-10-17 的隔离 Windows Workstation 17.0.2 实测已验证官方镜像摘要、磁盘转换和扩容、种子生成，以及修复为 e1000 网卡后的真实来宾启动。**SSH 和完整安装尚未验证**：当时 VMnetDHCP 已停止、VMware NAT Service 正在运行，地址发现与 SSH 探测超时，Windows 也拒绝当前进程启动 DHCP 服务。测试 VM 和磁盘已保留。来宾能启动不代表网络、桌面或执行器已经可用。其他 Windows/VM 实机结果见 [验证记录](verification.md)。订阅语音的静默连接检查同样不代表已验证麦克风和扬声器。
