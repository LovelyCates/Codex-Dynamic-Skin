[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Root)

$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $Root 'scripts\start-dream-skin.ps1'))
$begin = $source.IndexOf('  $pendingAppearanceTransaction = Test-DreamSkinPendingAppearanceTransaction')
$end = $source.IndexOf('  $launchedWithCdp = $false', $begin)
if ($begin -lt 0 -or $end -le $begin) { throw 'Cannot isolate the production restart decision.' }
$decision = [scriptblock]::Create($source.Substring($begin, $end - $begin))

function Test-RestartDecision {
  param([bool]$HasState, [bool]$Authorized, [bool]$ExpectedStop)
  $previousState = if ($HasState) { [pscustomobject]@{ port = 9335 } } else { $null }
  $cdpIdentity = [pscustomobject]@{ BrowserId = 'fixture-browser' }
  $RestartExisting = $Authorized
  $PromptRestart = $false
  $BackupPath = 'mock-backup'
  $currentCodex = [pscustomobject]@{ Executable = 'mock-codex.exe' }
  $codexToStop = $currentCodex
  $currentProcesses = @([pscustomobject]@{ ProcessId = 123 })
  $calls = [Collections.Generic.List[string]]::new()
  function Test-DreamSkinPendingAppearanceTransaction { param($BackupPath); return $false }
  function Test-DreamSkinPathEqual { param($Left, $Right); return $true }
  function Stop-DreamSkinCodex {
    param($Codex, [switch]$AllowForce)
    if ($Codex -ne $currentCodex -or -not $AllowForce) { throw 'Unexpected process identity or stop mode.' }
    $calls.Add('stop')
  }
  . $decision
  if ($closedExistingCodex -ne $ExpectedStop -or ($calls.Count -eq 1) -ne $ExpectedStop -or
      $debugReady -eq $ExpectedStop) {
    throw "Incorrect restart decision: state=$HasState authorization=$Authorized closed=$closedExistingCodex stops=$($calls.Count) debugReady=$debugReady"
  }
}

Test-RestartDecision -HasState $false -Authorized $true -ExpectedStop $true
Test-RestartDecision -HasState $false -Authorized $false -ExpectedStop $false
Test-RestartDecision -HasState $true -Authorized $true -ExpectedStop $false
Test-RestartDecision -HasState $true -Authorized $false -ExpectedStop $false
Write-Output 'PASS: only explicit authorization rebuilds an orphaned CDP session; managed sessions remain reusable.'
