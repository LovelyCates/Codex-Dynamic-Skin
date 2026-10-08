[CmdletBinding()]
param(
  [string]$ScenePath,
  [string]$AssetsPath,
  [string]$OutputDirectory,
  [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'),
  [string]$ToolArchive
)

# Offline conversion only: never change the active theme or operate Codex.
# The complete upstream package (including licenses/source notices) stays intact.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$script:SceneArchiveHash = 'debd1056ef03b039a99940b3ce8b9b29da5120b6a852c3b1f6da72f1beb81421'
$script:SceneArchiveSize = 95145611L
$script:SceneArchiveUrl = 'https://github.com/isshiki-works/wpe-baker/releases/download/v2.0.0/WpeBaker-2.0.0-win-x64.zip'
$script:SceneRawBytes = 1280L * 720 * 4 * 24 * 13

function Assert-SceneLocalPath {
  param([string]$Path, [switch]$MustExist, [switch]$Directory)
  if (-not $Path -or $Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Substring(2).Contains(':') -or $Path -match '[\x00-\x1f]') { throw 'Expected an absolute local drive path.' }
  $full = [IO.Path]::GetFullPath($Path)
  $part = $full
  while ($part) {
    if (Test-Path -LiteralPath $part) {
      $item = Get-Item -LiteralPath $part -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked paths are not supported.' }
    }
    $parent = [IO.Path]::GetDirectoryName($part.TrimEnd('\'))
    if ($parent -eq $part) { break }
    $part = $parent
  }
  if ($MustExist -and -not (Test-Path -LiteralPath $full)) { throw 'Required input is missing.' }
  if ((Test-Path -LiteralPath $full) -and ((Get-Item -LiteralPath $full).PSIsContainer -ne [bool]$Directory)) { throw 'Unexpected input type.' }
  return $full
}

function Assert-SceneTree {
  param([string]$Path)
  $pending = New-Object 'Collections.Generic.Queue[string]'
  $pending.Enqueue($Path)
  $count = 0
  while ($pending.Count) {
    foreach ($item in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
      $count++
      if ($count -gt 100000) { throw 'Input tree has too many entries.' }
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked paths are not supported.' }
      if ($item.PSIsContainer) { $pending.Enqueue($item.FullName) }
    }
  }
}

function Read-SceneJson {
  param([string]$Path)
  $null = Assert-SceneLocalPath $Path -MustExist
  if ((Get-Item -LiteralPath $Path).Length -gt 1048576) { throw 'Renderer metadata exceeds its limit.' }
  return ([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json)
}

function Get-SceneZipEntries {
  param($Zip)
  $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $total = 0L
  if ($Zip.Entries.Count -gt 10000) { throw 'Tool archive has too many entries.' }
  foreach ($entry in $Zip.Entries) {
    $name = $entry.FullName
    if (-not $name -or $name.Contains('\') -or $name -notmatch '^WpeBaker/' -or $name -match '[:\x00-\x1f]' -or $name.StartsWith('/')) { throw 'Unsafe tool archive path.' }
    $parts = $name.TrimEnd('/').Split('/')
    foreach ($part in $parts) {
      if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Unsafe tool archive path.' }
    }
    if (-not $seen.Add($name.TrimEnd('/'))) { throw 'Duplicate tool archive path.' }
    $unixType = (($entry.ExternalAttributes -shr 16) -band 61440)
    if (($unixType -ne 0 -and $unixType -ne 32768 -and $unixType -ne 16384) -or ($entry.ExternalAttributes -band 1024)) { throw 'Linked tool archive entry.' }
    $total += $entry.Length
    if ($entry.Length -gt 256MB -or $total -gt 1GB -or ($entry.Length -gt 1MB -and $entry.Length -gt [Math]::Max(1, $entry.CompressedLength) * 1000)) { throw 'Tool archive exceeds its expansion limit.' }
    $entry
  }
}

function Assert-SceneArchive {
  param([string]$Path)
  $null = Assert-SceneLocalPath $Path -MustExist
  if ((Get-Item -LiteralPath $Path).Length -ne $script:SceneArchiveSize -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $script:SceneArchiveHash) { throw 'WPE Baker archive integrity check failed.' }
}

function Receive-SceneArchive {
  param([string]$Destination)
  # Fixed HTTPS release only; automatic redirects are needed for GitHub assets.
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $request = [Net.HttpWebRequest]::Create($script:SceneArchiveUrl)
  $request.Timeout = 120000
  $request.ReadWriteTimeout = 30000
  $request.UserAgent = 'CodexDreamSkin-scene-converter'
  $response = $null; $inputStream = $null; $output = $null
  try {
    $response = $request.GetResponse()
    if ($response.ResponseUri.Scheme -ne 'https' -or $response.ResponseUri.Host -notin @('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')) { throw 'Unexpected tool download origin.' }
    if ($response.ContentLength -gt $script:SceneArchiveSize) { throw 'Tool download exceeds its limit.' }
    $inputStream = $response.GetResponseStream()
    $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $buffer = New-Object byte[] 65536
    $total = 0L; $watch = [Diagnostics.Stopwatch]::StartNew()
    while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $total += $read
      if ($total -gt $script:SceneArchiveSize -or $watch.Elapsed.TotalSeconds -gt 240) { throw 'Tool download exceeded its limit.' }
      $output.Write($buffer, 0, $read)
    }
  } finally {
    if ($output) { $output.Dispose() }
    if ($inputStream) { $inputStream.Dispose() }
    if ($response) { $response.Dispose() }
  }
}

function Install-SceneTool {
  param([string]$Archive, [string]$Destination)
  Assert-SceneArchive $Archive
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  $stage = $null
  try {
    $entries = @(Get-SceneZipEntries $zip)
    if (-not (Test-Path -LiteralPath $Destination)) {
      $stage = $Destination + '.stage-' + [Guid]::NewGuid().ToString('N')
      $null = Assert-SceneLocalPath $stage -Directory
      $null = [IO.Directory]::CreateDirectory($stage)
      foreach ($entry in $entries) {
        $target = Join-Path $stage $entry.FullName.Replace('/', '\')
        if ($entry.FullName.EndsWith('/')) { $null = [IO.Directory]::CreateDirectory($target); continue }
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
      }
      [IO.Directory]::Move($stage, $Destination)
      $stage = $null
    }
    $null = Assert-SceneLocalPath $Destination -Directory -MustExist
    Assert-SceneTree $Destination
    $expected = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $entries) {
      if ($entry.FullName.EndsWith('/')) { continue }
      $target = Join-Path $Destination $entry.FullName.Replace('/', '\')
      $null = $expected.Add([IO.Path]::GetFullPath($target))
      $null = Assert-SceneLocalPath $target -MustExist
      if ((Get-Item -LiteralPath $target).Length -ne $entry.Length) { throw 'Cached tool integrity check failed.' }
      $sha = [Security.Cryptography.SHA256]::Create(); $stream = $entry.Open()
      try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') } finally { $stream.Dispose(); $sha.Dispose() }
      if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $hash) { throw 'Cached tool integrity check failed.' }
    }
    foreach ($file in Get-ChildItem -LiteralPath $Destination -Recurse -File -Force) {
      if (-not $expected.Contains($file.FullName)) { throw 'Unexpected cached tool file.' }
    }
    foreach ($required in @('renderer\wpe-render.exe', 'encoder\ffmpeg.exe', 'encoder\ffprobe.exe', 'THIRD-PARTY-NOTICES.md', 'SOURCE.md')) {
      $null = Assert-SceneLocalPath (Join-Path $Destination ('WpeBaker\' + $required)) -MustExist
    }
    return (Join-Path $Destination 'WpeBaker')
  } finally {
    $zip.Dispose()
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-SceneOwnedDirectory $stage ([IO.Path]::GetDirectoryName($Destination)) }
  }
}

function Remove-SceneOwnedDirectory {
  param([string]$Path, [string]$Parent)
  $full = Assert-SceneLocalPath $Path -MustExist -Directory
  $parentFull = Assert-SceneLocalPath $Parent -MustExist -Directory
  if ([IO.Path]::GetDirectoryName($full) -ne $parentFull.TrimEnd('\') -or [IO.Path]::GetFileName($full) -notmatch '(?:^scene-job-|\.stage-)[a-f0-9]{32}$') { throw 'Refusing unsafe temporary-directory cleanup.' }
  Assert-SceneTree $full
  Remove-Item -LiteralPath $full -Recurse -Force
}

function Initialize-SceneProcessRunner {
  if ('DreamSkinSceneProcess' -as [type]) { return }
  # KILL_ON_JOB_CLOSE also applies when the caller cancels/kills this PowerShell.
  # Bounded readers drain both pipes concurrently without retaining source logs.
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
public static class DreamSkinSceneProcess {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcess, PerJob; public uint Flags; public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Counters IO; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Drain(StreamReader reader) { var result = new StringBuilder(); var buffer = new char[4096]; int n; while ((n=reader.Read(buffer,0,buffer.Length))>0) { if(result.Length<65536) result.Append(buffer,0,Math.Min(n,65536-result.Length)); } return result.ToString(); }
  public static string Quote(string text) { if(text.IndexOf('\0')>=0) throw new Exception("Invalid argument."); var b=new StringBuilder("\""); int slashes=0; foreach(char c in text) { if(c=='\\') { slashes++; continue; } if(c=='\"') { b.Append('\\',slashes*2+1); b.Append(c); } else { b.Append('\\',slashes); b.Append(c); } slashes=0; } b.Append('\\',slashes*2); return b.Append('"').ToString(); }
  public static string Run(string executable, string arguments, string directory, int seconds, string boundedFile, long maxBytes) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Exception("Cannot create conversion process group.");
    Process p=null;
    try {
      var info=new Extended(); info.Basic.Flags=0x2000; int size=Marshal.SizeOf(info); IntPtr ptr=Marshal.AllocHGlobal(size);
      try { Marshal.StructureToPtr(info,ptr,false); if(!SetInformationJobObject(job,9,ptr,(uint)size)) throw new Exception("Cannot configure conversion process group."); } finally { Marshal.FreeHGlobal(ptr); }
      var start=new ProcessStartInfo(executable,arguments); start.UseShellExecute=false; start.CreateNoWindow=true; start.WorkingDirectory=directory; start.RedirectStandardOutput=true; start.RedirectStandardError=true;
      p=Process.Start(start);
      if(!AssignProcessToJobObject(job,p.Handle)) { if(!p.HasExited) p.Kill(); throw new Exception("Cannot contain conversion process."); }
      var stdout=Task.Run(()=>Drain(p.StandardOutput)); var stderr=Task.Run(()=>Drain(p.StandardError)); var clock=Stopwatch.StartNew();
      while(!p.WaitForExit(100)) { if(clock.Elapsed.TotalSeconds>seconds) throw new Exception("Conversion step timed out."); if(boundedFile!=null && File.Exists(boundedFile) && new FileInfo(boundedFile).Length>maxBytes) throw new Exception("Conversion output exceeded its limit."); }
      if(p.ExitCode!=0) throw new Exception("Conversion tool failed (exit "+p.ExitCode+"). Check Vulkan support and scene compatibility.");
      CloseHandle(job); job=IntPtr.Zero;
      if(!Task.WaitAll(new Task[]{stdout,stderr},5000)) throw new Exception("Conversion output did not close.");
      if(boundedFile!=null && File.Exists(boundedFile) && new FileInfo(boundedFile).Length>maxBytes) throw new Exception("Conversion output exceeded its limit.");
      return stdout.Result;
    } finally { if(job!=IntPtr.Zero) CloseHandle(job); if(p!=null) p.Dispose(); }
  }
}
'@
}

function Invoke-SceneTool {
  param([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory, [int]$Seconds, [string]$BoundedFile, [long]$MaxBytes)
  Initialize-SceneProcessRunner
  $commandLine = (($Arguments | ForEach-Object { [DreamSkinSceneProcess]::Quote($_) }) -join ' ')
  return [DreamSkinSceneProcess]::Run($Executable, $commandLine, $WorkingDirectory, $Seconds, $BoundedFile, $MaxBytes)
}

function Assert-SceneRenderResult {
  param($Result, [string]$Source, [long]$RawLength)
  if ($Result.schema_version -ne 1 -or $Result.status -cne 'complete' -or $Result.width -ne 1280 -or $Result.height -ne 720 -or $Result.fps_num -ne 24 -or $Result.fps_den -ne 1 -or $Result.requested_frames -ne 312 -or $Result.written_frames -ne 312 -or $Result.pixel_format -cne 'rgba8' -or $Result.renderer_error_count -ne 0 -or $Result.source_script_error_count -ne 0 -or @($Result.source_script_errors).Count -ne 0 -or $Result.error -ne '' -or $RawLength -ne $script:SceneRawBytes) { throw 'Scene renderer did not produce a complete error-free capture.' }
  if ([IO.Path]::GetFullPath($Result.source.Replace('/', '\')) -ne $Source) { throw 'Scene renderer returned a different source.' }
}

function Assert-SceneProbe {
  param($Probe)
  $streams = @($Probe.streams)
  if ($streams.Count -ne 1 -or $streams[0].codec_type -ne 'video' -or $streams[0].codec_name -ne 'h264' -or $streams[0].width -ne 1280 -or $streams[0].height -ne 720 -or $streams[0].pix_fmt -ne 'yuv420p' -or $streams[0].avg_frame_rate -ne '24/1') { throw 'Converted video format check failed.' }
  $duration = 0.0
  if (-not [double]::TryParse([string]$Probe.format.duration, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$duration) -or $duration -lt 11.9 -or $duration -gt 12.1 -or $Probe.format.format_name -notmatch '(^|,)mp4(,|$)') { throw 'Converted video duration/container check failed.' }
}

function Convert-SceneVideo {
  param([string]$Scene, [string]$Assets, [string]$Output, [string]$State, [string]$Archive)
  $sceneFull = Assert-SceneLocalPath $Scene -MustExist
  if ([IO.Path]::GetExtension($sceneFull) -ine '.pkg' -or (Get-Item -LiteralPath $sceneFull).Length -le 8 -or (Get-Item -LiteralPath $sceneFull).Length -gt 2GB) { throw 'Select a non-empty Wallpaper Engine scene.pkg (up to 2 GiB).' }
  $headerStream = [IO.File]::OpenRead($sceneFull)
  try {
    $header = New-Object byte[] 12
    if ($headerStream.Read($header, 0, 12) -ne 12 -or [BitConverter]::ToUInt32($header, 0) -ne 8 -or [Text.Encoding]::ASCII.GetString($header, 4, 8) -notmatch '^PKGV[0-9]{4}$') { throw 'Invalid Wallpaper Engine package header.' }
  } finally { $headerStream.Dispose() }
  $assetsFull = Assert-SceneLocalPath $Assets -MustExist -Directory
  Assert-SceneTree ([IO.Path]::GetDirectoryName($sceneFull))
  Assert-SceneTree $assetsFull
  $outputFull = Assert-SceneLocalPath $Output -Directory
  $stateFull = Assert-SceneLocalPath $State -Directory
  $null = [IO.Directory]::CreateDirectory($outputFull)
  $cache = Join-Path $stateFull 'scene-tools'
  $null = Assert-SceneLocalPath $cache -Directory
  $null = [IO.Directory]::CreateDirectory($cache)
  $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($cache))
  if ($drive.AvailableFreeSpace -lt 2500000000L) { throw 'Conversion requires at least 2.5 GB of temporary free space.' }
  $lock = $null; $job = $null; $download = $null; $partial = $null
  try {
    $lockPath = Join-Path $cache 'conversion.lock'
    $null = Assert-SceneLocalPath $lockPath
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if (-not $Archive) {
      $Archive = Join-Path $cache 'WpeBaker-2.0.0-win-x64.zip'
      $null = Assert-SceneLocalPath $Archive
      if (-not (Test-Path -LiteralPath $Archive)) {
        $download = Join-Path $cache ('download-' + [Guid]::NewGuid().ToString('N') + '.zip')
        Receive-SceneArchive $download
        Assert-SceneArchive $download
        [IO.File]::Move($download, $Archive)
        $download = $null
      }
    }
    $script:SceneStage = 'tool-integrity'
    $tool = Install-SceneTool $Archive (Join-Path $cache 'wpe-baker-2.0.0')
    $job = Join-Path $cache ('scene-job-' + [Guid]::NewGuid().ToString('N'))
    $null = [IO.Directory]::CreateDirectory($job)
    $capture = Join-Path $job 'capture'
    $request = @{ schema_version = 1; source = $sceneFull; assets = $assetsFull; output_dir = $capture; width = 1280; height = 720; fps_num = 24; fps_den = 1; frames = 312; warmup_frames = 24; seed = 0; write_audio = $false; max_readback_bytes = 67108864 }
    $requestPath = Join-Path $job 'request.json'
    [IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
    $raw = Join-Path $capture 'frames.rgba'
    $script:SceneStage = 'render'
    $null = Invoke-SceneTool (Join-Path $tool 'renderer\wpe-render.exe') @('render', '--job', $requestPath) $job 540 $raw $script:SceneRawBytes
    $result = Read-SceneJson (Join-Path $capture 'result.json')
    $null = Assert-SceneLocalPath $raw -MustExist
    Assert-SceneRenderResult $result $sceneFull (Get-Item -LiteralPath $raw).Length
    $encoded = Join-Path $job 'video.mp4'
    $script:SceneStage = 'encode'
    # Play seconds 1..13, blending the final second into 0..1. The next loop
    # starts at second 1, preserving motion across the join (not a black fade).
    $filter = '[0:v]split=2[a][b];[a]trim=start=1:end=13,setpts=PTS-STARTPTS,format=yuv420p,settb=AVTB[body];[b]trim=start=0:end=1,setpts=PTS-STARTPTS,format=yuv420p,settb=AVTB[head];[body][head]xfade=transition=fade:duration=1:offset=11,format=yuv420p[v]'
    $null = Invoke-SceneTool (Join-Path $tool 'encoder\ffmpeg.exe') @('-hide_banner','-loglevel','error','-nostdin','-f','rawvideo','-pixel_format','rgba','-video_size','1280x720','-framerate','24','-i',$raw,'-filter_complex_threads','1','-filter_complex',$filter,'-map','[v]','-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-r','24','-t','12','-movflags','+faststart','-n',$encoded) $job 180 $encoded 128MB
    $probeText = Invoke-SceneTool (Join-Path $tool 'encoder\ffprobe.exe') @('-v','error','-show_streams','-show_format','-of','json',$encoded) $job 30 $encoded 128MB
    $script:SceneStage = 'video-validation'
    Assert-SceneProbe ($probeText | ConvertFrom-Json)
    if ((Get-Item -LiteralPath $encoded).Length -lt 1024) { throw 'Converted video is empty.' }
    $null = Assert-SceneLocalPath $outputFull -MustExist -Directory
    $id = [Guid]::NewGuid().ToString('N')
    $final = Join-Path $outputFull ('scene-' + $id + '.mp4')
    $partial = Join-Path $outputFull ('.scene-' + $id + '.partial')
    # Stage on the destination volume, then rename without replacing user files.
    $script:SceneStage = 'save'
    [IO.File]::Copy($encoded, $partial, $false)
    [IO.File]::Move($partial, $final)
    $partial = $null
    return @{ path = $final; width = 1280; height = 720; fps = 24; duration = 12; loopCrossfadeSeconds = 1; renderer = 'WPE Baker 2.0.0' }
  } finally {
    if ($job -and (Test-Path -LiteralPath $job)) { Remove-SceneOwnedDirectory $job $cache }
    foreach ($temp in @($download, $partial)) {
      if ($temp -and (Test-Path -LiteralPath $temp)) { $null = Assert-SceneLocalPath $temp -MustExist; Remove-Item -LiteralPath $temp -Force }
    }
    if ($lock) { $lock.Dispose() }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
  $script:SceneStage = 'input-or-download'
  try {
    $converted = Convert-SceneVideo $ScenePath $AssetsPath $OutputDirectory $StateRoot $ToolArchive
    [Console]::Out.WriteLine(($converted | ConvertTo-Json -Compress))
  } catch {
    # Do not echo tool logs, source paths, shaders, scripts or arbitrary exceptions.
    [Console]::Error.WriteLine(('Scene conversion failed at {0}. Check the selected scene/assets, Vulkan support, disk space, and the pinned WPE Baker cache. No theme was applied.' -f $script:SceneStage))
    exit 1
  }
}
