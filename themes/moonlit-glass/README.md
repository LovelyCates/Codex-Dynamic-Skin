# 清音 · 月白琉璃

适配冰蓝、月白色场景视频的个人配套样式：淡蓝玻璃侧栏、圆角消息面板、月白输入框和淡紫点缀。只装饰 Codex 原生主题部件。

这里保存的是配置与 Safe CSS 源文件，不是可直接导入的主题 ZIP。`theme.template.json` 的 `background.mp4` 是本地媒体占位文件；仓库不分发壁纸视频。

在仓库根目录的 PowerShell 中使用自己拥有使用权限的本地视频：

```powershell
. ./windows/scripts/common-windows.ps1
. ./windows/scripts/theme-windows.ps1
$theme = Get-Content ./themes/moonlit-glass/theme.template.json -Raw -Encoding UTF8 | ConvertFrom-Json
$backup = Save-DreamSkinCurrentTheme -Name '应用月白琉璃前备份'
Set-DreamSkinActiveTheme -ImagePath '<本地视频的绝对路径.mp4>' -Theme $theme -SafeCssPath ./themes/moonlit-glass/theme.css
Save-DreamSkinCurrentTheme -Name '清音 · 月白琉璃'
```

已有活动主题时先备份。应用后在管理器中重新应用；以后通过“已保存主题”切换，单独重新选择壁纸会移除配套 CSS。需要恢复时在“已保存主题”选择备份。

视频仅走可信本地媒体流程，不属于普通图片主题 ZIP 导入合同。样式不会添加参考图中的虚构按钮、改写原生功能或隐藏聊天内容；实际部件覆盖取决于当前 Codex 版本。场景预渲染视频不保留 Wallpaper Engine 的鼠标、音频交互。
