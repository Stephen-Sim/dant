# CI 与 Windows 构建

[English](../ci.md) · Chinese

参考 [Codex 的工作流分工](https://github.com/openai/codex/blob/main/.github/workflows/README.md)，本项目将跨平台检查与 Windows 打包分开。CI、Go core 与 Windows build 工作流都响应所有分支的 push、pull request 和手动运行，默认分支为 `master`。标签构建不会被后续运行取消。

`CI` 在 Ubuntu 24.04 与 Windows 2025 上使用 Node.js 22.18+、Python 3.12，执行 `npm ci`、后端测试、Python VM 辅助测试及前端构建。固定安装 `pycdlib==1.14.0` 并检查 OpenSSH，防止种子镜像和 SSH 密钥测试因缺少工具被跳过。Windows 的 DPAPI 测试使用临时测试密钥；Linux 会按测试声明跳过这项 Windows 专属检查。Bash 与 PowerShell 脚本只做语法解析，不创建 VM、不提权、不进行真实模型或语音 API 调用。

`Windows build` 在 Windows 2025 上执行 Node/Python、生成契约、固定 Go 格式/vet/包测试和 Memory 一致性检查，再构建 Go 运行资源，并使用 Rust 1.99.1 和 `cargo --locked` 构建 Tauri NSIS 安装包。Rust 缓存仅保存依赖和编译中间文件，不缓存用户数据、VM 镜像或打包输出。没有平台签名密钥也可以构建，当前产物未签名。

浏览器、工具和保留的 Node 兼容测试使用 TypeScript，生产后端功能使用 Go。严格编译分别检查 Node 源码、浏览器源码与全部 Node 测试。测试按模块放入 `tests/<module>/`，UI 测试对应 `ui/`，共享夹具位于 `tests/support/`，Python VM 测试位于 `tests/vm/`。普通测试与覆盖率共用递归发现逻辑和最多四个隔离测试进程，限制桌面与 CI 资源占用。

独立的 `Go core` 工作流在 Windows 和 Ubuntu 上固定使用 Go 1.27.2，检查生成契约、`gofmt`、`go vet`、全部 Go 包测试及隔离的 Node/Go Memory 一致性。Linux 另行运行 race 检测。Go 测试与所属功能包相邻。显式一致性工具构建私有的无 CGO 辅助进程，仅使用夹具 SQLite 快照；普通 Node 测试不要求 Go 编译器。延迟报告只描述合成负载，不能证明生产性能提升。生产资源已切换为独立编译的 Go Controller/Worker 目标；影子 reader 仅作夹具差分工具，不具有生产执行权。

CI 保留格式、严格 TypeScript 与状态域检查，Go 工作流增加全部包检查和 Linux race 检测。Windows 发布 job 也独立执行 Go 与兼容性门禁。Windows 打包 job 自己执行这些门禁，标签不能依赖另一个 `CI` 工作流中尚未确认的结果就生成发布草稿。

每次成功构建上传一个保留 14 天的 Actions artifact，包含：

- `dant_<version>_windows_x64_setup.exe`：NSIS 安装包。
- `dant_<version>_windows_x64_portable.zip`：解压后运行 `dant.exe`，同目录的 `backend/` 包含 `dant-core.exe`、Linux Worker 程序、前端、固定宿主/VM 辅助文件、协议 JSON、来源清单与许可证，必须一起保留；不包含后端 TypeScript、Node 程序或 `node_modules`。
- `dant_<version>_windows_x64_build.json`：版本、提交、构建链接、Go/Rust 版本、构建工具 Node 版本、产物大小与 SHA-256，运行时元数据标记为 `go`。
- `SHA256SUMS`：安装包、ZIP 和构建 JSON 的 SHA-256；下载后可用 `sha256sum --check SHA256SUMS` 校验。

Go 资源固定使用 Go 1.27.2、`CGO_ENABLED=0`、`-trimpath` 与来自干净提交的版本/源码信息。构建、VM bundle 和完整资源清单在复制或打包前验证固定路径、长度和 SHA-256，也覆盖宿主辅助脚本和 UI。编译期间源码变化或二进制过期/被修改都会使准备失败，已发布资产不能覆盖。

普通构建也要求 `package.json`、`src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 版本一致。发布前先更新三个文件并同步各自锁文件，再推送精确匹配的 `v<version>` 标签（例如 `v0.1.0`）。版本不符会在编译前失败。

只有 `v*` 标签的 push 会在测试和打包成功后进入独立的 draft release job。该 job 校验下载文件的哈希、版本、提交和标签，创建 GitHub Release 草稿；重跑只允许替换已有草稿的附件，若已经正式发布则拒绝覆盖。发布草稿仍需维护者在 GitHub 上检查并手动发布。手动运行或 PR 不创建 Release。

普通 job 仅有 `contents: read`，`contents: write` 只授予 draft release job。工作流不需要仓库机密或 OpenAI API Key，第三方 Actions 固定到完整提交 SHA；版本更新时应同时检查 SHA 和注释版本。

本地可执行静态检查与版本门禁：

```powershell
npm run format:check
npm run typecheck
npm run check:states
npm run check:contracts
npm run check:core
npm run test:core:parity
npm run test:coverage
python -m unittest discover -s tests/vm -p "test_*.py" -v
node scripts/ci/version.mts
node --test scripts/ci/version.test.mts
node scripts/ci/preflight.mts
pwsh -File scripts/ci/check-powershell.ps1
npm run build
```

预检要求 Node.js 22.18+ LTS 或 24+，支持原生 TypeScript、内置 SQLite 和 FTS5，并要求 Python 已安装上述 pycdlib 版本、Windows 已安装 OpenSSH Client 与 Git Bash。有时限的内存 FTS5 查询会验证实际运行能力，不能只检查版本字符串；该 Node 门禁用于 UI/工具/参考测试，不是部署后 Go Worker 的前提。资源准备另外验证固定 Go 编译器与编译产物清单；VM 激活前验证 Linux 程序、源码来源与已有数据。GitHub 托管的 runner 已提供这些基础工具，环境不符时会明确失败。

覆盖率报告保存在 `.cache/coverage/`，包含测试全文、LCOV、JSON 和 Markdown 汇总，CI 上传两种平台的报告。覆盖率门禁同时检查全局比例、关键新增模块和缺失的模块；浏览器入口通过渲染及事件测试另行验证。模拟 Bot API 不使用真实 Telegram Token，也不向真实账号发消息。单元覆盖率不能代替真实设备验收。

全局门槛为行覆盖率 90%、分支 80%、函数 80%；Controller、VM 连接与配置发现、Telegram、外观模块还各自要求行覆盖率至少 90%。每个服务模块和 UI 辅助模块都必须出现在报告中，不能通过不导入新模块来虚增比例。

本地启动前先提交已审查源码，运行 `npm run package:resources`，再执行 `npm start` 或 `npm run dev`。两者均启动经校验的 Go 后端，后者同时启动 Vite；原生 `desktop` 也先准备同一份资源。详见[运行支持](runtime-support.md)。完整测试、打包程序启动与用户设备验收是独立门禁，工作流定义不代表发布已完成。
