[CmdletBinding()]
param([string]$Root)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
. (Join-Path $Root 'scripts\convert-scene-video.ps1')
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('dreamskin-scene-test-' + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($testRoot)
$script:SceneTestCount = 0
function Assert-Test([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
  $script:SceneTestCount++
}
function Assert-Rejected([scriptblock]$Action, [string]$Message) {
  $rejected = $false
  try { & $Action | Out-Null } catch { $rejected = $true }
  Assert-Test $rejected $Message
}
function New-TestArchive([string]$Path, [string[]]$Names, [int]$Attributes = 0) {
  $zip = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($name in $Names) {
      $entry = $zip.CreateEntry($name)
      $entry.ExternalAttributes = $Attributes
      $writer = New-Object IO.StreamWriter ($entry.Open())
      try { $writer.Write('fixture bytes for ' + $name) } finally { $writer.Dispose() }
    }
  } finally { $zip.Dispose() }
}
function Assert-ArchiveRejected([string[]]$Names, [int]$Attributes = 0) {
  $path = Join-Path $testRoot ([Guid]::NewGuid().ToString('N') + '.zip')
  New-TestArchive $path $Names $Attributes
  $zip = [IO.Compression.ZipFile]::OpenRead($path)
  try { Assert-Rejected { Get-SceneZipEntries $zip } 'Unsafe archive was accepted.' } finally { $zip.Dispose() }
}
try {
  Assert-Test ((Assert-SceneLocalPath $testRoot -MustExist -Directory) -eq $testRoot) 'Local directory validation failed.'
  foreach ($path in @('https://example.com/a.pkg', '\\server\share\scene.pkg', 'scene.pkg', ($testRoot + '\a.pkg:stream'))) {
    Assert-Rejected { Assert-SceneLocalPath $path } 'Nonlocal/ambiguous path was accepted.'
  }
  Assert-ArchiveRejected @('WpeBaker/../outside.exe')
  Assert-ArchiveRejected @('outside.exe')
  Assert-ArchiveRejected @('WpeBaker/a.exe', 'WpeBaker/A.exe')
  Assert-ArchiveRejected @('WpeBaker/a.exe:stream')
  Assert-ArchiveRejected @('WpeBaker/CON.txt')
  Assert-ArchiveRejected @('WpeBaker/a./file')
  Assert-ArchiveRejected @('WpeBaker/link') (-1610612736) # Unix symlink 0xa000 << 16.
  Assert-ArchiveRejected @('WpeBaker/link') 1024 # Windows reparse attribute.

  $archive = Join-Path $testRoot 'fixture.zip'
  $required = @('WpeBaker/renderer/wpe-render.exe', 'WpeBaker/encoder/ffmpeg.exe', 'WpeBaker/encoder/ffprobe.exe', 'WpeBaker/THIRD-PARTY-NOTICES.md', 'WpeBaker/SOURCE.md', 'WpeBaker/licenses/LICENSE')
  New-TestArchive $archive $required
  Assert-Rejected { Assert-SceneArchive $archive } 'Unpinned tool archive was accepted.'
  # Only the test scope changes the pin; production exposes no override parameter.
  $script:SceneArchiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
  $script:SceneArchiveSize = (Get-Item -LiteralPath $archive).Length
  $destination = Join-Path $testRoot 'installed'
  $installed = Install-SceneTool $archive $destination
  Assert-Test (Test-Path -LiteralPath (Join-Path $installed 'licenses\LICENSE')) 'Dependency license was not retained.'
  Assert-Test ((Install-SceneTool $archive $destination) -eq $installed) 'Intact cache was not reusable.'
  $binary = Join-Path $installed 'renderer\wpe-render.exe'
  $original = [IO.File]::ReadAllBytes($binary)
  $tampered = $original.Clone(); $tampered[0] = $tampered[0] -bxor 1
  [IO.File]::WriteAllBytes($binary, $tampered)
  Assert-Rejected { Install-SceneTool $archive $destination } 'Same-size binary tampering was accepted.'
  [IO.File]::WriteAllBytes($binary, $original)
  $extra = Join-Path $installed 'renderer\unexpected.dll'
  [IO.File]::WriteAllText($extra, 'dll search hijack fixture')
  Assert-Rejected { Install-SceneTool $archive $destination } 'Unexpected cached DLL was accepted.'
  Remove-Item -LiteralPath $extra

  $source = Join-Path $testRoot 'scene.pkg'
  $good = [pscustomobject]@{ schema_version=1; status='complete'; width=1280; height=720; fps_num=24; fps_den=1; requested_frames=312; written_frames=312; pixel_format='rgba8'; renderer_error_count=0; source_script_error_count=0; source_script_errors=@(); error=''; source=$source }
  Assert-SceneRenderResult $good $source $script:SceneRawBytes
  $script:SceneTestCount++
  foreach ($property in @('written_frames', 'renderer_error_count', 'source_script_error_count', 'status', 'fps_num')) {
    $bad = $good | ConvertTo-Json | ConvertFrom-Json
    $bad.$property = 'invalid'
    Assert-Rejected { Assert-SceneRenderResult $bad $source $script:SceneRawBytes } ('Incomplete renderer report accepted: ' + $property)
  }
  Assert-Rejected { Assert-SceneRenderResult $good $source ($script:SceneRawBytes - 4) } 'Truncated RGBA capture accepted.'
  Assert-Rejected { Assert-SceneRenderResult $good ($source + '.different') $script:SceneRawBytes } 'Different source was accepted.'
  $probe = [pscustomobject]@{ streams=@([pscustomobject]@{codec_type='video'; codec_name='h264'; width=1280; height=720; pix_fmt='yuv420p'; avg_frame_rate='24/1'}); format=[pscustomobject]@{duration='12.000000'; format_name='mov,mp4,m4a,3gp,3g2,mj2'} }
  Assert-SceneProbe $probe
  $script:SceneTestCount++
  $probe.format.duration = '0'
  Assert-Rejected { Assert-SceneProbe $probe } 'Empty video accepted.'
  $probe.format.duration = '12.0'; $probe.streams[0].codec_name = 'hevc'
  Assert-Rejected { Assert-SceneProbe $probe } 'Unexpected codec accepted.'
  $probe.streams[0].codec_name = 'h264'; $probe.streams += $probe.streams[0]
  Assert-Rejected { Assert-SceneProbe $probe } 'Unexpected extra stream accepted.'

  $owned = Join-Path $testRoot ('scene-job-' + [Guid]::NewGuid().ToString('N'))
  $null = [IO.Directory]::CreateDirectory($owned)
  Remove-SceneOwnedDirectory $owned $testRoot
  Assert-Test (-not (Test-Path -LiteralPath $owned)) 'Owned temporary directory was not cleaned.'
  Assert-Rejected { Remove-SceneOwnedDirectory $installed $testRoot } 'Cleanup accepted a user/tool directory.'
  Assert-Test (Test-Path -LiteralPath $installed) 'Unsafe cleanup removed existing files.'
  Initialize-SceneProcessRunner
  Assert-Test ([DreamSkinSceneProcess]::Quote('a b\') -eq '"a b\\"') 'Trailing slash command quoting failed.'
  Assert-Test ([DreamSkinSceneProcess]::Quote('a"b') -eq '"a\"b"') 'Embedded quote command quoting failed.'
  # Real shell child only: tests the pipe/job implementation, no network/GPU/tool download.
  $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $answer = Invoke-SceneTool $powershell @('-NoProfile', '-Command', '[Console]::Out.Write("ok"); [Console]::Error.Write((''x'' * 100000))') $testRoot 10 '' 0
  Assert-Test ($answer -eq 'ok') 'Concurrent bounded output capture failed.'
  Assert-Rejected { Invoke-SceneTool $powershell @('-NoProfile', '-Command', 'Start-Sleep -Seconds 10') $testRoot 1 '' 0 } 'Child timeout was ignored.'
  Write-Output ('PASS scene video conversion ({0} assertions)' -f $script:SceneTestCount)
} finally {
  # Test-created unique directory only; independently check its containment.
  $resolved = [IO.Path]::GetFullPath($testRoot)
  if ([IO.Path]::GetDirectoryName($resolved) -eq [IO.Path]::GetTempPath().TrimEnd('\') -and [IO.Path]::GetFileName($resolved) -match '^dreamskin-scene-test-[a-f0-9]{32}$') {
    $null = Assert-SceneLocalPath $resolved -MustExist -Directory
    Assert-SceneTree $resolved
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
