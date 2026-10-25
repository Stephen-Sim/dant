# Windows VM 初始化与排障

[English](../VM.md) · Chinese

dant 的桌面、任务引擎、数据和 Codex 运行在 Ubuntu 虚拟机内。Windows Go Controller 通过 SSH 本地隧道访问 VM 的 `127.0.0.1:4317` 工作 API；Codex 由 VM 内 Go Worker 通过 stdio 启动，桌面桥只供 VM 内访问。新建虚拟机默认 4 个 CPU、8 GiB 内存、64 GiB 磁盘；Hyper-V 使用 Default Switch，VMware Workstation 使用 NAT。两者采用相同的 Worker 边界和 SSH 连接。

这些默认值仅用于新建 VM。恢复现有 VM 会保留已配置的内存和磁盘容量，包括更大的自定义规格，不会调整或缩小磁盘。修改现有 VM 的规格需要单独执行维护操作。

首次安装先选择是否已有 dant 备份；没有 VM 时也能导入便携备份。没有备份则由引导说明如何创建工作电脑、检测 Hyper-V/VMware，或连接已有 SSH 电脑。只有明确提交创建才会创建 VM，查看引导不会自动执行。已有配置的安装正常进入原界面。连接新 VM 后，预览并恢复导入的备份，即可带着记忆、Skills 和聊天/任务历史继续；参见[备份说明](backups.md)。

## 磁盘空间与检查点

动态扩展的 VHDX 有虚拟容量与宿主文件占用两个数值；在 Linux 内删除文件不会立即缩小宿主文件。AVHDX 是依赖父 VHDX 的差分磁盘，可能包含 VM 当前的写入数据。属于依赖链的文件不能直接删除。通过 Hyper-V 移除不需要的检查点，才能安全合并当前数据；该回滚点会消失，合并也可能需要临时空闲空间。磁盘压缩是另一项离线维护操作。

新建受管 Hyper-V VM 会关闭自动检查点；明确恢复现有受管 VM 时，也会在启动前确认该设置已关闭。只读检查与挂起不会更改此设置。已有检查点保留到明确选择移除为止。普通 agent 备份只选择 agent 数据和托管 Skills，不会导出整个 VHDX。为单独维护恢复而创建的完整 VM 导出属于额外保留副本，不会自动删除；清理前须核对其用途、依赖关系及当前 VM 健康状态。

## Worker 部署与运行

首次连接部署经验证的 Go 程序和固定 VM 辅助文件白名单，绑定精确版本、源码及文件哈希。安装器在停服务前检查空间，证明旧服务已停止，验证私有恢复归档，再离线准备并激活普通用户的 `dant-worker.service`、`dant-guest-local.service`。Go bundle 提供服务运行时；Codex 与用户工具可能独立使用 Node/npm。启用 user lingering 后，Windows Controller 退出不终止 VM 服务。当前种子镜像的系统桌面桥端口 4319 保留；Worker 的本机租约桥默认使用 4321，避开旧系统桌面桥可能占用的 4320，均不绑定 VM 外部地址。参见[安装与中断恢复](go-core.md)。

Worker 拒绝在 Windows、裸机 Linux、root 账号或缺少可用图形桌面的环境执行任务。更新前会检查活动任务与通话；正在工作时保留当前进程并推迟升级。相同源码版本复用已有健康服务。

新 VM 的 root 初始化会安装系统 `bubblewrap` 和 `apparmor` 软件包，再明确执行 root 拥有的 `/opt/dant/conversation-namespace.py --install --user dant`。该助手先以普通 Linux 用户在 bwrap 中运行固定的 `/usr/bin/true` 探针；现有环境已可用时不作更改。如果 Ubuntu 的 AppArmor 限制阻止用户命名空间，则按照 [Ubuntu 的逐应用指导](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces)，校验并仅新增绑定 `/usr/bin/bwrap`、允许 `userns` 的 ABI 4 策略。它不会修改全局 sysctl、禁用 AppArmor 或替换管理员/发行版的现有策略。冲突的全局策略身份或程序绑定、不可信文件、不支持的 parser 或探针失败都会以固定诊断码停止初始化。策略激活无法确认时保留新建文件供操作者核查，不会删除或替换其他策略。

