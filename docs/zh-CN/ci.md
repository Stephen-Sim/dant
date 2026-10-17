# CI 与 Windows 构建

[English](../ci.md) · 简体中文

参考 [Codex 的工作流分工](https://github.com/openai/codex/blob/main/.github/workflows/README.md)，本项目将跨平台检查与 Windows 打包分开。两个工作流都响应所有分支的 push、pull request 和手动运行，默认分支为 `master`。标签构建不会被后续运行取消。

`CI` 在 Ubuntu 24.04 与 Windows 2025 上使用 Node.js 22、Python 3.12，执行 `npm ci`、后端测试、Python VM 辅助测试及前端构建。固定安装 `pycdlib==1.14.0` 并检查 OpenSSH，防止种子镜像和 SSH 密钥测试因缺少工具被跳过。Windows 的 DPAPI 测试使用临时测试密钥；Linux 会按测试声明跳过这项 Windows 专属检查。Bash 与 PowerShell 脚本只做语法解析，不创建 VM、不提权、不进行真实模型或语音 API 调用。

`Windows build` 在 Windows 2025 上先执行同样的 Node/Python 检查，再使用 Rust 1.99.1 和 `cargo --locked` 构建 Tauri NSIS 安装包。Rust 缓存仅保存依赖和编译中间文件，不缓存用户数据、VM 镜像或打包输出。没有平台签名密钥也可以构建，当前产物未签名。

每次成功构建上传一个保留 14 天的 Actions artifact，包含：

- `dant_<version>_windows_x64_setup.exe`：NSIS 安装包。
- `dant_<version>_windows_x64_portable.zip`：解压后运行 `dant.exe`，同目录的 `backend/` 包含 Windows Node.js、服务代码、前端、依赖与 VM 脚本，必须一起保留。
- `dant_<version>_windows_x64_build.json`：版本、提交、构建链接、Node/Rust 版本、产物大小与 SHA-256。
- `SHA256SUMS`：安装包、ZIP 和构建 JSON 的 SHA-256；下载后可用 `sha256sum --check SHA256SUMS` 校验。

普通构建也要求 `package.json`、`src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 版本一致。发布前先更新三个文件并同步各自锁文件，再推送精确匹配的 `v<version>` 标签（例如 `v0.1.0`）。版本不符会在编译前失败。

只有 `v*` 标签的 push 会在测试和打包成功后进入独立的 draft release job。该 job 校验下载文件的哈希、版本、提交和标签，创建 GitHub Release 草稿；重跑只允许替换已有草稿的附件，若已经正式发布则拒绝覆盖。发布草稿仍需维护者在 GitHub 上检查并手动发布。手动运行或 PR 不创建 Release。

普通 job 仅有 `contents: read`，`contents: write` 只授予 draft release job。工作流不需要仓库机密或 OpenAI API Key，第三方 Actions 固定到完整提交 SHA；版本更新时应同时检查 SHA 和注释版本。

本地可执行静态检查与版本门禁：

```powershell
npm run test:coverage
node scripts/ci/version.mjs
node --test scripts/ci/version.test.mjs
node scripts/ci/preflight.mjs
pwsh -File scripts/ci/check-powershell.ps1
```

预检要求 Python 已安装上述 pycdlib 版本，Windows 已安装 OpenSSH Client 与 Git Bash。GitHub 托管的 runner 已提供这些基础工具；预检会在环境不符时明确失败。

覆盖率报告保存在 `.cache/coverage/`，包含测试全文、LCOV、JSON 和 Markdown 汇总，CI 上传两种平台的报告。覆盖率门禁同时检查全局比例、关键新增模块和缺失的模块；浏览器入口通过渲染及事件测试另行验证。模拟 Bot API 不使用真实 Telegram Token，也不向真实账号发消息。单元覆盖率不能代替真实设备验收。

全局门槛为行覆盖率 90%、分支 80%、函数 80%；Controller、VM 连接与配置发现、Telegram、外观模块还各自要求行覆盖率至少 90%。每个服务模块和 UI 辅助模块都必须出现在报告中，不能通过不导入新模块来虚增比例。
