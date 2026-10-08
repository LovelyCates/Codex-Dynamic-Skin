# LovelyCates 个人维护版

仓库：https://github.com/LovelyCates/Codex-Dynamic-Skin

本项目保留 CCDawn/Codex-Dynamic-Skin 的 Git 历史与 MIT 许可；其基础来自 Fei-Away/Codex-Dream-Skin。个人修改主要面向 Windows，原作者版权声明保持不变。

## 分支与更新来源

- `origin`：LovelyCates/Codex-Dynamic-Skin，个人开发与构建。
- `upstream`：CCDawn/Codex-Dynamic-Skin，动态壁纸上游。
- `personal/windows-current`：当前 Windows 适配开发分支。
- Windows 客户端的更新检查指向个人仓库。尚未创建 Release 时会报告检查失败；这不代表已是最新版，也不会回退下载上游包。

按需同步上游，在独立分支解决冲突并验证：

```powershell
git fetch upstream
git switch -c maintenance/sync-upstream
git merge upstream/main
```

尤其核对 `tools/selectors.json`、`runtime/`、管理器嵌入文件清单和 Windows 启动器。不要直接覆盖个人代码或强推主分支。

## Windows 构建

GitHub Actions 的 `Personal Windows manager` 工作流生成单文件 EXE 与 SHA-256，产物在该次运行的 Artifacts 中。构建产物不自动代表已发布或已通过实机换肤验证。

本机构建需要 .NET 8 SDK 与 Node.js 22+：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File windows/app/build-manager.ps1
```

输出位于 `windows/dist/`。构建、自检与回归不应重启 Codex 或修改官方应用包。

## 每次 Codex 更新后的检查

1. 分别记录应用显示版本和 Windows Store 包版本，两者可能不同。
2. 检查包路径、签名、界面选择器；仅静态源码存在不能证明实际渲染正确。
3. 修改共享源后执行 `node tools/sync-runtime-assets.mjs`，再执行 `--check`、两端 payload 校验以及 Node/PowerShell 回归。
4. 用独立测试会话验证首页、普通聊天页、输入框、侧栏、静态图、视频循环、暂停和恢复。保留版本与截图证据，不提交个人对话或登录信息。
5. 首次皮肤会话可能需要重新登录受管 profile；正在工作的 Codex 需要重启时，先完成当前任务并告知用户。

初始适配目标为 Codex `26.1002.52244`。实时渲染与恢复尚未验收时，不标注“完全兼容”。不承诺自动兼容未来所有版本。

## 发布

保持个人版本递增，同步项目要求的全部版本来源和管理器版本。通过 CI、包自检与实机验证后再创建 Release；不要覆盖已有公开版本。个人下载、更新与发布链接应指向个人仓库，上游鸣谢链接继续保留。

本次没有设置定时同步或自动升级；后续同步由维护者按需触发。