现有 VM 需要管理员先审阅并把该助手安装到 root 拥有的位置，再明确使用 `--install --user <普通-Linux-用户名>` 执行。账号通过操作系统解析，必须不是 root。应用不会为普通 Worker 更新自动提权安装策略；更新器在停止旧服务之前仅执行只读命名空间探针。隔离不可用时，旧服务和对话保持不变，直到先决条件得到解决。

`--user` 只选择探针账号；AppArmor 例外绑定系统程序，对使用同一 `/usr/bin/bwrap` 的所有用户生效。新增前，助手会有界检查内核的策略绑定元数据和全局策略身份。系统 parser 按根级策略加载规则校验语法，并展开有界、可信的 include 图，其中可包含策略目录之外的发行版配置。所有输入及祖先路径均须由 root 拥有且其他用户不可写，检查后还会复核文件身份和目录成员。子策略和规则正文按父级作用域处理，字面量花括号备选路径逐项核对。宽泛或未解析的绑定可能覆盖 bwrap、内核元数据未知或不完整、策略头语法不支持时，都需要管理员核查。

明确选择**退出**时，应用先暂停工作，再保存正在运行的受管 VM。若连接离线，且本次虚拟化平台检查确认同一受管 VM 已保存或关闭，退出会保留其非运行状态，无须连接客户机。Hyper-V 检查可能请求管理员授权。身份、权限或电源状态无法确认时，退出仍保持未确认。安装更新仍须先确认客户机准备完成，再挂起 VM。

服务升级结果未确认时，系统保留该次操作记录并阻止自动重新安装。Reconnect 可以恢复客户机连接，但不代表这次升级已经解决。恢复前应核对更新状态；更改连接或删除操作记录，都不能证明之前的升级已经停止。

新工作电脑使用经过校验的便携备份，由用户明确恢复。另有仅供操作者使用的旧版 importer，可把早期 manifest/state/files 导出包导入空目标，不是自动连接步骤。两种方式保留来源数据，拒绝覆盖其他对话。Codex 自行保存和刷新认证，部署不读取或打包认证文件。

```powershell
# 提交源码并运行 npm run package:resources 后，先退出已有 Controller。
$dantResources = (Resolve-Path .\src-tauri\resources).Path
$dantData = Join-Path $env:APPDATA 'com.dant.desktop\data'

# 使用该目录已有 vm.json 单独部署，不启动 Windows UI。
& "$dantResources\dant-core.exe" --role=controller --root $dantResources --data-dir $dantData --deploy-worker

# 仅展示安装准备界面，不自动连接 Worker
& "$dantResources\dant-core.exe" --role=controller --root $dantResources --data-dir $dantData --prepare
```

VM 权威数据为 `~/dant/data/`，工作目录为 `~/dant/workspaces/<conversationId>/`，程序版本保存在 `~/dant/releases/`。诊断用户服务时使用 `systemctl --user status dant-worker dant-guest-local` 和 `journalctl --user -u dant-worker`；不要把包含私人聊天的日志原文提交仓库。

## 选择创建方式

设置 →“创建工作电脑”提供自动选择、Hyper-V、VMware Workstation。检测只读取本机可用软件。自动选择保留已有配置，否则先选可用的 Hyper-V，再选 VMware；显式选择失败后不会切换另一软件。Hyper-V 创建需要 Windows 管理员授权，VMware 复用本机 Workstation 工具，无需 Hyper-V 提权。两种流程都不会覆盖有效的已有连接来创建另一台 VM。

VMware 的命令、目录和恢复步骤见 [VMware 说明](vmware.md)。下文镜像离线准备细节适用于 Hyper-V。已有电脑直接使用 SSH 连接路径。

## 连接已有工作电脑

已有 Ubuntu VM 可运行在 VMware、Hyper-V 或其他虚拟化软件中。导入或手动连接只使用 SSH，不创建 VM、不转换磁盘。来宾需提供 SSH 密钥访问、Python 3、可用图形桌面，以及通过 VM 运行检查的普通用户；部署 Worker 不会把纯服务器系统自动变成图形桌面。

