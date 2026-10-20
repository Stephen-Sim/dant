# CI 与 Windows 构建

[English](../ci.md) · Chinese

参考 [Codex 的工作流分工](https://github.com/openai/codex/blob/main/.github/workflows/README.md)，本项目将跨平台检查与 Windows 打包分开。CI、Go core 与 Windows build 工作流都响应所有分支的 push、pull request 和手动运行，默认分支为 `master`。标签构建不会被后续运行取消。

`CI` 在 Ubuntu 24.04 与 Windows 2025 上使用 Node.js 22.18+、Python 3.12、Go 1.27.2，执行 `npm ci`、浏览器与工具测试、状态检查、Python VM 辅助测试及前端构建。固定安装 `pycdlib==1.14.0` 并检查 OpenSSH，防止种子镜像和 SSH 密钥测试因缺少工具被跳过。Windows 的 DPAPI 测试使用临时测试密钥；Linux 会按测试声明跳过这项 Windows 专属检查。Bash 与 PowerShell 语法检查不创建 VM、不提权；PowerShell 覆盖率通过模拟宿主边界的行为夹具执行，不进行真实模型或语音 API 调用。

`Windows build` 在 Windows 2025 执行浏览器／工具与 Python 检查、生成契约、固定 Go 格式／vet／包测试和覆盖率，再构建 Go 资源及 Rust 1.99.1、锁定 Cargo 依赖的 Tauri NSIS 安装包。缓存仅保存依赖和编译中间文件，不缓存用户数据、VM 镜像或打包输出。当前产物未签名。

浏览器与工具使用 TypeScript，生产后端功能使用 Go。严格编译分别检查 Node 源码、浏览器源码与全部 Node 测试。测试按模块放入 `tests/<module>/`，UI 测试对应 `ui/`，共享夹具位于 `tests/support/`，Python VM 测试位于 `tests/vm/`。普通测试与覆盖率共用递归发现逻辑和最多四个隔离测试进程，限制桌面与 CI 资源占用。

TypeScript、Go Core、原生 Rust 和 Python 辅助工具分别测量覆盖率，各报告注明实际源码范围；通过 Node 运行 TypeScript 测试，不会测出其它语言的覆盖率。测试数量和进程成功属于行为证据，不是覆盖率百分比，不能把不同运行时平均成一个比例。

UI TypeScript 要求总体至少 90% 行、80% 分支、80% 函数覆盖率，appearance 单模块至少 90% 行，全部 UI helper 必须出现在报告。`npm run check:core` 对全部 Go 包运行 atomic 语句覆盖率，全部功能包必须出现，Controller、Computer（含连接发现与 VM 传输）、Telegram 各自至少 90%。重复插桩块只计一次，以未四舍五入的计数判断。必须使用新的私有 profile，进程失败或缺少报告不能复用旧成功结果。浏览器入口另有渲染和事件夹具。参见[测试归属](testing.md)。

独立 `Go core` 工作流在 Windows 和 Ubuntu 固定使用 Go 1.27.2，检查生成契约、`gofmt`、`go vet`、全部包测试和关键功能覆盖率，Linux 另运行 race。Go 测试集中在镜像包路径的 `tests/go/`，统一入口显式传入编译器 overlay 以保留包内访问；裸 `go test ./...` 不会发现外部测试树。

`npm run check:states` 同时解析已接入的 Go 范围与 UI AST，因此需要固定 Go 工具链。缺失范围、原始状态值、非法报告和混淆状态域均会失败。普通 Node 单测注入检查进程，集成状态命令运行真实解析器；主 CI 和 Windows 打包均安装固定编译器。

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
npm run test:coverage
npm run test:native:coverage
npm run test:python:coverage
npm run test:powershell:coverage
npm run coverage:inventory
python -m unittest discover -s tests/vm -p "test_*.py" -v
node scripts/ci/version.mts
node --test tests/tooling/build/version.test.mts
node scripts/ci/preflight.mts
pwsh -File scripts/ci/check-powershell.ps1
npm run build
```

预检要求 Node.js 22.18+ LTS 或 24+ 的原生 TypeScript、固定 pycdlib、OpenSSH Client 及 Windows 上的 Git Bash。资源准备独立验证固定 Go 编译器和程序清单；VM 激活核对 Linux 程序、源码及现有数据。缺少工具会明确失败，源码覆盖率不能替代实机验收，参见[验收](verification.md)。

覆盖率报告保存在 `.cache/coverage/`，包含测试全文、LCOV、JSON 和 Markdown 汇总，CI 上传两种平台的报告。覆盖率门禁同时检查全局比例、关键新增模块和缺失的模块；浏览器入口通过渲染及事件测试另行验证。模拟 Bot API 不使用真实 Telegram Token，也不向真实账号发消息。单元覆盖率不能代替真实设备验收。

Go profile 与语句汇总保存在 `.cache/core/coverage.out`、`.cache/core/coverage.json`、`.cache/core/coverage.md`，由核心工作流及 Windows 打包上传。每个功能包还必须至少执行一条语句；仅用 `-coverpkg` 列出全零插桩块不能算加载覆盖。总体按已覆盖／全部唯一语句加权，不是包百分比的算术平均；报告列出全部发现的包及关键包的独立门禁。

## 覆盖率报告

各覆盖率命令通过 `GITHUB_STEP_SUMMARY` 自动向 GitHub job summary 追加独立语言标题。Windows 打包 job 集中展示这些报告，并把原始测量作为 Actions artifact 上传；Go core 工作流也单独发布语句报告。查看各报告的源码范围和已覆盖／总数，不能把 TypeScript 结果当作整个应用的覆盖率。

| 范围                  | 指标                                                         | 报告                                                                           |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 浏览器 TypeScript     | UI 行、分支和函数，已有 UI 门禁保持独立。                    | `.cache/coverage/` 中的 LCOV、JSON 和 Markdown。                               |
| TypeScript 工具与入口 | 维护中的可执行源码，未加载文件也列为零。                     | `.cache/coverage/typescript/coverage-final.json`、`lcov.info`、`coverage.md`。 |
| Go Core               | 全局及各包的 atomic 可执行语句。                             | `.cache/core/coverage.out`、`coverage.json`、`coverage.md`。                   |
| 原生 Rust             | LLVM 源码行、函数和 region。                                 | `.cache/coverage/rust/coverage.json`、`lcov.info`、`coverage.md`。             |
| Python 辅助工具       | 可执行行和分支弧；至少 95% 行、90% 分支。                    | `.cache/coverage/python/coverage.json`、`coverage.xml`、`coverage.md`。        |
| PowerShell            | Pester 测量可执行命令，零命中脚本也在分母内；至少 95%。      | `.cache/coverage/powershell/coverage.json`、`coverage.xml`、`coverage.md`。    |
| Bash                  | Linux 上由固定 kcov 43 测量执行的 shell 行，包含零命中脚本。 | `.cache/coverage/bash/coverage.json`、`summary.json`、`coverage.md`。          |

改进目标是通过有实际意义的未覆盖行为和失败路径测试，让全部维护的可执行源码接近 100%。保留已有门槛，不能靠排除文件、把跳过平台算作执行、或编造门槛和结果来抬高比例。不可用的插桩和未测脚本必须继续显示为缺口；HTML／CSS 和生成声明不属于可执行语言覆盖率。覆盖率也不能证明真实硬件或外部服务已经验证成功。

`npm run coverage:inventory` 写入 `.cache/coverage/inventory.json`、`inventory.md` 并向 job summary 追加源码索引，记录源码提交／dirty 状态、平台及原始报告 SHA-256，检查源码是否在报告后变化，分别列出已测、零命中和未测文件。普通跨平台 CI 不运行全部原生采集器，对应行保持未测，不因此令库存失败或编造完整覆盖率；非法报告和不安全源码路径仍会失败。

原生覆盖率使用 Rust 1.99.1 的 `llvm-tools-preview` 及锁定的 `cargo-llvm-cov` 0.9.1。Python 使用 `scripts/ci/python-coverage-requirements.txt` 中的 coverage.py 7.16.2，安装到解释器环境以启用子进程插桩。PowerShell 使用 Pester 5.9.0，通过 `Save-Module` 保存到 `.tools/powershell/Modules`，再按精确 manifest 路径导入；其命令分母与行、分支覆盖率不同。Rust 测试模块位于 `tests/native/rust/`，仅通过 `#[cfg(test)]` 引入，LLVM 运行时代码报告不包含这些测试文件。

`npm run test:bash:coverage` 要求 Linux，以及从上游提交 `a39874f938ce13f7a65f253120d1ec946b349ffe` 构建的 kcov 43。CI 将其构建到 `.tools/kcov`，同时拉取 `v43`，校验其解引用提交与固定源码相同，并在 CMake 读取上游 Git 版本前校验精确标签；标签缺失或被移动都会令构建失败。DEBUG 跟踪使用 `tests/bash/runtime.test.sh`、隔离 HOME 和模拟命令执行原脚本；所有维护的 VM shell 脚本保留在清单中。内嵌 Python heredoc 属于不同执行范围，shell 行覆盖率不能证明它已执行。Windows 明确报告采集器不可用，不把平台跳过算作覆盖率。

每个包含可执行 shell 行的维护脚本都必须记录实际命中。清单完整但源文件全部零命中的结果会令采集失败；仅夹具进程通过不能证明插桩已跟踪生产脚本。失败报告仍保留用于诊断。

本地启动前先提交已审查源码，运行 `npm run package:resources`，再执行 `npm start` 或 `npm run dev`。两者均启动经校验的 Go 后端，后者同时启动 Vite；原生 `desktop` 也先准备同一份资源。详见[运行支持](runtime-support.md)。完整测试、打包程序启动与用户设备验收是独立门禁，工作流定义不代表发布已完成。
