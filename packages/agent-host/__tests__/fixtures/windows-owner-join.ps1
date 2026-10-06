param([Parameter(Mandatory)][int]$OwnedPid, [Parameter(Mandatory)][long]$ExpectedStart)
$ErrorActionPreference = 'Stop'
$instance = $null
try {
  try {
    $instance = [Diagnostics.Process]::GetProcessById($OwnedPid)
  } catch [ArgumentException] {
    @{event='owner-already-gone';pid=$OwnedPid;start=[string]$ExpectedStart} | ConvertTo-Json -Compress
    exit 0
  }
  if ($instance.HasExited) {
    @{event='owner-already-gone';pid=$OwnedPid;start=[string]$ExpectedStart} | ConvertTo-Json -Compress
    exit 0
  }
  $actual = $instance.StartTime.ToUniversalTime().ToFileTimeUtc()
  if ($actual -ne $ExpectedStart) {
    @{event='owner-identity-gone';pid=$OwnedPid;start=[string]$ExpectedStart;reusedStart=[string]$actual} | ConvertTo-Json -Compress
    exit 0
  }
  # Hold the verified native process handle. No signal, kill, retry or new
  # deadline is introduced; the existing enclosing fixture owns cancellation.
  $instance.WaitForExit()
  @{event='owner-physically-joined';pid=$OwnedPid;start=[string]$ExpectedStart;exitCode=$instance.ExitCode} | ConvertTo-Json -Compress
} finally {
  if ($instance) { $instance.Dispose() }
}