安装版和桌面启动器默认使用 `%APPDATA%\com.dant.desktop\data`；显式设置 `DANT_DATA` 时使用所选目录。旧版开发环境通常把连接资料保存在项目的 `data` 目录。数据目录不一致不表示 VM 需要重建。

Controller 只从当前目录、已知项目的 `data`、显式指定的 `DANT_VM_PROFILE_DIR` / `DANT_VM_PROFILE_DIRS`，以及当前用户此前运行并验证过的目录注册表中发现连接。不递归搜索磁盘。当前有效的 `vm.json` 优先保留；只有一个不同的有效来源时自动导入，多个来源则需要在设置中明确选择。也可手动输入旧版 `vm.json` 所在的绝对目录。相同 SSH 地址、用户和私钥路径的重复资料只计为一个来源。

Windows 用户注册表文件为 `%LOCALAPPDATA%\dant\vm-profiles.json`，仅记录当前账户的配置目录路径，不保存私钥内容。

导入只保存 SSH 连接字段，并将相对私钥与 `known_hosts` 路径解析为原目录的绝对路径；不会复制私钥内容、聊天记录、服务状态或其他账户资料。请保留原目录中的私钥。AppData 中已有的新密钥、旧安装失败记录均不会被删除。界面在显式导入成功后继续连接；导入 API 本身不启动连接，也不重新创建 VM。

`GET /api/vm/profiles` 返回当前配置与候选；`POST /api/vm/import` 接受 `{id}` 或 `{directory}`，已有有效连接时拒绝覆盖。未配置连接或密钥丢失时，连接操作会提示导入旧目录或选择现有密钥，不再直接显示裸 `ENOENT`。

过去的 `failed:*` 安装状态不阻止已有效配置的 VM 自动连接。只有仍在准备、创建、安装或等待管理员授权的过程会推迟自动连接；失败日志仍保留用于排障。如果所选虚拟化软件提示同名 VM 已存在，应先找回原来的连接资料，不要因为新数据目录缺少 `vm.json` 就重新生成种子或重建电脑。

## Hyper-V 初始化

需要已启用 Hyper-V 的 Windows、OpenSSH 客户端、Python 3、可访问 Ubuntu 和 npm 软件源的网络。镜像压缩包约 810 MiB，解压后的固定 VHD 约 30 GiB；转换时还需要动态 VHDX 的额外空间。下载准备可在普通 PowerShell 中执行，创建/启动 Hyper-V VM 由 Windows 要求管理员权限，应用启动时可能出现 UAC 提示。

在项目目录执行：

```powershell
.\scripts\prepare-vm.ps1
# 以下命令需要管理员 PowerShell，或由应用的 VM 安装入口调起。
.\scripts\create-vm.ps1
.\scripts\check-vm.ps1
```

安装版可以给三个脚本传相同的 `-DataDirectory` 绝对路径，例如：

```powershell
$dantData = Join-Path $env:APPDATA 'com.dant.desktop\data'
.\scripts\prepare-vm.ps1 -DataDirectory $dantData
.\scripts\create-vm.ps1 -DataDirectory $dantData
.\scripts\check-vm.ps1 -DataDirectory $dantData
```

自定义数据目录内包含 `cache/vm`、`tools/python`、`vm`、`logs`、SSH 密钥和 `vm.json`。不传此参数时，继续使用项目下的 `data`、`.cache/vm`、`.tools/python`。`vm-key` 是私钥，不应上传、提交或粘贴到日志。脚本只读取公钥生成种子 ISO。

`prepare-vm.ps1` 下载官方 Ubuntu 24.04 Azure VHD 压缩包并核对 SHA256，创建 ed25519 SSH 密钥和 NoCloud ISO。普通用户 `dant` 默认没有 sudo 权限、没有密码登录、不能 root SSH 登录。如果明确需要让 VM 内代理有 sudo 权限，首次准备时可传 `-AdminSudo`；这个选项会影响代理在 VM 内的权限。

种子的 `instance-id` 使用公钥的 SHA256 十六进制摘要前 20 位，保持稳定且可安全用于文件路径。不能直接使用公钥 base64 片段，因为其中可能包含 `/`。

