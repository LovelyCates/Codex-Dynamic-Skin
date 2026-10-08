# LovelyCates 个人维护版

仓库：https://github.com/LovelyCates/Codex-Dynamic-Skin

本项目保留 CCDawn/Codex-Dynamic-Skin 的 Git 历史与 MIT 许可；其基础来自 Fei-Away/Codex-Dream-Skin。个人修改主要面向 Windows，原作者版权声明保持不变。

## 分支与更新来源

- `origin`：LovelyCates/Codex-Dynamic-Skin，个人开发与构建。
- `upstream`：CCDawn/Codex-Dynamic-Skin，动态壁纸上游。
- `personal/windows-current`：个人仓库的默认维护分支，包含 Windows 适配与个人构建流程。
- `main`：保留最初复刻的上游基线，避免个人修改混入同步参考。
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

## Wallpaper Engine 场景转视频

个人 EXE 包含普通 MP4/WebM 视频播放所需运行时，但不包含 `scene.pkg` 所需的 `SceneViewer.exe`。上游当前仅提供场景通信接口，独立侧车包、对应源码与兼容性验证仍未完成；不能把扫描到场景文件当作已经能播放。

个人管理器允许导入场景引用。未安装实时侧车时，选择场景后点击“转换为循环视频”：首次从 [WPE Baker 2.0.0 官方 Release](https://github.com/isshiki-works/wpe-baker/releases/tag/v2.0.0) 下载约 91 MiB 工具包，核对固定 SHA-256 后安装；复用时逐项验证缓存完整性。保留原包许可证与源码说明，依赖不嵌入 MIT 管理器，也不随本仓库重新分发。GPL/LGPL 对应源码包在同一上游 Release。不要下载任意同名 `SceneViewer.exe`：文件名相同不代表流协议兼容。

转换要求 Windows Vulkan 显卡、同一 Steam 库内已安装 Wallpaper Engine 的 assets，以及至少 2.5 GB 临时空间。输出为 1280×720、24 fps、12 秒静音 H.264 视频，尾部用 1 秒交叉淡化衔接循环；这不等于原场景的自然周期。生成文件加入壁纸库，用户预览并选择后才应用，不自动切换主题。鼠标、音频、时钟等实时互动不会保留；第三方渲染器不保证兼容所有场景。

普通视频仍可通过 Wallpaper Engine 入口或“添加壁纸”直接导入 MP4/WebM。场景转换已经在一张本地壁纸上验证渲染与编码；真实 Codex 中的显示仍需完成启动后的实机检查。

## 每次 Codex 更新后的检查

1. 分别记录应用显示版本和 Windows Store 包版本，两者可能不同。
2. 检查包路径、签名、界面选择器；仅静态源码存在不能证明实际渲染正确。
3. 修改共享源后执行 `node tools/sync-runtime-assets.mjs`，再执行 `--check`、两端 payload 校验以及 Node/PowerShell 回归。
4. 用独立测试会话验证首页、普通聊天页、输入框、侧栏、静态图、视频循环、暂停和恢复。保留版本与截图证据，不提交个人对话或登录信息。
5. 首次皮肤会话可能需要重新登录受管 profile；正在工作的 Codex 需要重启时，先完成当前任务并告知用户。

初始适配目标为 Codex `26.1002.52244`。实时渲染与恢复尚未验收时，不标注“完全兼容”。不承诺自动兼容未来所有版本。

2026-10-08 已核对的变化：Windows Store 包 `26.1002.7124.0` 内对应产品版本 `26.1002.52244`；首页工具栏由旧 CSS Module 变为 home rail item，Markdown 根节点改为 `_MarkdownRoot_`。个人版补充对应选择器并保留旧版路径。静态包核对与独立浏览器重建 DOM 测试通过；真实 Codex 的视频播放和恢复仍待验证。

2026-10-09 启动排障：实机 CDP 确认当前版本会保留隐藏标签页的首页 DOM。运行时与两端验证器现在区分可见候选，隐藏首页不会误判当前路由；窗口不可见等硬检查继续保留。Windows 一次性应用及重新加载修正了主题参数传递错误。管理器启动诊断现在保留错误详情，并在父进程退出后有界排空输出，避免后台进程继承管道导致卡住；普通壁纸列表 JSON 不截断。

若前一次失败留下没有管理状态的调试会话，用户明确确认重启后会重建会话；不自动关闭未授权的 Codex 窗口。排障中实际注入与当前任务路由识别已验证，但当时调试实例没有可见主窗口，完整显示验收仍需使用新版管理器确认重启后进行。场景播放组件缺失的限制不受此次修复影响。

## 发布

保持个人版本递增，同步项目要求的全部版本来源和管理器版本。通过 CI、包自检与实机验证后再创建 Release；不要覆盖已有公开版本。个人下载、更新与发布链接应指向个人仓库，上游鸣谢链接继续保留。

本次没有设置定时同步或自动升级；后续同步由维护者按需触发。
