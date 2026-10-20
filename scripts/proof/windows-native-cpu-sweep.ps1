# PROOF BRANCH ONLY. Use on a disposable hosted runner, never a personal profile.
param([Parameter(Mandatory)][ValidateSet('Start', 'Stop')][string]$Mode)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (-not $env:GITHUB_ACTIONS -or -not $env:BRAINSTRIKE_NATIVE_CPU_DIR) {
  throw 'This proof requires a disposable Actions runner and an explicit artifact directory.'
}
$root = $env:BRAINSTRIKE_NATIVE_CPU_DIR
if ($Mode -eq 'Start') {
  New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
}
$instance = "Brainstrike-$([guid]::NewGuid().ToString('N'))"
$wpr = Join-Path $env:WINDIR 'System32\wpr.exe'
$etl = Join-Path $root 'cpu.etl'
$manifest = [ordered]@{
  sha = $env:GITHUB_SHA
  run = $env:GITHUB_RUN_ID
  attempt = $env:GITHUB_RUN_ATTEMPT
  imageVersion = $env:ImageVersion
  instance = $instance
  profile = 'CPU.verbose'
  mode = 'circular-memory'
  started = $false
  stopped = $false
  testOutcome = $null
  errors = @()
}
function Save-Manifest {
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'manifest.json')
}
function Invoke-Wpr([string]$label, [string[]]$arguments) {
  $output = & $wpr @arguments 2>&1
  $code = $LASTEXITCODE
  $output | Out-File -LiteralPath (Join-Path $root "$label.txt") -Encoding utf8
  if ($code -ne 0) {
    throw "WPR $label failed with exit $code; see its retained output."
  }
  return ($output | Out-String)
}
if ($Mode -eq 'Start') {
  Save-Manifest
  try {
    if (-not (Test-Path -LiteralPath $wpr -PathType Leaf)) {
      throw 'The built-in WPR executable is unavailable.'
    }
    $manifest.wprVersion = (Get-Item -LiteralPath $wpr).VersionInfo.FileVersion
    $manifest.wprSha256 = (Get-FileHash -LiteralPath $wpr -Algorithm SHA256).Hash
    $ram = [int64](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    $manifest.ramBytes = $ram
    $manifest.osBuild = [Environment]::OSVersion.Version.ToString()
    $details = Invoke-Wpr 'profile-details' @('-profiledetails', 'CPU.verbose')
    $collectors = @([regex]::Matches($details, 'Buffer Size \(KB\)\s*:\s*(\d+)\s+Number of Buffers\s*:\s*(\d+)'))
    if ($collectors.Count -eq 0 -or $details -notmatch 'CPU\.Verbose\.Memory' -or $details -notmatch 'SampledProfile') {
      throw 'The installed CPU profile did not expose the required memory-buffer and stack configuration.'
    }
    [int64]$allocated = 0
    foreach ($collector in $collectors) {
      $allocated += [int64]$collector.Groups[1].Value * 1024 * [int64]$collector.Groups[2].Value
    }
    $manifest.bufferBytes = $allocated
    $manifest.bufferCeilingBytes = [int64][Math]::Min(1GB, $ram * 0.1)
    if ($allocated -gt $manifest.bufferCeilingBytes) {
      throw 'The installed profile exceeds this experiment''s recorded buffer ceiling.'
    }
    $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($root).TrimEnd('\').TrimEnd(':'))
    $manifest.freeDiskBeforeBytes = [int64]$drive.Free
    if ($drive.Free -lt 4GB) {
      throw 'Less than 4 GiB is available for trace finalization.'
    }
    [void](Invoke-Wpr 'profile-export' @('-exportprofile', 'CPU.verbose', (Join-Path $root 'CPU.wprp')))
    [void](Invoke-Wpr 'sample-interval' @('-profint'))
    $temporary = Join-Path $root 'wpr-temp'
    New-Item -ItemType Directory -Path $temporary | Out-Null
    [void](Invoke-Wpr 'start' @('-start', 'CPU.verbose', '-recordtempto', $temporary, '-instancename', $instance))
    $manifest.started = $true
    $manifest.startedAt = [DateTime]::UtcNow.ToString('o')
    Save-Manifest
    [void](Invoke-Wpr 'status-before' @('-status', 'collectors', '-details', '-instancename', $instance))
  } catch {
    $manifest.errors += $_.Exception.Message
    Write-Host "::error::Native CPU preflight/capture failed: $($_.Exception.Message)"
  }
  Save-Manifest
  if ($manifest.errors.Count -gt 0) { exit 1 }
  exit 0
}

$manifest = Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json -AsHashtable
$instance = $manifest.instance
$manifest.testOutcome = $env:BRAINSTRIKE_PROOF_TEST_OUTCOME
if ($manifest.started -and -not $manifest.stopped) {
  try {
    [void](Invoke-Wpr 'status-after' @('-status', 'collectors', '-details', '-instancename', $instance))
  } catch {
    $manifest.errors += $_.Exception.Message
  }
  # Only this invocation's acknowledged instance is stopped. Never cancel.
  try {
    $manifest.stopStartedAt = [DateTime]::UtcNow.ToString('o')
    [void](Invoke-Wpr 'stop' @('-stop', $etl, 'Brainstrike full desktop sweep', '-skipPdbGen', '-compress', '-instancename', $instance))
    if (-not (Test-Path -LiteralPath $etl -PathType Leaf) -or (Get-Item -LiteralPath $etl).Length -eq 0) {
      throw 'WPR stop returned without a nonempty ETL.'
    }
    $manifest.stopped = $true
    $manifest.etlBytes = (Get-Item -LiteralPath $etl).Length
  } catch {
    $manifest.errors += $_.Exception.Message
    Write-Host "::error::Native CPU finalization failed: $($_.Exception.Message)"
  }
}
$manifest.finishedAt = [DateTime]::UtcNow.ToString('o')
Save-Manifest
if (-not $manifest.stopped -or $manifest.errors.Count -gt 0) { exit 1 }