SSH 密钥由 `scripts/vm-key.py` 使用 Python 参数数组调用 OpenSSH，避免 PowerShell 5/7 对空口令参数的不同解释。准备阶段只打印生成/验证/修复结果。已有无口令密钥会校验私钥与公钥是否匹配；仅当文件名是 `vm-key`、私钥能用早期脚本的双引号口令解密、私钥和公钥都带 `dant-local-vm` 注释且公钥匹配时，才自动清除这个遗留口令。原密钥、公钥文件及注释保持一致。其他加密密钥、陌生注释或不匹配的公钥都会报错并保持原文件。

`create-vm.ps1` 选择已有 Default Switch，检查原始盘没有挂载或被其他 VM 注册使用，然后准备 NoCloud 配置、转换动态 VHDX、扩容、注册第一代 Hyper-V VM、挂载 ISO 并启动。获得 IP 后保存 `vm.json`。此时软件安装可能仍在进行，必须以 `check-vm.ps1` 的结果判断就绪。

Windows `tar` 可能把官方镜像解压为 NTFS 稀疏文件，而 Hyper-V 转换这类文件会报 `0xC03A001A`。脚本在 NoCloud 准备后、转换前，仅对已确认未挂载/未被 VM 使用的官方原始 VHD 执行 `fsutil sparse setflag <源VHD> 0`，把空洞分配为普通磁盘空间；不会修改宿主目录的压缩/加密设置。为避免转换中途耗尽磁盘，稀疏源盘要求预留两倍源盘逻辑大小加 1 GiB；当前镜像约需要 61 GiB 可用空间。非稀疏源盘要求预留一倍源盘逻辑大小加 1 GiB。操作后会验证文件长度、属性、VHD/文件系统配置，并再次检查空间。源文件或目标目录被压缩/加密时，脚本清楚报错，需选择合适的数据目录。

VM 中 `dant-bootstrap.service` 自动安装 XFCE、Xvfb、截图和输入工具、字体、Firefox、Codex CLI。下载失败会重试，整个初始化失败后 systemd 也会重新运行。只有 X 显示可访问、三个桌面服务正常、实际截图返回 PNG、Codex 可执行时，才写 `/home/dant/work/.dant-ready`。就绪检查退出码 0 表示成功，1 表示尚未就绪。

## Azure 镜像为何需要离线准备

当前官方镜像的 `/etc/cloud/cloud.cfg.d/90_dpkg.cfg` 指定 `datasource_list: [ Azure ]`。这会阻止第一次开机读取 NoCloud 光盘；把 NoCloud 设置写在光盘的 user-data 中也来不及改变数据源发现。

`scripts/patch-image.py` 在创建 VM 前，只对未挂载的原始固定 VHD 中该普通配置文件做一次等长替换：

```text
datasource_list: [ Azure ]
datasource_list: [NoCloud]
```

工具验证固定 VHD footer 及校验和、保护 MBR、GPT header/table CRC、唯一 Linux 分区、ext4 block/inode/descriptor 布局、目录路径、extent 范围及文件原始全文。遇到未知布局或配置立即报错；不挂载磁盘、不修改文件长度或文件系统元数据，也不处理已有 VHDX。写入前把原字节、替换字节、物理偏移和 footer 指纹保存到 `cache/vm/image-patch-audit.json`，随后刷盘并复读验证。重复运行只接受匹配的原始审计记录。

该方式针对当前官方 Azure GPT/ext4 镜像布局。后续官方镜像若更改布局，工具可能拒绝处理；应先检查新镜像，不能跳过验证或直接全盘搜索替换。

只读检查示例：

```powershell
python .\scripts\patch-image.py .\data\vm\livecd.ubuntu-cpc.azure.vhd
```

资料：[cloud-init 数据源配置](https://docs.cloud-init.io/en/latest/reference/datasources.html)、[NoCloud 数据源](https://docs.cloud-init.io/en/24.2/reference/datasources/nocloud.html)、[Microsoft 对 Azure 镜像数据源的说明](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/create-upload-ubuntu)、[Windows 清除稀疏标记时分配空洞的行为](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/6a884fe5-3da1-4abb-84c4-f419d349d878)。

## 状态和日志

Windows 的 `data/vm-setup-status.json` 保存阶段、最近更新时间、日志路径和错误。安装版中对应所选数据目录。Hyper-V 的 `data/logs/create-vm-*.log` 保存管理员脚本完整 transcript，VMware 日志位于 `data/vmware/logs/`。状态记录包含 provider。Hyper-V 常见阶段：

| 阶段                                | 含义                              |
| ----------------------------------- | --------------------------------- |
| `extracting-image`                  | 解压原始 VHD                      |
| `configuring-nocloud`               | 校验并准备初次启动配置            |
| `allocating-source-disk`            | 清除源 VHD 稀疏标记并分配其空洞   |
| `converting-disk` / `resizing-disk` | 创建和扩容动态磁盘                |
| `registering-vm` / `booting-vm`     | 注册并启动 Hyper-V VM             |
| `waiting-for-ip`                    | 等待 Hyper-V 集成服务报告 IPv4    |
| `guest-installing`                  | 已保存 SSH 连接，等待 VM 软件安装 |
| `ready`                             | 就绪检查已实际通过                |
| `failed:<阶段>`                     | 读取 error 字段及指定日志定位失败 |

查看来宾安装状态：

```powershell
.\scripts\check-vm.ps1 -Diagnostics
```

此命令会输出 cloud-init 状态、桌面和初始化服务状态、初始化 journal、`/var/log/dant-bootstrap.log` 的末尾。默认 `dant` 用户属于 `adm`，可读取这些安装日志。

## 中断后恢复

- **已有同名 VM：** 默认创建脚本立即停止并保留 VM。确认它使用该数据目录下的 `vm/dant.vhdx` 后，使用 `create-vm.ps1 -Resume` 启动或继续等待 IP、刷新 `vm.json`；不会替换磁盘或重新初始化系统。
- **IP 超时或网络变化：** 检查 Hyper-V Manager 中该 VM 的状态和 Default Switch，再使用 `-Resume` 刷新地址，重启 dant 读取连接。
- **只有原始 `.vhd`，没有 `.vhdx` 和 VM：** 查看旧日志确认失败点后，可以重新运行创建脚本。原始盘会先重新校验；补丁有审计，可识别已经完成的准备。
- **已有 `.vhdx`，尚未注册 VM：** 脚本拒绝覆盖。先根据日志检查转换或扩容是否完成、磁盘是否被其他 VM 使用，再由维护者决定如何接续注册。不要删除磁盘来规避错误。
- **网络临时失败：** 初始化服务会自动重试。查看 `-Diagnostics`，等网络恢复后再次检查。
- **SSH 能连接但没有 ready：** 检查 `dant-bootstrap.service` 和安装日志；首次桌面安装需要时间。SSH 可用本身不能证明截图和 Codex 已可用。
- **SSH 无法连接：** 先确认地址和 VM 是否运行，检查 Windows OpenSSH 是否在 PATH 中、私钥路径是否仍存在。若 host key 发生变化，先核实连接目标，保留 `known_hosts` 中的证据进行排查。
- **已确认公钥一致，仍报 `Permission denied (publickey)`：** 检查 Windows 侧私钥是否意外带口令。早期脚本在 PowerShell 7 中传 `-N '""'` 会把两个双引号当作实际口令，导致 `BatchMode=yes` 无法签名。重新运行准备阶段会校验密钥并受限修复已确认的旧项目密钥；换种子 ISO不能解决 Windows 私钥加密问题。修复保持原密钥对，不需要重建 VM。

更换聊天模型或应用 mode 不会改变 Windows 对 Hyper-V/UAC 的权限要求。管理员启动失败时，以安装入口日志和 Windows 返回的具体错误为准。

## 本地验证

```powershell
python -m unittest discover -s tests/vm -p test_vm.py -v
python -m py_compile scripts/seed.py scripts/patch-image.py scripts/vm-key.py vm/desktop.py vm/guest.py
```

测试使用合成 VHD 验证只修改等长配置字节、审计不被覆盖、损坏镜像和未知配置被拒绝，验证拖动中断时释放鼠标按钮，回读种子 ISO 检查路径安全的实例 ID 和禁用 sudo 时的 null 配置，并在临时目录生成机器密钥验证空口令、已确认旧密钥修复、未知加密密钥/陌生注释/公钥不匹配时拒绝修改。这些检查不能替代真实 VM 的首次启动、联网安装和桌面验证。
